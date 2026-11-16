'use strict';
/* MiROM Hub – client-side UI powered exclusively by our own Node.js server (/api/roms, /api/events, /api/stats, /api/refresh). */

const POLL_MS = 60 * 1000;
const PING_EVERY_MS = 5 * 60 * 1000;
const PAGE = 30;

function resolveApiBase() {
  const qp = new URLSearchParams(location.search).get('api');
  if (qp !== null) {
    const cleanUrl = qp.trim().replace(/\/+$/, '');
    if (!cleanUrl || cleanUrl === 'local' || cleanUrl === 'clear') localStorage.removeItem('mirom.api');
    else localStorage.setItem('mirom.api', cleanUrl);
  }
  const meta = document.querySelector('meta[name="mirom-api"]')?.content.trim().replace(/\/+$/, '');
  if (meta) return meta;
  if (location.protocol === 'file:') return localStorage.getItem('mirom.api') || 'http://localhost:8080';
  if (!/^(localhost|127\.0\.0\.1)$/i.test(location.hostname)) {
    const saved = localStorage.getItem('mirom.api');
    if (saved) return saved;
  }
  return '';
}
const API_BASE = resolveApiBase();

/* Official Xiaomi download mirrors. Files share the same path on every mirror. */
const MIRRORS = [
  { host: 'bigota.d.miui.com',  name: 'Bigota CDN',        note: 'Primary official server' },
  { host: 'hugeota.d.miui.com', name: 'Hugeota CDN',       note: 'Official, large-file CDN' },
  { host: 'cdnorg.d.miui.com',  name: 'CDN Org',           note: 'Official, global CDN' },
  { host: 'bn.d.miui.com',      name: 'BN CDN',            note: 'Official, Xiaomi CDN' },
  { host: 'bkt-sgp-miui-ota-update-alisgp.oss-ap-southeast-1.aliyuncs.com', name: 'Singapore (Alibaba OSS)', note: 'Official, Southeast Asia' },
];

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- state ---------- */
const S = {
  roms: new Map(),        // codename|version|method -> rom
  devices: new Map(),     // codename -> {name, model}
  seen: new Set(),        // hashes seen in previous visits
  fresh: new Set(),       // ids new since last visit / detected live
  device: null,           // selected codename
  shown: PAGE,
  ping: new Map(),        // host -> {ms|null, state}
  loaded: false,
  quick: new Set(),
  status: null,           // {t, hosts, s}
  esConnected: false,
};

