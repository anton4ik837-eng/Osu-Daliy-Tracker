import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const gatewaySource = await readFile(new URL("./ai-gateway.js", import.meta.url), "utf8");
const { handleAiChat, handleAiResearch } = await import("data:text/javascript;base64," + Buffer.from(gatewaySource).toString("base64"));

const originalFetch = globalThis.fetch;
const store = new Map();
const env = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "gemini-2.5-flash",
  AI_RESEARCH_TOKEN: "research-test-token",
  OAUTH_KV: {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  },
};

let geminiCalls = 0;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith("https://osu.ppy.sh/api/v2/me/osu")) {
    return new Response(JSON.stringify({ id: 12345 }), { status: 200 });
  }
  if (String(url).includes("generativelanguage.googleapis.com")) {
    geminiCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.systemInstruction.parts.length, 1);
    assert.ok(body.contents.length > 0);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Тестовый ответ" }] } }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
    }), { status: 200 });
  }
  throw new Error("Unexpected fetch: " + url);
};

try {
  const unauthorized = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Привет" }] }),
  }), env);
  assert.equal(unauthorized.status, 401);

  const invalid = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer osu-token" },
    body: JSON.stringify({ messages: [{ role: "system", content: "inject" }] }),
  }), env);
  assert.equal(invalid.status, 400);
  assert.equal(geminiCalls, 0);

  const chat = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer osu-token", "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Разбери результат" }],
      context: { bpm: 180, ur: 95 },
    }),
  }), env);
  assert.equal(chat.status, 200);
  const chatData = await chat.json();
  assert.equal(chatData.reply, "Тестовый ответ");
  assert.equal(chatData.provider, "gemini");
  assert.equal(chatData.model, "gemini-2.5-flash");
  assert.equal(chatData.rate_limit_remaining, 19);
  assert.equal(geminiCalls, 1);

  const researchDenied = await handleAiResearch(new Request("https://worker.test/api/ai/research", {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Отчёт" }] }),
  }), env);
  assert.equal(researchDenied.status, 401);

  const research = await handleAiResearch(new Request("https://worker.test/api/ai/research", {
    method: "POST",
    headers: { authorization: "Bearer research-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Оцени метрики" }],
      context: { dataset_count: 120 },
    }),
  }), env);
  assert.equal(research.status, 200);
  assert.equal((await research.json()).reply, "Тестовый ответ");
  assert.equal(geminiCalls, 2);

  console.log("AI Gateway tests passed: OAuth auth, payload validation, Gemini proxy, rate limits, research isolation.");
} finally {
  globalThis.fetch = originalFetch;
}
