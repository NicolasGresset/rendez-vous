// dev-server.js - Local preview: serves the static files like Vercel does
//
// Usage: node scripts/dev-server.js   ->  http://localhost:3001 (3000 is often the portfolio's)
//
// The headers and cleanUrls of vercel.json are applied as on Vercel. To check a Content-Security-Policy change, set
// CSP_REPORT=1 (violations logged here, policy enforced) or CSP_REPORT=only (logged, not enforced).
//
// /api/... runs the functions of api/ as Vercel does, with the keys of .env (OPENROUTESERVICE_API_KEY, TISSEO_API_KEY).
//
// /v1/... is relayed to the API (API_URL, default the deployed one): it accepts only the site's origin, and here the
// page calls its own origin, so neither CORS nor the Content-Security-Policy are involved.

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;
const CSP_REPORT_PATH = '/__csp-report';
const API_PREFIX = '/v1/';
const API_URL = process.env.API_URL || 'https://api.rendez-vous.gresset-bourgeois.fr';

try {
    process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
    // no .env (CI): the relays answer 401
}

const VERCEL_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

// vercel.json header rules, with their "(.*)" wildcards turned into regular expressions
const HEADER_RULES = (VERCEL_CONFIG.headers || [])
    .map(rule => ({
        pattern: new RegExp(`^${rule.source.split('(.*)').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')}$`),
        headers: rule.headers,
    }));

function setVercelHeaders(pathname, res) {
    for (const rule of HEADER_RULES.filter(r => r.pattern.test(pathname))) {
        for (let { key, value } of rule.headers) {
            if (key.toLowerCase() === 'content-security-policy' && process.env.CSP_REPORT) {
                value += `; report-uri ${CSP_REPORT_PATH}`;
                if (process.env.CSP_REPORT === 'only') key = 'Content-Security-Policy-Report-Only';
            }
            res.setHeader(key, value);
        }
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    console.log(req.method, url.pathname);

    if (url.pathname === CSP_REPORT_PATH) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const r = JSON.parse(body || '{}')['csp-report'] || {};
            console.log(`CSP VIOLATION ${r['violated-directive']} blocked=${r['blocked-uri']} page=${r['document-uri']}`
                + (r['source-file'] ? ` at ${r['source-file']}:${r['line-number']}` : ''));
            res.statusCode = 204;
            res.end();
        });
        return;
    }
    if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            const name = url.pathname.slice('/api/'.length);
            if (req.method !== 'POST' || !['ors', 'tisseo'].includes(name)) { res.statusCode = 405; return res.end(); }
            const { POST } = await import(path.join(ROOT, 'api', `${name}.mjs`));
            const answer = await POST(new Request(url, { method: 'POST', body: Buffer.concat(chunks) }));
            res.writeHead(answer.status, Object.fromEntries(answer.headers));
            res.end(await answer.text());
        });
        return;
    }
    // The API accepts only the site's origin: here, its calls are relayed, without one
    if (url.pathname.startsWith(API_PREFIX)) {
        const target = new URL(url.pathname + url.search, API_URL);
        const client = target.protocol === 'https:' ? https : http;
        const proxied = client.request(target, { method: req.method, headers: { 'content-type': req.headers['content-type'] || '' } }, answer => {
            res.writeHead(answer.statusCode, { 'Content-Type': answer.headers['content-type'] || 'application/json' });
            answer.pipe(res);
        });
        proxied.on('error', () => { res.statusCode = 502; res.end('{"error":"engine_unavailable"}'); });
        req.pipe(proxied);
        return;
    }
    setVercelHeaders(url.pathname, res);

    let file = path.join(ROOT, path.normalize(url.pathname));
    // Never serve outside the repo or dotfiles such as .env
    if (!file.startsWith(ROOT) || url.pathname.split('/').some(p => p.startsWith('.'))) {
        res.statusCode = 403;
        return res.end();
    }
    // cleanUrls, as on Vercel: /page.html redirects to /page (and /index.html to /), /page serves page.html
    if (VERCEL_CONFIG.cleanUrls && url.pathname.endsWith('.html')) {
        res.statusCode = 308;
        res.setHeader('Location', url.pathname.replace(/(index)?\.html$/, '') + url.search);
        return res.end();
    }
    if (VERCEL_CONFIG.cleanUrls && !path.extname(file) && fs.existsSync(`${file}.html`)) file += '.html';
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
        if (err) { res.statusCode = 404; return res.end('Not found'); }
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
        res.end(data);
    });
}).listen(PORT, '127.0.0.1', () => console.log(`Dev server on http://localhost:${PORT}`));