/* ---------- helpers ---------- */
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function ago(ts) { const d = (Date.now() - ts) / 1000; if (d < 90) return 'just now'; if (d < 3600) return Math.round(d / 60) + ' min ago'; if (d < 86400) return Math.round(d / 3600) + ' h ago'; return Math.round(d / 86400) + ' d ago'; }
function toast(html, ms = 7000) { const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = html; $('#toasts').append(t); setTimeout(() => t.remove(), ms); return t; }
function normAndroid(a) { const n = parseFloat(a); if (isNaN(n)) return ''; return Number.isInteger(n) ? String(n) : String(n); }
function clean(v) { v = String(v ?? '').trim().replace(/^['"]|['"]$/g, ''); return (v === 'null' || v === 'None') ? '' : v; }

function osInfo(version) {
  const m = /^OS(\d+)/.exec(version); if (m) return { os: 'HyperOS', label: 'HyperOS ' + m[1] };
  const v = /^V(\d+)/.exec(version); if (v) return { os: 'MIUI', label: 'MIUI ' + v[1] };
  return { os: 'MIUI', label: 'MIUI' };
}

function makeRom(o) {
  const version = clean(o.version), link = clean(o.link); if (!link) return null;
  const codename = clean(o.codename), method = clean(o.method) || 'Recovery';
  const oi = osInfo(version), date = clean(o.date), ts = Date.parse(date) || 0;
  const dev = S.devices.get(codename) || {};
  return {
    id: `${codename}|${version}|${method}`,
    link, version, codename, base: codename.split('_')[0],
    name: clean(o.name) || dev.name || codename, model: dev.model || '',
    android: normAndroid(o.android), branch: clean(o.branch) || 'Stable', method,
    size: clean(o.size), md5: clean(o.md5), date, ts, os: oi.os, osLabel: oi.label,
    changelog: o.changelog || '', live: Boolean(o.live),
  };
}

/* ---------- server data & live updates ---------- */
async function fetchText(url, opts) { const r = await fetch(url, { cache: 'no-cache', ...opts }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }

function setLive(cls, text) { const l = $('#live'); l.className = 'live ' + cls; $('#liveText').textContent = text; }

function ingest(incoming, first) {
  const added = [];
  for (const r of incoming) {
    const ex = S.roms.get(r.id);
    if (!ex) { S.roms.set(r.id, r); added.push(r); }
    else { if (!ex.changelog && r.changelog) ex.changelog = r.changelog; if (r.live) ex.live = true; }
  }
  if (first) {
    for (const r of added) if (!S.seen.has(hash(r.id)) && S.seen.size) S.fresh.add(r.id);
  } else if (added.length) {
    added.forEach(r => S.fresh.add(r.id));
    const names = [...new Set(added.map(r => r.name))].slice(0, 3).join(', ');
    toast(`🆕 <b>${added.length}</b> new ROM${added.length > 1 ? 's' : ''}: ${esc(names)}${added.length > 3 ? '…' : ''}`);
    document.title = `(${added.length}) MiROM Hub`;
  }
  localStorage.setItem('mirom.seen', JSON.stringify([...S.roms.keys()].map(hash)));
  S.loaded = true; buildFilterOptions(); render();
  setLive('ok', 'Server Live · ' + S.roms.size.toLocaleString() + ' ROMs');
}

function connectEvents() {
  if (S.esConnected) return;
  S.esConnected = true;
  try {
    const es = new EventSource(API_BASE + '/api/events');
    es.addEventListener('new', () => { loadAll(false); checkSourceSync(); });
    es.onerror = () => setLive('err', 'Reconnecting…');
    es.onopen = () => { if (S.loaded) setLive('ok', 'Server Live · ' + S.roms.size.toLocaleString() + ' ROMs'); };
  } catch { }
}

async function loadAll(first) {
  try {
    const j = JSON.parse(await fetchText(API_BASE + '/api/roms'));
    if (!j || !Array.isArray(j.roms)) throw new Error('Invalid server response');
    connectEvents();
    S.devices = new Map(Object.entries(j.devices || {}));
    const s = {};
    for (const o of j.roms) if (o.m && o.link) { try { s[new URL(o.link).pathname.slice(1)] = o.m; } catch { } }
    S.status = { t: j.updated, hosts: j.hosts, s };
    ingest(j.roms.map(makeRom).filter(Boolean), first);
  } catch (e) {
    console.error(e);
    setLive('err', S.loaded ? 'Server offline – retrying' : 'Server unreachable');
    if (!S.loaded) {
      const hint = API_BASE
        ? `Couldn't reach your MiROM Hub server at <code>${esc(API_BASE)}</code>`
        : `Couldn't reach the MiROM Hub server on this origin`;
      $('#list').innerHTML = `<div class="empty">${hint} (${esc(e.message)}).<br>Make sure <code>node server/server.js</code> is running on your PC${location.hostname.endsWith('github.io') ? ' and pass your Cloudflare Tunnel URL via <code>?api=https://your-tunnel-url</code>' : ''}, then press ⟳.</div>`;
    }
  }
}

async function checkSourceSync() {
  try {
    const st = JSON.parse(await fetchText(API_BASE + '/api/stats'));
    const parts = [];
    if (st.lastApi) parts.push('Xiaomi API polled ' + ago(st.lastApi));
    if (st.roms) parts.push(`${st.verified.toLocaleString()}/${st.roms.toLocaleString()} links verified`);
    $('#pingSummary').dataset.sync = parts.join(' · ');
    updatePingSummary();
  } catch { }
}

/* ---------- filtering ---------- */
const F = () => ({
  q: $('#q').value.trim().toLowerCase(), os: $('#fOs').value, av: $('#fAv').value, branch: $('#fBranch').value,
  method: $('#fMethod').value, from: $('#fFrom').value, to: $('#fTo').value, sort: $('#fSort').value,
});

function matches(r, f, tokens) {
  if (S.device && r.codename !== S.device && !(r.base === S.device.split('_')[0] && r.codename === S.device)) return false;
  if (f.os && r.osLabel !== f.os && r.os !== f.os) return false;
  if (f.av && r.android !== f.av) return false;
  if (f.branch && r.branch !== f.branch) return false;
  if (f.method && r.method !== f.method) return false;
  if (f.from && (!r.date || r.date < f.from)) return false;
  if (f.to && (!r.date || r.date > f.to)) return false;
  if (!S.device && tokens.length) { const hay = (r.name + ' ' + r.codename + ' ' + r.model + ' ' + r.version).toLowerCase(); for (const t of tokens) if (!hay.includes(t)) return false; }
  return true;
}

function results() {
  const f = F(), tokens = f.q.split(/\s+/).filter(Boolean);
  const arr = [...S.roms.values()].filter(r => matches(r, f, tokens));
  const cmp = {
    new: (a, b) => b.ts - a.ts || a.name.localeCompare(b.name),
    old: (a, b) => a.ts - b.ts,
    name: (a, b) => a.name.localeCompare(b.name) || b.ts - a.ts,
    rec: (a, b) => (b.method === 'Recovery') - (a.method === 'Recovery') || b.ts - a.ts,
    fast: (a, b) => (b.method === 'Fastboot') - (a.method === 'Fastboot') || b.ts - a.ts,
  }[f.sort];
  return arr.sort(cmp);
}

function buildFilterOptions() {
  const fill = (sel, vals, label = v => v) => {
    const el = $(sel), cur = el.value; el.length = 1;
    for (const v of vals) el.add(new Option(label(v), v)); el.value = [...el.options].some(o => o.value === cur) ? cur : '';
  };
  const all = [...S.roms.values()];
  const osLabels = [...new Set(all.map(r => r.osLabel))].sort((a, b) => (b.startsWith('Hyper') - a.startsWith('Hyper')) || b.localeCompare(a, undefined, { numeric: true }));
  const el = $('#fOs'), cur = el.value; el.length = 1;
  el.add(new Option('HyperOS (all)', 'HyperOS')); el.add(new Option('MIUI (all)', 'MIUI'));
  for (const l of osLabels) el.add(new Option('  ' + l, l)); el.value = cur;
  fill('#fAv', [...new Set(all.map(r => r.android).filter(Boolean))].sort((a, b) => b - a), v => 'Android ' + v);
  fill('#fBranch', [...new Set(all.map(r => r.branch))].sort());
}

/* ---------- render ---------- */
function romCard(r) {
  const fresh = S.fresh.has(r.id), recent = r.ts && Date.now() - r.ts < 7 * 864e5;
  const st = romState(r), p = st === 'dead' ? null : bestMirror(r);
  const dl = st === 'dead'
    ? `<span class="primary disabled" title="This file is no longer available on any Xiaomi mirror">✗ Not available</span>`
    : `<a class="primary" href="${esc(p ? mirrorUrl(r, p.host) : r.link)}" target="_blank" rel="noopener">⬇ Download${p && p.ms != null ? ` · ${p.ms} ms` : ''}</a>`;
  return `<article class="rom ${fresh ? 'fresh' : ''} ${st === 'dead' ? 'dead' : ''}" data-id="${esc(r.id)}">
    <div>
      <h3>${fresh ? '<span class="tag new just">NEW</span>' : recent ? '<span class="tag new">NEW</span>' : ''}
        <button data-dev="${esc(r.codename)}" title="Show all ROMs for this device">${esc(r.name)}</button><span class="cn">${esc(r.codename)}</span><span class="tag type ${r.method === 'Fastboot' ? 'fb' : 'rc'}">${r.method === 'Fastboot' ? '⚡ FASTBOOT' : '♻ RECOVERY'}</span></h3>
      <div class="ver">${esc(r.version)}</div>
      <div class="meta">
        <span class="tag os">${esc(r.osLabel)}</span>
        ${r.android ? `<span class="tag android">Android ${esc(r.android)}</span>` : ''}
        ${st === 'dead' ? '<span class="tag bad">✗ Link dead</span>' : st === 'ok' ? '<span class="tag good">✓ Link verified</span>' : ''}
        <span class="tag">${esc(r.branch)}</span><span class="tag">${esc(r.method)}</span>
        ${r.size ? `<span class="tag">${esc(r.size)}</span>` : ''}
        ${r.date ? `<span class="tag">📅 ${esc(r.date)}</span>` : ''}
      </div>
    </div>
    <div class="actions">
      ${dl}
      <button class="secondary" data-mirrors="${esc(r.id)}">All mirrors &amp; details</button>
    </div>
  </article>`;
}

function render() {
  if (!S.loaded) return;
  const res = results(), f = F();
  $('#count').textContent = `${res.length.toLocaleString()} ROM${res.length === 1 ? '' : 's'}` + (S.device ? '' : f.q ? ` matching “${$('#q').value.trim()}”` : ' · latest releases first');
  $('#list').innerHTML = res.length ? res.slice(0, S.shown).map(romCard).join('') : '<div class="empty">No ROMs match your search and filters.<br>Try a codename like <b>alioth</b>, or reset the filters.</div>';
  $('#more').hidden = res.length <= S.shown;
  $('#more').textContent = `Show more (${Math.min(PAGE, res.length - S.shown)} of ${res.length - S.shown} remaining)`;
  renderDeviceHead(res); renderSuggest(); syncHash(); updatePingSummary();
}

function renderDeviceHead(res) {
  const h = $('#deviceHead');
  if (!S.device) { h.hidden = true; h.innerHTML = ''; return; }
  const d = S.devices.get(S.device) || {}, any = res[0];
  h.hidden = false;
  h.innerHTML = `<div><h2>${esc(d.name || any?.name || S.device)}</h2><small>Codename <b>${esc(S.device)}</b>${d.model ? ' · Model ' + esc(d.model) : ''} · full ROM history</small></div><button id="clearDev">✕ All devices</button>`;
}

function renderSuggest() {
  const el = $('#suggest'), q = $('#q').value.trim().toLowerCase();
  if (!q || S.device) { el.hidden = true; el.innerHTML = ''; return; }
  const tokens = q.split(/\s+/), seen = new Set(), out = [];
  for (const [cn, d] of S.devices) {
    const hay = (d.name + ' ' + cn + ' ' + d.model).toLowerCase();
    if (tokens.every(t => hay.includes(t)) && !seen.has(cn)) { seen.add(cn); out.push([cn, d]); }
  }
  out.sort((a, b) => (a[0].toLowerCase() === q ? -1 : 0) - (b[0].toLowerCase() === q ? -1 : 0) || a[1].name.length - b[1].name.length);
  el.hidden = !out.length;
  el.innerHTML = out.slice(0, 8).map(([cn, d]) => `<button class="chip" data-dev="${esc(cn)}">${esc(d.name)}<code>${esc(cn)}</code></button>`).join('');
}

function selectDevice(cn) {
  S.device = cn || null; S.shown = PAGE;
  if (cn) { $('#q').value = ''; $('#clearQ').hidden = true; }
  render(); if (cn) scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- mirrors & ping ---------- */
function mirrorUrl(r, host) { try { const u = new URL(r.link); u.host = host; return u.href; } catch { return r.link; } }
function okFor(r, host) {
  if (!r || !S.status) return null;
  try {
    const st = S.status.s[new URL(r.link).pathname.slice(1)]; if (!st) return null;
    const i = S.status.hosts.indexOf(host); return i < 0 ? null : st[i] === '1';
  } catch { return null; }
}
function romState(r) {
  if (!S.status) return 'unknown';
  try {
    const st = S.status.s[new URL(r.link).pathname.slice(1)]; if (!st) return 'unknown';
    return st.includes('1') ? 'ok' : 'dead';
  } catch { return 'unknown'; }
}
function sortedMirrors(r) {
  return MIRRORS.map(m => ({ ...m, ...(S.ping.get(m.host) || { state: 'wait', ms: null }), ok: r ? okFor(r, m.host) : null }))
    .sort((a, b) => (a.ok === false) - (b.ok === false) || (a.ms == null) - (b.ms == null) || a.ms - b.ms);
}
function bestMirror(r) {
  const list = sortedMirrors(r).filter(m => m.ok !== false);
  return list.find(m => m.ms != null && !m.warn) || list.find(m => m.ms != null) || null;
}

async function pingOnce(host, t = 5000) {
  const c = new AbortController(), to = setTimeout(() => c.abort(), t), t0 = performance.now();
  try { await fetch(`https://${host}/favicon.ico?_=${Math.random()}`, { mode: 'no-cors', cache: 'no-store', signal: c.signal, credentials: 'omit' }); return performance.now() - t0; }
  catch { return null; } finally { clearTimeout(to); }
}
let pinging = false, modalRaf = 0;
function scheduleModalUpdate() {
  if (!$('#modal').open || modalRaf) return;
  modalRaf = requestAnimationFrame(() => { modalRaf = 0; updateModalMirrors(); });
}
async function measurePings() {
  if (pinging) return; pinging = true;
  MIRRORS.forEach(m => S.ping.set(m.host, { ms: S.ping.get(m.host)?.ms ?? null, state: 'testing' }));
  scheduleModalUpdate();
  await Promise.all(MIRRORS.map(async m => {
    await pingOnce(m.host);
    const s = []; for (let i = 0; i < 3; i++) { const v = await pingOnce(m.host); if (v != null) s.push(v); }
    s.sort((a, b) => a - b);
    S.ping.set(m.host, s.length ? { ms: Math.round(s[Math.floor(s.length / 2)]), state: 'ok' } : { ms: null, state: 'down' });
    scheduleModalUpdate();
  }));
  pinging = false;
  scheduleModalUpdate();
  updatePingSummary();
  render();
}
function updatePingSummary() {
  const el = $('#pingSummary'), b = bestMirror(), sync = el.dataset.sync || '';
  el.innerHTML = [b ? `Fastest mirror for you: <b>${esc(b.name)} · ${b.ms} ms</b>` : (pinging ? 'Testing mirror speeds…' : ''), sync].filter(Boolean).join(' · ');
}

let modalRom = null;
function renderMirrorRows(r) {
  const ms = sortedMirrors(r), maxMs = Math.max(400, ...ms.map(m => m.ms || 0));
  let originHost = ''; try { originHost = new URL(r.link).host; } catch { }
  return ms.map((m, i) => {
    const dead = m.ok === false, first = i === 0 && m.ms != null && !dead;
    const cls = dead ? 'p-wait' : m.ms == null ? 'p-wait' : m.ms < 120 ? 'p-good' : m.ms < 300 ? 'p-mid' : 'p-bad';
    const txt = dead ? '✗ not on this mirror' : m.state === 'testing' && m.ms == null ? 'testing…' : m.ms == null ? (m.state === 'down' ? 'unreachable' : '–') : m.ms + ' ms';
    const scale = m.ms == null || dead ? 0 : Math.max(0.06, 1 - (m.ms / maxMs)).toFixed(3);
    const u = mirrorUrl(r, m.host);
    return `<div class="mirror ${dead ? 'dead' : ''}"><span class="rank ${first ? 'best' : ''}">${dead ? '✗' : i + 1}</span>
      <div><div class="mname">${esc(m.name)} ${first ? '<span class="badge">FASTEST</span>' : ''}${m.ok === true ? '<span class="badge ok">✓ VERIFIED</span>' : ''}${m.host === originHost ? '<span class="badge orig">ORIGIN</span>' : ''}</div><div class="mhost">${esc(m.host)} · ${esc(m.note)}</div></div>
      <div><div class="ping ${cls}">${txt}</div><div class="bar2"><i style="transform:scaleX(${scale})"></i></div></div>
      <div class="mbtns">${dead ? '<span class="primary disabled">Unavailable</span>' : `<a class="primary" href="${esc(u)}" target="_blank" rel="noopener">Download</a><button class="secondary" data-copy="${esc(u)}" title="Copy link">⧉</button>`}</div></div>`;
  }).join('');
}
function updateModalMirrors() {
  const r = modalRom; if (!r || !$('#modal').open) return;
  const box = $('#mMirrors'), btn = $('#reping');
  if (box) box.innerHTML = renderMirrorRows(r);
  if (btn) btn.textContent = pinging ? 'Testing…' : '↻ Re-test';
}
function openModal(id) {
  modalRom = S.roms.get(id); if (!modalRom) return;
  const r = modalRom;
  $('#mTitle').textContent = `${r.name} · ${r.version}`;
  $('#mBody').innerHTML = `
    <div class="info">
      <div><small>OS</small>${esc(r.osLabel)}</div><div><small>Android</small>${esc(r.android || '–')}</div>
      <div><small>Channel / Type</small>${esc(r.branch)} · ${esc(r.method)}</div><div><small>Size</small>${esc(r.size || '–')}</div>
      <div><small>Released</small>${esc(r.date || '–')}</div><div><small>Codename</small>${esc(r.codename)}</div>
    </div>
    ${r.md5 ? `<div class="info" style="grid-template-columns:1fr"><div><small>MD5</small><span class="md5">${esc(r.md5)}</span></div></div>` : ''}
    <div class="mhead"><h3>Download mirrors <small style="color:var(--muted);font-weight:400">sorted by your ping</small></h3><button class="secondary" id="reping">${pinging ? 'Testing…' : '↻ Re-test'}</button></div>
    <div id="mMirrors">${renderMirrorRows(r)}</div>
    <p class="note">Ping is measured from your browser to each mirror's server.</p>
    ${r.changelog ? `<div class="mhead"><h3>Changelog</h3></div><div class="changelog">${esc(r.changelog)}</div>` : ''}`;
  if (!$('#modal').open) $('#modal').showModal();
  $('#mBody').scrollTop = 0;
  if (!pinging && ![...S.ping.values()].some(p => p.ms != null)) measurePings();
}

/* ---------- URL hash state ---------- */
function syncHash() {
  const f = F(), p = new URLSearchParams();
  if (S.device) p.set('device', S.device); else if (f.q) p.set('q', $('#q').value.trim());
  for (const [k, v] of Object.entries({ os: f.os, av: f.av, ch: f.branch, type: f.method, from: f.from, to: f.to })) if (v) p.set(k, v);
  if (f.sort !== 'new') p.set('sort', f.sort);
  history.replaceState(null, '', p.toString() ? '#' + p : location.pathname + location.search);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  $('#q').value = p.get('q') || ''; $('#clearQ').hidden = !$('#q').value;
  S.pendingSel = { '#fOs': p.get('os'), '#fAv': p.get('av'), '#fBranch': p.get('ch'), '#fMethod': p.get('type') };
  $('#fFrom').value = p.get('from') || ''; $('#fTo').value = p.get('to') || ''; $('#fSort').value = p.get('sort') || 'new';
  if (p.get('device')) S.device = p.get('device');
}
function applyPendingSel() {
  for (const [sel, v] of Object.entries(S.pendingSel || {})) if (v) { const el = $(sel); if (![...el.options].some(o => o.value === v)) el.add(new Option(v, v)); el.value = v; }
  S.pendingSel = null;
}

/* ---------- events ---------- */
let qTimer;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); $('#clearQ').hidden = !$('#q').value; if (S.device) S.device = null; qTimer = setTimeout(() => { S.shown = PAGE; render(); }, 120); });
$('#clearQ').onclick = () => { $('#q').value = ''; $('#clearQ').hidden = true; S.shown = PAGE; render(); $('#q').focus(); };
for (const id of ['#fOs', '#fAv', '#fBranch', '#fMethod', '#fFrom', '#fTo', '#fSort']) $(id).addEventListener('change', () => { S.shown = PAGE; S.quick.clear(); document.querySelectorAll('#quick button').forEach(b => b.classList.remove('on')); render(); });
$('#reset').onclick = () => { for (const id of ['#q', '#fOs', '#fAv', '#fBranch', '#fMethod', '#fFrom', '#fTo']) $(id).value = ''; $('#fSort').value = 'new'; $('#clearQ').hidden = true; S.device = null; S.shown = PAGE; document.querySelectorAll('#quick button').forEach(b => b.classList.remove('on')); render(); };
$('#brand').onclick = e => { e.preventDefault(); $('#reset').click(); scrollTo({ top: 0, behavior: 'smooth' }); };
$('#more').onclick = () => { S.shown += PAGE; render(); };
$('#quick').onclick = e => {
  const b = e.target.closest('button'); if (!b) return; const k = b.dataset.quick;
  if (/^\d+$/.test(k)) { const d = new Date(Date.now() - k * 864e5); $('#fFrom').value = d.toISOString().slice(0, 10); $('#fTo').value = ''; }
  else if (k === 'hyper') $('#fOs').value = 'HyperOS'; else if (k === 'stable') $('#fBranch').value = 'Stable';
  b.classList.add('on'); S.shown = PAGE; render();
};
document.addEventListener('click', e => {
  const t = e.target;
  const dev = t.closest('[data-dev]'); if (dev) return selectDevice(dev.dataset.dev);
  if (t.closest('#clearDev')) return selectDevice(null);
  const mi = t.closest('[data-mirrors]'); if (mi) return openModal(mi.dataset.mirrors);
  const cp = t.closest('[data-copy]'); if (cp) { navigator.clipboard?.writeText(cp.dataset.copy); cp.textContent = '✓'; setTimeout(() => cp.textContent = '⧉', 1200); return; }
  if (t.closest('#reping')) return measurePings();
  if (t === $('#modal')) $('#modal').close();
});
$('#refreshBtn').onclick = async () => {
  const b = $('#refreshBtn'); b.classList.add('spin');
  try { await fetch(API_BASE + '/api/refresh', { method: 'POST' }); } catch { }
  await loadAll(false); checkSourceSync(); measurePings(); b.classList.remove('spin');
};
$('#themeBtn').onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'); const n = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; localStorage.setItem('mirom.theme', n); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) { document.title = 'MiROM Hub – Xiaomi Official ROM Downloads'; loadAll(false); } });

/* ---------- boot ---------- */
(async function boot() {
  const th = localStorage.getItem('mirom.theme'); if (th) document.documentElement.dataset.theme = th;
  try { S.seen = new Set(JSON.parse(localStorage.getItem('mirom.seen') || '[]')); } catch { }
  readHash();
  measurePings();
  await loadAll(true);
  applyPendingSel(); render();
  checkSourceSync();
  setInterval(() => { if (!document.hidden) loadAll(false); }, POLL_MS);
  setInterval(() => { if (!document.hidden) measurePings(); }, PING_EVERY_MS);
  setInterval(checkSourceSync, 60 * 1000);
})();
