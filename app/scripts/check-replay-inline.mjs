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


const maniaArchitecture = [
  'const ManiaSkinParser=',
  'const ManiaSkinResolver=',
  'const ManiaPlayfieldLayout=',
  'const ManiaStageRenderer=',
  'const ManiaNoteRenderer=',
];
for (const moduleName of maniaArchitecture) {
  if (!html.includes(moduleName)) {
    throw new Error('Missing modular osu!mania renderer component: ' + moduleName);
  }
}
if (!html.includes('ManiaSkinParser.parse(new TextDecoder')) {
  throw new Error('Mania renderer must use the typed skin.ini parser');
}
if (!html.includes('cfg.columnwidth') || !html.includes('cfg.columnspacing') || !html.includes('cfg.hitposition')) {
  throw new Error('Mania playfield layout must use per-skin column widths, spacing and hit position');
}
if (html.includes('1.44225*refScale')) {
  throw new Error('Legacy hard-coded StageHint scaling must not return');
}
if (!html.includes("cfg['colour'+i]")) {
  throw new Error('Mania stage renderer must use per-column skin colours');
}
if (!html.includes("ManiaNoteRenderer.draw(ctx,visible,layout,playerNow,scrollScale)")) {
  throw new Error('Mania notes must be rendered through the dedicated note renderer');
}

if (!html.includes("judgement==='MAX'?'300g'")) {
  throw new Error('osu!mania MAX judgement must resolve to mania-hit300g');
}
if (!html.includes("judgement==='300'?'300'")) {
  throw new Error('osu!mania 300 judgement must resolve to mania-hit300');
}
if (!html.includes("cfg['hit'+tier]")) {
  throw new Error('Mania judgement texture paths from skin.ini must be respected');
}
if (!html.includes('function maniaJudgement(offset,od=5)')) {
  throw new Error('Mania judgements must use beatmap OD hit windows');
}
if (!html.includes("judgement:maniaJudgement(delta,map.od)")) {
  throw new Error('Matched Mania replay events must store their calculated judgement');
}
if (!html.includes("label.textContent=current.kind+'  '+current.judgement")) {
  throw new Error('Replay HUD must show judgement instead of milliseconds');
}
if (html.includes("ctx.fillText(r.judgement||'MISS',col.center,layout.scoreY-15)")) {
  throw new Error('Judgement labels must not be duplicated above individual lanes');
}
if (html.includes('function maniaJudgementLabel(')) {
  throw new Error('Mania judgement feedback must use skin artwork, not named text labels');
}
if (!html.includes("effect=ManiaSkinResolver.hit(tier)") || !html.includes("else if(effect?.complete&&effect.naturalWidth&&effect.naturalHeight)")) {
  throw new Error('Custom Mania skins must render their own judgement artwork in the shared score area');
}
if (!html.includes("labels={MAX:'Marvelous','300':'Perfect','200':'Great','100':'Good','50':'Bad',MISS:'Miss'}")) {
  throw new Error('Built-in Mania skin must show named judgement labels');
}
if (!html.includes("activeSkin.name==='Встроенный вид'")) {
  throw new Error('Named judgement labels must be limited to the built-in skin');
}
if (html.includes('ctx.arc(col.center,layout.scoreY')) {
  throw new Error('Missing judgement textures must not be replaced with synthetic circles');
}
if (!html.includes('maniaMode?640:384') || !html.includes('const scale=Math.min(width/stageBaseWidth,height/480)') || !html.includes('value*scale') || !html.includes('aspect-ratio:4/5')) {
  throw new Error('Mania playfield must use a tall phone-friendly viewport and preserve the original osu!mania aspect ratio with uniform scaling');
}
if (!html.includes('legacy .osr Mania replays, x stores the Mania key bitfield')) {
  throw new Error('Mania replay input must decode the key bitfield from the x field');
}
if (!html.includes('The latest hit replaces the previous one; use the judgement sprite supplied by the active skin.')) {
  throw new Error('Mania judgement artwork must be shared and replaced by the latest hit');
}



const maniaModTestStart = html.indexOf('function resolveManiaKeyCount(');
const maniaModTestEnd = html.indexOf('function parseMap(text)', maniaModTestStart);
if (maniaModTestStart < 0 || maniaModTestEnd <= maniaModTestStart) {
  throw new Error('Mania key-mod resolver and column remapper must be present');
}
const maniaModContext = vm.createContext({});
vm.runInContext(html.slice(maniaModTestStart, maniaModTestEnd), maniaModContext);
const expectedKeyModBits = [[1,26],[2,28],[3,27],[4,15],[5,16],[6,17],[7,18],[8,19],[9,24]];
for (const [keys,bit] of expectedKeyModBits) {
  const resolved = maniaModContext.resolveManiaKeyCount(2 ** bit, [], 7);
  if (resolved.keys !== keys || resolved.source !== 'mod') {
    throw new Error('Mania '+keys+'K modifier bit '+bit+' must resolve to '+keys+'K');
  }
}
if (maniaModContext.resolveManiaKeyCount(0, [{x:512}], 7).keys !== 10) {
  throw new Error('A recorded tenth-lane press must identify a 10K replay');
}
if (maniaModContext.resolveManiaKeyCount(0, [], 7).keys !== 7) {
  throw new Error('Mania replays without key mods must preserve the source map key count');
}
const remapped = maniaModContext.applyManiaKeyCount({
  keys:7,
  objects:[{x:36,column:0},{x:475,column:6}]
},4);
if (remapped.keys !== 4 || remapped.originalKeys !== 7 ||
    remapped.objects[0].column !== 0 || remapped.objects[1].column !== 3) {
  throw new Error('Mania note columns must be remapped from source X positions to the modded key count');
}

const layoutStart = html.indexOf('const ManiaPlayfieldLayout={');
const layoutEnd = html.indexOf('\n};', layoutStart) + 3;
if (layoutStart < 0 || layoutEnd <= layoutStart) {
  throw new Error('Mania playfield layout implementation must be available for execution tests');
}
const layoutContext = vm.createContext({});
vm.runInContext(html.slice(layoutStart, layoutEnd), layoutContext);
const configuredLayout = layoutContext.ManiaPlayfieldLayout.create(512, 640, 4, {
  columnwidth: [30], columnspacing: [4], columnstart: 120,
  hitposition: 402, scoreposition: 330, lightposition: 413
});
if (configuredLayout.columns.length !== 4 ||
    configuredLayout.columns.some(column => !Number.isFinite(column.x) || !Number.isFinite(column.width)) ||
    configuredLayout.columns[0].x <= configuredLayout.stageLeft) {
  throw new Error('Mania renderer must calculate configured columnstart using the shared scale');
}

for (let index = 0; index < scripts.length; index += 1) {
  new vm.Script(scripts[index], { filename: 'replay.html:inline-script-' + (index + 1) });
}

console.log('Replay Lab inline JavaScript syntax OK (' + scripts.length + ' script block(s)).');
