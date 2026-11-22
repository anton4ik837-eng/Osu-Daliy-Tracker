// Single source of truth for the release version: app/package.json.
// Run `npm run version:sync` after changing it to update every derived file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const rootDir = resolve(appDir, "..");
const version = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf8")).version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid version in app/package.json: ${version}`);
}

function update(fileName, replacements) {
  const path = resolve(rootDir, fileName);
  let text = readFileSync(path, "utf8");
  const original = text;
  for (const [pattern, next] of replacements) {
    if (!pattern.test(text)) throw new Error(`Pattern not found in ${fileName}: ${pattern}`);
    text = text.replace(pattern, next);
  }
  if (text !== original) writeFileSync(path, text, "utf8");
  return text !== original;
}

const changed = [];
if (update("desktop/package.json", [[/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`]])) changed.push("desktop/package.json");
if (update("app/www/index.html", [
  [/(<title>osu! Daily Tracker )[^<]+(<\/title>)/, `$1${version}$2`],
  [/(osu! Daily Tracker · )[^<]+(<\/div>)/, `$1${version}$2`],
  [/(const APP_VERSION=')[^']+(')/, `$1${version}$2`],
])) changed.push("app/www/index.html");
if (update("app/www/replay.html", [[/(Replay Lab · )\d+\.\d+\.\d+/g, `$1${version}`]])) changed.push("app/www/replay.html");
if (update("desktop/main.js", [[/(title: 'osu! Daily Tracker )[^']+( · Replay Lab')/, `$1${version}$2`]])) changed.push("desktop/main.js");

const changelogPath = resolve(appDir, "CHANGELOG.md");
let changelog = readFileSync(changelogPath, "utf8");
if (!changelog.startsWith(`# ${version}\n`)) {
  changelog = `# ${version}\n\n- Изменения этой версии.\n\n${changelog}`;
  writeFileSync(changelogPath, changelog, "utf8");
  changed.push("app/CHANGELOG.md");
}

console.log(`Version: ${version}`);
console.log(changed.length ? `Updated: ${changed.join(", ")}` : "All files already in sync.");
