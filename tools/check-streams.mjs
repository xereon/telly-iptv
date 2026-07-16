#!/usr/bin/env node
/* TELLY stream checker — validates every stream URL in the app's playlists.
 *
 * Fetches the same iptv-org playlists the app uses (minus religious channels,
 * same as the app), requests each stream manifest, and classifies failures:
 *   404 / 403 / 401 / 4xx / 5xx      HTTP errors
 *   timeout                          no response within TIMEOUT_MS
 *   dns                              hostname doesn't resolve
 *   tls-handshake                    TLS/certificate failure
 *   refused / reset                  TCP connection failed
 *   invalid-content                  responded 200 but body is not an M3U8
 *   network                          other transport error
 *
 * A "suggested replacement" is another entry for the same channel (same
 * tvg-id base, falling back to normalized name) whose stream checks out OK.
 *
 * Usage:  node check-streams.mjs [--limit N] [--concurrency N]
 * Output: report/stream-report.json (full), report/broken.csv (broken only)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = [
  'https://iptv-org.github.io/iptv/languages/eng.m3u',
  'https://iptv-org.github.io/iptv/countries/au.m3u',
];

const TIMEOUT_MS = 12000;
const BODY_LIMIT = 64 * 1024;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const LIMIT = argVal('--limit', Infinity);
const CONCURRENCY = argVal('--concurrency', 80);

const RELIGIOUS_RE = /\b(church|gospel|catholic|islam|hope|faith|god|christian|worship|bible)\b/i;

/* ---- parse (mirrors the app's parser) ---- */

function parseM3U(text) {
  const out = [];
  let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) { meta = line; continue; }
    if (!meta || !line || line.startsWith('#')) continue;
    const attr = (n) => (meta.match(new RegExp(n + '="([^"]*)"')) || [])[1] || '';
    const lastQuote = meta.lastIndexOf('"');
    const comma = meta.indexOf(',', lastQuote === -1 ? 8 : lastQuote);
    let name = comma === -1 ? '' : meta.slice(comma + 1).trim();
    name = name.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    const tvgId = attr('tvg-id');
    const group = attr('group-title');
    const cats = group.split(';').map((c) => c.trim()).filter((c) => c && c !== 'Undefined');
    // same exclusion the app applies
    if (cats.includes('Religious')) { meta = null; continue; }
    if (!cats.length && RELIGIOUS_RE.test(name)) { meta = null; continue; }
    out.push({ name: name || tvgId || 'Unknown', tvgId, url: line });
    meta = null;
  }
  return out;
}

// key used to find replacement candidates for the same channel
function channelKey(e) {
  const base = e.tvgId.split('@')[0];
  if (base) return 'id:' + base.toLowerCase();
  return 'name:' + e.name.toLowerCase().replace(/\((\d{3,4}p)[^)]*\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ---- checking ---- */

function classifyError(err) {
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  const c = err.cause || err;
  const code = c.code || '';
  const msg = String(c.message || err.message || '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') ||
      /certificate|handshake|ssl|tls/i.test(msg) ||
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
       'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return 'tls-handshake';
  return 'network';
}

async function checkOne(entry) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(entry.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    const ms = Date.now() - started;
    const cors = res.headers.get('access-control-allow-origin');
    if (!res.ok) {
      const s = res.status;
      const failure = s === 404 ? '404' : s === 403 ? '403' : s === 401 ? '401'
        : s === 410 ? '410' : s < 500 ? `4xx (${s})` : `5xx (${s})`;
      res.body?.cancel().catch(() => {});
      return { ok: false, failure, status: s, ms, finalUrl: res.url };
    }
    // 200 — make sure it actually looks like an HLS manifest
    let body = '';
    const reader = res.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      while (body.length < BODY_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        body += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
    }
    if (!body.includes('#EXTM3U')) {
      return { ok: false, failure: 'invalid-content', status: res.status, ms, finalUrl: res.url };
    }
    return { ok: true, ms, corsOpen: cors === '*' || !!cors, finalUrl: res.url };
  } catch (err) {
    return { ok: false, failure: classifyError(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/* ---- main ---- */

const t0 = Date.now();
console.log('Fetching playlists…');
const texts = await Promise.all(SOURCES.map(async (u) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`playlist fetch failed: ${u} → ${r.status}`);
  return r.text();
}));

const byUrl = new Map();
for (const t of texts) for (const e of parseM3U(t)) if (!byUrl.has(e.url)) byUrl.set(e.url, e);
let entries = [...byUrl.values()];
if (entries.length > LIMIT) entries = entries.slice(0, LIMIT);
console.log(`Checking ${entries.length} streams (concurrency ${CONCURRENCY}, timeout ${TIMEOUT_MS / 1000}s)…`);

const results = new Array(entries.length);
let next = 0, done = 0;
async function worker() {
  while (next < entries.length) {
    const i = next++;
    results[i] = { ...entries[i], ...(await checkOne(entries[i])) };
    if (++done % 200 === 0) console.log(`  ${done}/${entries.length} checked…`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));

// replacement suggestions: a working stream for the same channel
const okByKey = new Map();
for (const r of results) {
  if (!r.ok) continue;
  const k = channelKey(r);
  if (!okByKey.has(k)) okByKey.set(k, []);
  okByKey.get(k).push(r.url);
}
const broken = results.filter((r) => !r.ok);
for (const b of broken) {
  const candidates = (okByKey.get(channelKey(b)) || []).filter((u) => u !== b.url);
  if (candidates.length) b.suggestedReplacement = candidates[0];
}

/* ---- report ---- */

const byFailure = {};
for (const b of broken) byFailure[b.failure] = (byFailure[b.failure] || 0) + 1;
const ok = results.length - broken.length;

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'report');
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, 'stream-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  tookSeconds: Math.round((Date.now() - t0) / 1000),
  note: 'Checked server-side from this machine; 403s may be geo-blocks that differ by region. corsOpen=false streams are alive but will not play in the web app.',
  totals: { checked: results.length, ok, broken: broken.length, byFailure },
  broken: broken.map(({ name, url, failure, status, ms, suggestedReplacement }) =>
    ({ name, url, failure, status, ms, suggestedReplacement })),
  okWithoutCors: results.filter((r) => r.ok && !r.corsOpen).map(({ name, url }) => ({ name, url })),
}, null, 2));

const csvEsc = (s = '') => '"' + String(s).replace(/"/g, '""') + '"';
writeFileSync(join(outDir, 'broken.csv'),
  'name,url,failure,http_status,suggested_replacement\n' +
  broken.map((b) => [csvEsc(b.name), csvEsc(b.url), b.failure, b.status || '', csvEsc(b.suggestedReplacement || '')].join(',')).join('\n'));

console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s — ${ok}/${results.length} OK, ${broken.length} broken`);
console.log('By failure type:', JSON.stringify(byFailure, null, 2));
console.log(`Replacements derived: ${broken.filter((b) => b.suggestedReplacement).length}`);
console.log(`Report: ${join(outDir, 'stream-report.json')}`);
