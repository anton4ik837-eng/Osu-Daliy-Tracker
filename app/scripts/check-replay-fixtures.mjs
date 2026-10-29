import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

function unzip(buffer) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory entry');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error('Unsupported ZIP compression method ' + method + ' for ' + name);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readOsuString(buffer, state) {
  const marker = buffer[state.offset++];
  if (marker === 0) return '';
  if (marker !== 0x0b) throw new Error('Invalid .osr string marker at byte ' + (state.offset - 1));
  let length = 0, shift = 0, byte;
  do {
    if (state.offset >= buffer.length) throw new Error('Truncated .osr string length');
    byte = buffer[state.offset++];
    length |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  const value = buffer.toString('utf8', state.offset, state.offset + length);
  state.offset += length;
  return value;
}

const replayPath = 'test-fixtures/replays/solo-replay-mania_429549_7779890059.osr';
const mapPath = 'test-fixtures/replays/176446 High Speed Music Team Sharpnel - M.A.M.A..osz';
const replay = readFileSync(new URL('../../' + replayPath, import.meta.url));
const mapArchive = unzip(readFileSync(new URL('../../' + mapPath, import.meta.url)));
const state = { offset: 1 };
const mode = replay.readUInt8(0);
const version = replay.readInt32LE(state.offset); state.offset += 4;
const beatmapMd5 = readOsuString(replay, state);
const playerName = readOsuString(replay, state);
if (mode !== 3) throw new Error('Fixture replay is not osu!mania (mode=' + mode + ')');
if (!beatmapMd5 || !playerName || version < 20100101) throw new Error('Replay header is incomplete or invalid');
const matchingMaps = [];
for (const [name, bytes] of mapArchive) {
  if (!name.toLowerCase().endsWith('.osu')) continue;
  const md5 = createHash('md5').update(bytes).digest('hex');
  if (md5 === beatmapMd5) matchingMaps.push({ name, bytes });
}
if (matchingMaps.length !== 1) {
  throw new Error('Replay/map mismatch: replay MD5 ' + beatmapMd5 + ' matched ' + matchingMaps.length + ' .osu files in supplied OSZ');
}
const mapText = matchingMaps[0].bytes.toString('utf8');
const modeMatch = mapText.match(/^Mode:\s*(\d+)/m);
const keysMatch = mapText.match(/^CircleSize:\s*([\d.]+)/m);
if (Number(modeMatch?.[1]) !== 3) throw new Error('Matched beatmap is not osu!mania');
console.log('Replay fixture OK: mode=mania, player=' + playerName + ', version=' + version);
console.log('Exact beatmap match OK: ' + matchingMaps[0].name + ', keys=' + (keysMatch?.[1] || 'unknown') + ', MD5=' + beatmapMd5);

const skinPath = 'test-fixtures/skins/百鬼あやめ.osk.zip';
const outerSkin = unzip(readFileSync(new URL('../../' + skinPath, import.meta.url)));
const nestedSkin = [...outerSkin].filter(([name]) => name.toLowerCase().endsWith('.osk'));
if (!nestedSkin.length) console.log('Skin archive layout: direct ZIP payload (no nested .osk file); entries=' + [...outerSkin.keys()].slice(0, 200).join(' | '));
let maniaTextures = [...outerSkin.keys()].filter(name => /(^|\/)mania-(note|key)\d+.*\.(png|jpe?g|webp)$/i.test(name));
let skinIni = [...outerSkin.keys()].some(name => name.split('/').pop().toLowerCase() === 'skin.ini');
for (const [archiveName, archiveBytes] of nestedSkin) {
  const inner = unzip(archiveBytes);
  const images = [...inner.keys()].filter(name => /\.(png|jpe?g|webp)$/i.test(name));
  const mania = images.filter(name => /(^|\/)mania-(note|key)\d+/i.test(name));
  if (mania.length) {
    maniaTextures = mania;
    skinIni = [...inner.keys()].some(name => name.split('/').pop().toLowerCase() === 'skin.ini');
    console.log('Nested .osk opened: ' + archiveName + ', image files=' + images.length);
    break;
  }
}
if (!maniaTextures.length) { console.log('Skin ZIP image candidates=' + [...outerSkin.keys()].filter(name => /\\.(png|jpe?g|webp)$/i.test(name)).slice(0, 200).join(' | ')); throw new Error('Skin ZIP (direct or nested .osk) has no mania-note/mania-key textures'); }
console.log('Mania skin fixture OK: ' + maniaTextures.length + ' mania textures; skin.ini=' + skinIni);
