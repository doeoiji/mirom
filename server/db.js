'use strict';
/* Tiny JSON-file database with atomic writes. */
const fs = require('fs'), path = require('path');
const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data'), FILE = path.join(DIR, 'db.json');

const db = { roms: {}, devices: {}, meta: { created: Date.now(), lastApi: 0, lastFeed: 0, lastHistory: 0 } };
let version = 0, timer = null;

function load() {
  fs.mkdirSync(DIR, { recursive: true });
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); db.roms = j.roms || {}; db.devices = j.devices || {}; Object.assign(db.meta, j.meta); } catch { }
  version++;
}
function save() {
  version++; if (timer) return;
  timer = setTimeout(() => { timer = null; const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); }, 2000);
}
const key = r => `${r.codename}|${r.version}|${r.method}`;
module.exports = { db, load, save, key, version: () => version };
