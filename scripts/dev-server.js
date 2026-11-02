// dev-server.js - Local preview: serves the static files like Vercel does
//
// Usage: node scripts/dev-server.js   ->  http://localhost:3001 (3000 is often the portfolio's)
//
// The headers and cleanUrls of vercel.json are applied as on Vercel. To check a Content-Security-Policy change, set
// CSP_REPORT=1 (violations logged here, policy enforced) or CSP_REPORT=only (logged, not enforced).
//
// /motis/... is relayed to a local MOTIS server (MOTIS_URL, default http://localhost:8080; see
// docs/evaluation.md): the page's debug view engine calls it on its own origin, so neither the
// Content-Security-Policy nor CORS are involved. Not on Vercel: there the engine is not offered.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3001;
const CSP_REPORT_PATH = '/__csp-report';
const MOTIS_PREFIX = '/motis/';
const MOTIS_URL = process.env.MOTIS_URL || 'http://localhost:8080';

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
    if (!url.pathname.startsWith(MOTIS_PREFIX)) console.log(req.method, url.pathname);

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
    if (url.pathname.startsWith(MOTIS_PREFIX)) {
        const target = new URL(url.pathname.slice(MOTIS_PREFIX.length - 1) + url.search, MOTIS_URL);
        const proxied = http.request(target, { method: req.method, headers: { 'content-type': req.headers['content-type'] || '' } }, answer => {
            res.writeHead(answer.statusCode, { 'Content-Type': answer.headers['content-type'] || 'application/json' });
            answer.pipe(res);
        });
        proxied.on('error', () => { res.statusCode = 502; res.end('{"error":"MOTIS unreachable"}'); });
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
