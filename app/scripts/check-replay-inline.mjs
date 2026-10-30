import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../www/replay.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(script => script.trim());

if (!scripts.length) {
  throw new Error('Replay Lab has no inline JavaScript to validate');
}

const loaderStart = html.indexOf('async function loadOsuSkin');
const loaderEnd = html.indexOf("$('skinFile')", loaderStart);
const skinLoader = loaderStart >= 0 && loaderEnd > loaderStart ? html.slice(loaderStart, loaderEnd) : '';
const listenerPosition = skinLoader.indexOf('img.onload=()=>finish(true)');
const sourcePosition = skinLoader.indexOf('img.src=url');
if (!skinLoader || listenerPosition < 0 || sourcePosition < 0 || listenerPosition > sourcePosition) {
  throw new Error('Skin image loader must register load/error handlers before assigning img.src');
}
if (!skinLoader.includes('await Promise.all(pending)')) {
  throw new Error('Skin image loader must decode texture images concurrently');
}
if (!skinLoader.includes('В архиве не найдены файлы mania-*')) {
  throw new Error('Skin loader must explain when an archive has no osu!mania textures');
}
if (!skinLoader.includes('const inspectArchive=(archive,depth=0)=>{')) {
  throw new Error('Skin loader must recursively inspect nested skin archives');
}
if (!skinLoader.includes("if(!/\\.(osk|zip)$/i.test(path)||!bytes?.length)continue;")) {
  throw new Error('Skin loader must inspect nested .osk and .zip archives inside wrapper ZIP files');
}
if (!skinLoader.includes('const selected=inspectArchive(outer);') || !skinLoader.includes('entries=selected.entries;')) {
  throw new Error('Skin loader must select the best matching nested skin archive before choosing textures');
}
if (!skinLoader.includes("diagLog('skin.nested_archive_opened'")) {
  throw new Error('Skin loader must record when a nested skin archive is opened');
}

for (let index = 0; index < scripts.length; index += 1) {
  new vm.Script(scripts[index], { filename: 'replay.html:inline-script-' + (index + 1) });
}

console.log('Replay Lab inline JavaScript syntax OK (' + scripts.length + ' script block(s)).');
