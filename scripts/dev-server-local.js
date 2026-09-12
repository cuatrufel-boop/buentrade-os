#!/usr/bin/env node
// Local dev server that replaces dev-server-no-cache.py: same no-cache static file serving, PLUS
// it actually runs the real netlify/functions/*.js handlers in-process, so /.netlify/functions/*
// works from localhost without needing Netlify's hosting to be live. This is the exact same
// function code that Netlify will run once the real site is reactivated (Sept 15) — nothing in
// offers.html/orders.html/quotes.html has to change either way, they always call the same
// relative path.
//
// Secrets (RESEND_API_KEY, etc.) are read from scripts/secrets/.env.local — a plain KEY=VALUE
// file, one per line, never committed (scripts/secrets/ is already gitignored). Copy
// scripts/secrets/.env.local.example to create it.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8901;
const ROOT = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');
const ENV_FILE = path.join(__dirname, 'secrets', '.env.local');

function loadLocalEnv(){
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadLocalEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf',
};

function serveStatic(req, res){
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err2, data) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      if (err2) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

async function serveFunction(req, res, fnName){
  const fnPath = path.join(FUNCTIONS_DIR, fnName + '.js');
  if (!fs.existsSync(fnPath)) { res.writeHead(404); res.end(JSON.stringify({ error: 'No such function: ' + fnName })); return; }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      delete require.cache[require.resolve(fnPath)];
      const fn = require(fnPath);
      const result = await fn.handler({ httpMethod: req.method, headers: req.headers, body });
      res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
      res.end(result.body || '{}');
    } catch (e) {
      console.error(`[functions] ${fnName} threw:`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

const server = http.createServer((req, res) => {
  const match = req.url.match(/^\/\.netlify\/functions\/([^/?]+)/);
  if (match) { serveFunction(req, res, match[1]); return; }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  const hasResendKey = !!process.env.RESEND_API_KEY;
  console.log(`BuenTrade local dev server on http://localhost:${PORT}`);
  console.log(`  /.netlify/functions/* -> netlify/functions/*.js (running in-process, real Resend calls)`);
  console.log(`  RESEND_API_KEY loaded: ${hasResendKey ? 'yes' : 'NO — copy scripts/secrets/.env.local.example to scripts/secrets/.env.local and fill it in'}`);
});
