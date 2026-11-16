'use strict';
/* MiROM Hub server: polls Xiaomi's servers, verifies every download link on every mirror, stores everything, serves the site + JSON API + live events.
   Zero dependencies. Run: node server/server.js   (env: PORT, DATA_DIR, API_POLL_MIN, FEED_POLL_MIN) */
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const { db, load, save, key, version } = require('./db');
const X = require('./xiaomi');

const PORT = +process.env.PORT || 8080;
const API_POLL_MS = (+process.env.API_POLL_MIN || 5) * 60000;
const FEED_POLL_MS = (+process.env.FEED_POLL_MIN || 10) * 60000;
const HISTORY_MS = 24 * 3600000;
const ROOT = path.join(__dirname, '..');
const MIRRORS = ['bigota.d.miui.com', 'hugeota.d.miui.com', 'cdnorg.d.miui.com', 'bn.d.miui.com', 'bkt-sgp-miui-ota-update-alisgp.oss-ap-southeast-1.aliyuncs.com'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- helpers ---------- */
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; try { await fn(x); } catch { } } })); }
const today = () => new Date().toISOString().slice(0, 10);
const FIELDS = ['codename', 'name', 'android', 'branch', 'method', 'date', 'link', 'md5', 'size', 'version', 'changelog'];

/* ---------- live events (SSE) ---------- */
const clients = new Set(); let pending = [];
function emit(ev, data) { const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(msg); }
setInterval(() => { for (const c of clients) c.write(': hb\n\n'); }, 25000);
setInterval(() => { if (pending.length) { emit('new', pending.slice(0, 50)); pending = []; } }, 2000);

/* ---------- storing ROMs ---------- */
function nameMap() {
  const m = new Map();
  for (const [c, d] of Object.entries(db.devices)) if (d?.name) m.set(d.name.toLowerCase(), c);
  return m;
}
function dedupeDb() {
  const names = nameMap(), byLink = new Map();
  let removed = 0, trimmed = 0;
  for (const [k, r] of Object.entries(db.roms)) {
    if (r.m && r.m.length > MIRRORS.length) { r.m = r.m.slice(0, MIRRORS.length); trimmed++; }
    const fixedCode = names.get((r.name || '').toLowerCase()) || r.codename;
    if (fixedCode !== r.codename) r.codename = fixedCode;
    const prev = byLink.get(r.link);
    if (!prev) { byLink.set(r.link, r); continue; }
    if (r.m && !prev.m) { prev.m = r.m; prev.mt = r.mt; }
    if (r.changelog && !prev.changelog) prev.changelog = r.changelog;
    if (r.codename.includes('_') && !prev.codename.includes('_')) prev.codename = r.codename;
    removed++;
  }
  if (removed || trimmed) {
    db.roms = {};
    for (const r of byLink.values()) db.roms[key(r)] = r;
    save();
    if (removed) log(`cleaned ${removed} duplicate entries (${Object.keys(db.roms).length} unique ROMs)`);
  }
}
const linkSet = () => new Set(Object.values(db.roms).map(r => r.link));

function upsert(e, src, links) {
  if (!e.codename || !e.version || !e.link) return null;
  const k = key(e), have = db.roms[k], dev = db.devices[e.codename];
  const rec = { ...Object.fromEntries(FIELDS.map(f => [f, e[f] || ''])), method: e.method || 'Recovery', branch: e.branch || 'Stable' };
  rec.name = rec.name || dev?.name || e.codename;
  if (!have) {
    if (links && links.has(rec.link)) return null;
    if (links) links.add(rec.link);
    db.roms[k] = { ...rec, src, seen: Date.now(), m: '', mt: 0 }; return db.roms[k];
  }
  if (have.src === 'api' && src === 'feed') { Object.assign(have, rec, { src: 'feed' }); }    // feed has the real release date
  else if (!have.changelog && rec.changelog) have.changelog = rec.changelog;
  return null;
}
function announce(list, label) {
  if (!list.length) return;
  save(); log(`+${list.length} new ROM(s) via ${label}:`, list.slice(0, 4).map(r => `${r.codename} ${r.version}`).join(', '));
  pending.push(...list.map(r => ({ name: r.name, codename: r.codename, version: r.version, method: r.method, branch: r.branch })));
}

/* ---------- pollers ---------- */
let firstFeed = true;
async function syncFeed() {
  try {
    const { roms, devices } = await X.fetchFeed();
    for (const [c, d] of devices) db.devices[c] = d;
    const added = roms.map(r => upsert(r, 'feed')).filter(Boolean);
    db.meta.lastFeed = Date.now();
    if (firstFeed) { firstFeed = false; save(); log(`feed loaded: ${roms.length} ROMs, ${Object.keys(db.devices).length} devices`); } else announce(added, 'feed');
  } catch (e) { log('feed error', e.message); }
}

