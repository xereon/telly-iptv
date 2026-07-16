/* HTTPS relay for http:// IPTV streams (mixed-content fix).
 *
 * Browsers block plain-http media on an https page, and ~14% of the playlist
 * only broadcasts over http from servers with no TLS support. The app routes
 * those streams through this same-origin function: it fetches the upstream
 * server-side and returns it over HTTPS. HLS manifests are rewritten so
 * variant/segment/key requests come back through the proxy too; everything
 * else streams through untouched. https:// channels never use this route.
 */

'use strict';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// basic SSRF guard: no loopback / link-local / RFC1918 upstreams
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1?\]?$)/i;

module.exports = async (req, res) => {
  const raw = req.query.url;
  let url;
  try { url = new URL(String(raw)); } catch { return res.status(400).send('invalid url'); }
  if (!/^https?:$/.test(url.protocol) || PRIVATE_HOST.test(url.hostname)) {
    return res.status(400).send('blocked upstream');
  }

  let upstream;
  try {
    upstream = await fetch(url.href, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
    });
  } catch {
    return res.status(502).send('upstream unreachable');
  }
  if (!upstream.ok || !upstream.body) {
    return res.status(upstream.status || 502).send('upstream error ' + upstream.status);
  }

  // sniff the first chunk — manifests start with #EXTM3U regardless of
  // extension or content-type (many upstreams use paths like /play/a01d)
  const reader = upstream.body.getReader();
  const first = await reader.read();
  const firstBuf = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
  const isManifest = firstBuf.slice(0, 16).toString('utf8').trimStart().startsWith('#EXTM3U');

  if (isManifest) {
    const parts = [firstBuf];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    const base = upstream.url || url.href; // after redirects
    const prox = (u) => {
      try { return '/api/proxy?url=' + encodeURIComponent(new URL(u, base).href); }
      catch { return u; }
    };
    const out = Buffer.concat(parts).toString('utf8').split('\n').map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${prox(u)}"`);
      return prox(l);
    }).join('\n');
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(out);
  }

  // segment / key / anything else: stream bytes through
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.write(firstBuf);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* upstream dropped mid-segment — client will re-request */ }
  res.end();
};
