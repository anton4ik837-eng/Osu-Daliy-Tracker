import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const gatewaySource = await readFile(new URL("./ai-gateway.js", import.meta.url), "utf8");
const { handleAiChat, handleAiResearch } = await import("data:text/javascript;base64," + Buffer.from(gatewaySource).toString("base64"));

const originalFetch = globalThis.fetch;
const store = new Map();
const env = {
  GEMINI_API_KEY: "test-key",
  // A stale Cloudflare variable must not override the selected model.
  GEMINI_MODEL: "gemini-3.8-flash",
  AI_RESEARCH_TOKEN: "research-test-token",
  OAUTH_KV: {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  },
};

let geminiCalls = 0;
let lastSystemInstruction = "";
let geminiFailure = false;
let modelNotFound = false;
let geminiTimeout = false;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith("https://osu.ppy.sh/api/v2/me/osu")) {
    return new Response(JSON.stringify({ id: 12345 }), { status: 200 });
  }
  if (String(url).includes("generativelanguage.googleapis.com")) {
    geminiCalls++;
    if (modelNotFound && String(url).includes("/models/gemini-3.5-flash-lite:generateContent")) {
      return new Response(JSON.stringify({ error: { status: "NOT_FOUND", message: "Model unavailable" } }), { status: 404 });
    }
    if (geminiTimeout) { const error = new Error("simulated timeout"); error.name = "TimeoutError"; throw error; }
    if (geminiFailure) {
      return new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Test failure" } }), { status: 400 });
    }
    const body = JSON.parse(options.body);
    assert.equal(body.systemInstruction.parts.length, 1);
    lastSystemInstruction = body.systemInstruction.parts[0].text;
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, "MINIMAL");
    assert.equal(body.generationConfig.temperature, undefined);
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
      style: "beginner",
      context: { bpm: 180, ur: 95 },
    }),
  }), env);
  assert.equal(chat.status, 200);
  const chatData = await chat.json();
  assert.equal(chatData.reply, "Тестовый ответ");
  assert.equal(chatData.provider, "gemini");
  assert.equal(chatData.model, "gemini-3.5-flash-lite");
  assert.equal(chatData.rate_limit_remaining, 19);
  assert.match(lastSystemInstruction, /НОВИЧОК/);
  assert.match(lastSystemInstruction, /понятное объяснение или синоним/);
  assert.equal(geminiCalls, 1);

  const advancedChat = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST", headers: { authorization: "Bearer osu-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Разбери стримы" }], style: "advanced" }),
  }), env);
  assert.equal(advancedChat.status, 200);
  assert.match(lastSystemInstruction, /ОПЫТНЫЙ ИГРОК/);
  assert.match(lastSystemInstruction, /Не расшифровывай общеизвестные игровые термины/);
  assert.equal(geminiCalls, 2);

  const invalidStyle = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST", headers: { authorization: "Bearer osu-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Тест" }], style: "unknown" }),
  }), env);
  assert.equal(invalidStyle.status, 400);
  assert.equal((await invalidStyle.json()).error, "invalid_chat_style");
  assert.equal(geminiCalls, 2);

  modelNotFound = true;
  const unavailableModel = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer osu-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Проверка выбранной модели" }] }),
  }), env);
  assert.equal(unavailableModel.status, 503);
  assert.equal((await unavailableModel.json()).provider_status, 404);
  modelNotFound = false;
  assert.equal(geminiCalls, 3);

  geminiFailure = true;
  const providerFailure = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer osu-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Проверка ошибки" }] }),
  }), env);
  assert.equal(providerFailure.status, 503);
  const providerFailureData = await providerFailure.json();
  assert.equal(providerFailureData.error, "ai_provider_request_failed");
  assert.equal(providerFailureData.provider_status, 400);
  assert.equal(providerFailureData.provider_reason, "INVALID_ARGUMENT");
  geminiFailure = false;
  assert.equal(geminiCalls, 4);

  geminiTimeout = true;
  const timeoutResponse = await handleAiChat(new Request("https://worker.test/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer osu-token", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Проверка тайм-аута" }] }),
  }), env);
  assert.equal(timeoutResponse.status, 504);
  const timeoutData = await timeoutResponse.json();
  assert.equal(timeoutData.error, "ai_provider_timeout");
  assert.equal(timeoutData.provider_reason, "TIMEOUT");
  geminiTimeout = false;
  assert.equal(geminiCalls, 5);

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
  assert.equal(geminiCalls, 6);

  console.log("AI Gateway tests passed: OAuth auth, payload validation, Gemini proxy, rate limits, research isolation.");
} finally {
  globalThis.fetch = originalFetch;
}