async function pollApi() {
  const newest = {};
  for (const r of Object.values(db.roms)) { const n = newest[r.codename]; if (!n || r.date > n.date || (r.date === n.date && r.method === 'Recovery')) newest[r.codename] = r; }
  const jobs = Object.values(newest).flatMap(r => ['F', 'X'].map(branch => ({ codename: r.codename, version: r.version, android: r.android, branch })));
  const added = []; let ok = 0;
  await pool(jobs, 40, async j => { for (const e of await X.queryApi(j)) { const rec = upsert({ ...e, date: today() }, 'api'); if (rec) added.push(rec); } ok++; });
  db.meta.lastApi = Date.now(); db.meta.apiOk = ok; db.meta.apiJobs = jobs.length;
  announce(added, 'Xiaomi API'); log(`Xiaomi API polled: ${ok}/${jobs.length} ok, ${added.length} new`);
}

async function backfillHistory() {
  const bases = [...new Set(Object.keys(db.devices).map(c => c.split('_')[0]))], names = nameMap(), links = linkSet(); let added = 0;
  await pool(bases, 8, async b => {
    for (const e of await X.fetchRss(b)) {
      const real = names.get((e.name || '').toLowerCase());
      if (real) e.codename = real;
      if (upsert(e, 'feed', links)) added++;
    }
  });
  db.meta.lastHistory = Date.now(); save(); log(`history backfill: ${bases.length} devices, +${added} older ROMs`);
}

/* ---------- link checker ---------- */
const hostPath = l => { try { return new URL(l).pathname; } catch { return ''; } };
async function headOk(url) {
  try { const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000), redirect: 'follow' }); return r.status === 200 || r.status === 206; } catch { return false; }
}
let checking = false, queueLen = 0;
async function checkTick() {
  if (checking) return; checking = true;
  try {
    const now = Date.now();
    const due = Object.values(db.roms).filter(r => !r.m || (!r.m.includes('1') && now - r.mt > 30 * 60000) || now - r.mt > 12 * 3600000);
    queueLen = due.length; if (!due.length) return;
    due.sort((a, b) => (!a.m - !b.m) * -1 || b.date.localeCompare(a.date));
    const batch = due.slice(0, 120);
    await pool(batch, 12, async r => {
      const p = hostPath(r.link); if (!p) return;
      r.m = (await Promise.all(MIRRORS.map(async h => (await headOk(`https://${h}${p}`)) ? '1' : '0'))).join(''); r.mt = Date.now();
    });
    save(); log(`checked ${batch.length} ROMs, ${due.length - batch.length} still queued`);
  } finally { checking = false; }
}

/* ---------- HTTP ---------- */
let cache = { v: -1 };
function payload() {
  if (cache.v !== version()) {
    const roms = Object.values(db.roms).map(r => { const o = {}; for (const f of FIELDS) if (r[f]) o[f] = r[f]; if (r.m) o.m = r.m; if (r.src === 'api') o.live = 1; return o; });
    const json = Buffer.from(JSON.stringify({ hosts: MIRRORS, updated: Date.now(), count: roms.length, devices: Object.fromEntries(Object.entries(db.devices).map(([k, d]) => [k, d])), roms }));
    cache = { v: version(), json, gz: zlib.gzipSync(json, { level: 6 }), etag: `"${version()}-${roms.length}"` };
  }
  return cache;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const STATIC = new Set(['index.html', 'app.js', 'styles.css']);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (u.pathname === '/api/roms') {
    const c = payload(); res.setHeader('ETag', c.etag); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Content-Type', 'application/json');
    if (req.headers['if-none-match'] === c.etag) { res.statusCode = 304; return res.end(); }
    if (/gzip/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); return res.end(c.gz); }
    return res.end(c.json);
  }
  if (u.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: hello\ndata: {"updated":${Date.now()}}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (u.pathname === '/api/refresh' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    if (Date.now() - db.meta.lastApi > 30000) {
      Promise.all([syncFeed(), pollApi().catch(() => { })]).catch(() => { });
      return res.end(JSON.stringify({ started: true }));
    }
    return res.end(JSON.stringify({ started: false, cooldown: true }));
  }
  if (u.pathname === '/api/stats') {
    const r = Object.values(db.roms); res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ roms: r.length, devices: Object.keys(db.devices).length, fromXiaomiApi: r.filter(x => x.src === 'api').length, verified: r.filter(x => x.m).length, queue: queueLen, clients: clients.size, ...db.meta }));
  }
  const name = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  if (STATIC.has(name)) { res.setHeader('Content-Type', TYPES[path.extname(name)]); res.setHeader('Cache-Control', 'no-store'); return fs.createReadStream(path.join(ROOT, name)).pipe(res); }
  res.statusCode = 404; res.end('Not found');
}).listen(PORT, () => log(`MiROM Hub server on http://localhost:${PORT}`));

/* ---------- boot ---------- */
load();
dedupeDb();
(async () => {
  log(`loaded ${Object.keys(db.roms).length} ROMs from disk`);
  await syncFeed();
  pollApi().catch(e => log('api error', e.message));
  if (Date.now() - db.meta.lastHistory > HISTORY_MS) backfillHistory().catch(e => log('history error', e.message));
  setInterval(syncFeed, FEED_POLL_MS);
  setInterval(() => pollApi().catch(e => log('api error', e.message)), API_POLL_MS);
  setInterval(() => backfillHistory().catch(() => { }), HISTORY_MS);
  setInterval(() => checkTick().catch(e => log('check error', e.message)), 15000);
  checkTick();
})();
process.on('SIGINT', () => { try { fs.writeFileSync(path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'db.json'), JSON.stringify(db)); } catch { } process.exit(0); });
