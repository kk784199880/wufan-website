// Admin panel server for Wu Fan's personal website
// Run: node admin/server.mjs
// Opens a visual editor at http://localhost:8765

import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'playground-home', 'src', 'data');
const WORKS_FILE = join(DATA_DIR, 'works.ts');

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

const EDITABLE_FILES = [
  { key: 'about', file: 'about.json', label: '个人信息 / About', icon: '👤' },
  { key: 'awards', file: 'awards.json', label: '获奖记录 / Awards', icon: '🏆' },
  { key: 'timeline', file: 'timeline.json', label: '生涯历程 / Timeline', icon: '📅' },
  { key: 'skills', file: 'skills.json', label: '技能工具 / Skills', icon: '🛠️' },
  { key: 'contact', file: 'contact.json', label: '联系方式 / Contact', icon: '📬' },
  { key: 'passions', file: 'passions.json', label: '设计之外 / Passions', icon: '💪' },
  { key: 'enrichment', file: 'enrichment.json', label: '论文标签 / Enrichment', icon: '📝' },
  { key: 'works', file: 'works.ts', label: '设计作品 / Works', icon: '🎨' },
];

async function readJson(filename) {
  const filepath = join(DATA_DIR, filename);
  const raw = await readFile(filepath, 'utf-8');
  return JSON.parse(raw);
}

async function writeJson(filename, data) {
  const filepath = join(DATA_DIR, filename);
  await writeFile(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function readWorks() {
  const raw = await readFile(WORKS_FILE, 'utf-8');
  return raw;
}

async function writeWorks(content) {
  await writeFile(WORKS_FILE, content, 'utf-8');
}

function sendJson(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, msg, code = 500) {
  sendJson(res, { error: msg }, code);
}

async function handleApi(req, res, url) {
  // GET /api/list
  if (req.method === 'GET' && url === '/api/list') {
    return sendJson(res, EDITABLE_FILES);
  }

  // GET /api/data/:key
  const dataMatch = url.match(/^\/api\/data\/(\w+)$/);
  if (dataMatch) {
    const key = dataMatch[1];
    const entry = EDITABLE_FILES.find((f) => f.key === key);
    if (!entry) return sendError(res, 'Not found', 404);

    if (req.method === 'GET') {
      try {
        if (key === 'works') {
          const content = await readWorks();
          return sendJson(res, { key, data: { content } });
        }
        const data = await readJson(entry.file);
        return sendJson(res, { key, data });
      } catch (e) {
        return sendError(res, e.message);
      }
    }

    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        if (key === 'works') {
          const parsed = JSON.parse(body);
          await writeWorks(parsed.content);
        } else {
          await writeJson(entry.file, JSON.parse(body));
        }
        return sendJson(res, { ok: true });
      } catch (e) {
        return sendError(res, e.message);
      }
    }
  }

  // GET /api/works-raw
  if (req.method === 'GET' && url === '/api/works-raw') {
    try {
      const content = await readWorks();
      return sendJson(res, { content });
    } catch (e) {
      return sendError(res, e.message);
    }
  }

  // PUT /api/works-raw
  if (req.method === 'PUT' && url === '/api/works-raw') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      await writeWorks(parsed.content);
      return sendJson(res, { ok: true });
    } catch (e) {
      return sendError(res, e.message);
    }
  }

  // GET /api/orcid-fetch — fetch live publications from ORCID
  if (req.method === 'GET' && url === '/api/orcid-fetch') {
    try {
      const pubs = await fetchOrcidPubs();
      return sendJson(res, { publications: pubs });
    } catch (e) {
      return sendError(res, 'ORCID fetch failed: ' + e.message);
    }
  }

  return sendError(res, 'Not found', 404);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost').pathname;

  if (url.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  // Serve admin HTML
  try {
    const html = await readFile(join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── ORCID fetcher (deduplicates by DOI) ──

async function fetchOrcidPubs() {
  const resp = await fetch('https://pub.orcid.org/v3.0/0009-0005-7035-5696/works', {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`ORCID API returned ${resp.status}`);
  const data = await resp.json();

  const seen = new Set();
  const pubs = [];

  for (const group of data.group || []) {
    const summaries = group['work-summary'] || [];
    if (!summaries.length) continue;

    // Merge: prefer non-null values from later entries
    const base = { ...summaries[0] };
    for (let i = 1; i < summaries.length; i++) {
      if (!base['journal-title']?.value && summaries[i]['journal-title']?.value) base['journal-title'] = summaries[i]['journal-title'];
      if (!base.url?.value && summaries[i].url?.value) base.url = summaries[i].url;
    }

    const title = base.title?.title?.value || '';
    const year = base['publication-date']?.year?.value || '';
    const journal = base['journal-title']?.value || '';
    const type = base.type || '';

    // Extract DOI
    const ids = group['external-ids']?.['external-id'] || [];
    const doiObj = ids.find((id) => id['external-id-type'] === 'doi');
    const doi = doiObj?.['external-id-value'] || '';
    const url = base.url?.value || (doi ? `https://doi.org/${doi}` : '');

    const dedupKey = doi || title;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    pubs.push({ title, journal, year, doi, url, type });
  }

  pubs.sort((a, b) => b.year.localeCompare(a.year) || a.title.localeCompare(b.title));
  return pubs;
}

const PORT = 8765;
server.listen(PORT, () => {
  console.log(`\n  🔧 吴凡个人网站 - 内容编辑器`);
  console.log(`  ─────────────────────────────`);
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`  ⏎  Press Ctrl+C to stop\n`);

  // Auto-open browser
  const cmd = process.platform === 'win32'
    ? `start http://localhost:${PORT}`
    : `open http://localhost:${PORT}`;
  exec(cmd);
});
