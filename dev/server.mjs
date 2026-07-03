// Dev-only static server + generic API forwarder for the OmniTime preview.
// Serves the extension folder and exposes POST /__forward which performs the
// request server-side (so the preview page avoids CORS and TLS issues with the
// self-signed local cert). The target URL + api-key are supplied per request by
// the preview page, so you can point it at the local API or the live (old) API
// and enter the token right in the config window — no env vars needed.
//
//   npm run dev            # then open the page and fill in API URL + key
//   (optional) PORT=8791   OMNITIME_API_KEY=<fallback key>
//
// Not shipped in the extension bundle (excluded by build_extension.sh).

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env (local only, git-ignored) so the harness needs no env vars and no
// site-specific values live in committed code.
function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    text.split('\n').forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
    });
  } catch (e) { /* no .env - fall back to process.env / blanks */ }
  return env;
}
const ENV = loadEnv();
const cfg = (k) => process.env[k] || ENV[k] || '';

const PORT = process.env.PORT || 8791;
const FALLBACK_KEY = cfg('OMNITIME_API_KEY');

// Non-secret preview defaults exposed to the page (never the key).
const PREVIEW_ENV = {
  apiUrl: cfg('OMNITIME_API_URL'),
  source: cfg('OMNITIME_SOURCE'),
  projectId: cfg('OMNITIME_PROJECT_ID'),
  issueId: cfg('OMNITIME_ISSUE_ID'),
  issueLabel: cfg('OMNITIME_ISSUE_LABEL'),
  hasKey: !!FALLBACK_KEY,
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Forward { url, method, body, apiKey } to the real API and mirror its
// status + body back (so the page sees real status codes, e.g. 404/403).
function forward(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let spec;
    try { spec = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch (e) { return sendJson(res, 400, { message: 'Bad forward request' }); }

    const { url, method = 'GET', body = null, apiKey = '' } = spec;
    if (!url) return sendJson(res, 400, { message: 'Missing target url' });
    let target;
    try { target = new URL(url); }
    catch (e) { return sendJson(res, 400, { message: 'Invalid target url' }); }

    const lib = target.protocol === 'http:' ? http : https;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'api-key': apiKey || FALLBACK_KEY, Accept: 'application/json' };
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const preq = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method,
      rejectUnauthorized: false,
      headers,
    }, (pres) => {
      res.writeHead(pres.statusCode, { 'Content-Type': pres.headers['content-type'] || 'application/json' });
      pres.pipe(res);
    });
    preq.on('error', (e) => sendJson(res, 502, { message: 'Forward error: ' + e.message }));
    if (payload != null) preq.write(payload);
    preq.end();
  });
}

function serveStatic(pathname, res) {
  if (pathname === '/') pathname = '/dev/preview.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/__forward') {
    forward(req, res);
  } else if (url.pathname === '/dev/env.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end('window.OMNI_ENV = ' + JSON.stringify(PREVIEW_ENV) + ';');
  } else {
    serveStatic(url.pathname, res);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`OmniTime dev preview: http://127.0.0.1:${PORT}/dev/preview.html  (enter API URL + key in the page)`);
});
