// Merge another copy of data/bpm-jp.json (e.g. what is on GitHub now) into the local one,
// keeping every song from both, so a run that started from older data never drops songs.
import fs from 'node:fs';
const [, , otherPath] = process.argv;
const local = JSON.parse(fs.readFileSync('data/bpm-jp.json', 'utf8'));
let other;
try { other = JSON.parse(fs.readFileSync(otherPath, 'utf8')); } catch { console.log('no remote copy'); process.exit(0); }
const toRows = (d) => (d.v === 2 ? d.rows : (d.songs || []).map((s) => [s.id, s.title, s.artist, s.titleEn || '', s.artistEn || '', s.bpm, 2, 0, s.added || '']));
const rows = new Map(toRows(other).map((r) => [r[0], r]));
let added = 0;
for (const r of toRows(local)) { if (!rows.has(r[0])) added++; rows.set(r[0], r); }
local.v = 2; local.rows = [...rows.values()]; local.count = local.rows.length;
fs.writeFileSync('data/bpm-jp.json', JSON.stringify(local) + '\n');
console.log(`merged: ${local.count} songs (${added} only in this run)`);
