'use strict';
/* Talks to Xiaomi's official updater API (update.miui.com) and to the community tracker feed. Zero dependencies. */
const crypto = require('crypto');

const KEY = Buffer.from('miuiotavalided11'), IV = Buffer.from('0102030405060708');
const FEED = 'https://raw.githubusercontent.com/XiaomiFirmwareUpdater/miui-updates-tracker/master/';
const API_CN = 'https://update.miui.com/updates/miotaV3.php';
const API_GL = 'https://update.intl.miui.com/updates/miotaV3.php';
const regionOf = c => {
  if (!c.includes('_')) return 'CN';
  const m = /_(eea|in|ru|id|tw|tr|jp|kr|lm|za)_/.exec(c);
  return m ? m[1].toUpperCase() : 'GL';
};

const enc = s => { const c = crypto.createCipheriv('aes-128-cbc', KEY, IV); return Buffer.concat([c.update(s, 'utf8'), c.final()]).toString('base64'); };
const dec = s => { const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV); return Buffer.concat([d.update(Buffer.from(s.trim(), 'base64')), d.final()]).toString('utf8'); };
const clean = v => { v = String(v ?? '').trim().replace(/^['"]|['"]$/g, ''); return v === 'null' || v === 'None' ? '' : v; };

async function getText(url, ms = 30000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'MiROM-Hub/1.0' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

/* ---- tracker feed ---- */
function parseLatest(text) {
  const out = []; let cur = null;
  for (const raw of text.split('\n')) {
    const m = /^(- |  )([A-Za-z0-9_]+):\s?(.*)$/.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    if (m[1] === '- ') { cur = {}; out.push(cur); }
    if (cur) cur[m[2]] = clean(m[3]);
  }
  return out;
}
function parseDevices(text) {
  const map = new Map(); let key = null, vals = [];
  const flush = () => { if (key && vals.length) map.set(key, { name: vals[0], model: vals[1] || '' }); };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^[^\s-].*:\s*$/.test(line)) { flush(); key = line.slice(0, -1); vals = []; }
    else if (line.startsWith('- ')) vals.push(clean(line.slice(2)));
  }
  flush(); return map;
}
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1], tag = t => unesc((new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(it) || [])[1] || '');
    const d = tag('description'), g = re => ((re.exec(d) || [])[1] || '').trim();
    const ver = /Version:<\/b>\s*([^|<]+?)\s*\|\s*([\d.]+)/.exec(d) || [], kind = /New (.+?) (Recovery|Fastboot) update/.exec(d) || [];
    const dt = new Date(tag('pubDate'));
    out.push({
      name: g(/Device:<\/b>\s*([^<]*)/), codename: g(/Codename:<\/b>\s*([^<]*)/), version: ver[1] || '', android: ver[2] || '',
      branch: kind[1] || 'Stable', method: kind[2] || 'Recovery', size: g(/Size:<\/b>\s*([^<]*)/), md5: clean(g(/MD5:<\/b>\s*([^<]*)/)),
      link: tag('link').trim(), date: isNaN(dt) ? '' : dt.toISOString().slice(0, 10),
      changelog: ((/Changelog:<\/b><br>([\s\S]*?)<\/p>/.exec(d) || [])[1] || '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').trim(),
    });
  }
  return out;
}
const fetchFeed = async () => ({ roms: parseLatest(await getText(FEED + 'data/latest.yml')), devices: parseDevices(await getText(FEED + 'data/devices.yml')) });
const fetchRss = async base => { for (const n of new Set([base.toLowerCase(), base])) { try { const r = parseRss(await getText(`${FEED}rss/${encodeURIComponent(n)}.xml`)); if (r.length) return r; } catch { } } return []; };

/* ---- Xiaomi official updater API ---- */
async function queryApi({ codename, version, android, branch = 'F' }) {
  const intl = codename.includes('_');
  const body = JSON.stringify({
    id: '', c: String(parseInt(android) || 14), d: codename, f: '1', ov: version, l: 'en_US', n: '', p: codename.split('_')[0],
    r: regionOf(codename), v: 'MIUI-' + version, unlock: '0', sdk: '36', b: branch, pb: '', isR: '0', s: '0', t: '', sys: '', rt: '0',
    g: crypto.randomBytes(16).toString('hex'), i: crypto.randomBytes(16).toString('hex'),
  });
  const r = await fetch(intl ? API_GL : API_CN, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: enc(body), t: '', s: '1' }) });
  if (!r.ok) throw new Error('api ' + r.status);
  const j = JSON.parse(dec(await r.text())), out = [];
  for (const rom of [j.LatestRom, j.CurrentRom]) {
    if (!rom || !rom.filename || !rom.version) continue;
    const file = rom.filename.split('?')[0];
    out.push({
      codename, version: rom.version, md5: rom.md5 || '', android: rom.codebase || '', method: 'Recovery',
      branch: rom.branch === 'F' ? 'Stable' : 'Stable Beta', size: String(rom.filesize || '').replace(/([\d.]+)\s*G.*/i, '$1 GB').replace(/([\d.]+)\s*M.*/i, '$1 MB'),
      link: `https://bigota.d.miui.com/${rom.version}/${file}`,
      changelog: rom.changelog ? Object.entries(rom.changelog).map(([k, v]) => `${k}:\n${(v.txt || []).join('\n')}`).join('\n\n') : '',
    });
  }
  return out;
}

module.exports = { fetchFeed, fetchRss, queryApi, parseLatest };
