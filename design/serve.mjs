import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.MOCKUP_PORT ?? 4786);
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/studio/index.html' : pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': {'.html':'text/html; charset=utf-8','.woff2':'font/woff2'}[extname(path)] ?? 'text/plain', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' }).end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`DealDock Studio: http://127.0.0.1:${port}`));
