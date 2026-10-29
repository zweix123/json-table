import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const maxBytes = 20 * 1024 * 1024;
const htmlURL = new URL('./index.html', import.meta.url);

export function normalizePath(value) {
  if (typeof value !== 'string') throw new Error('请粘贴 JSON 文件的绝对路径。');
  let path = value.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (/^file:\/\//i.test(path)) {
    try { path = fileURLToPath(path); }
    catch { throw new Error('文件路径无效，请使用本机绝对路径。'); }
  }
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('请使用完整的绝对路径，例如 /Users/你的用户名/Downloads/表格.json。');
  if (extname(path).toLowerCase() !== '.json') throw new Error('请选择 .json 文件。');
  return path;
}

async function readJSONFile(path) {
  // Non-blocking open lets us reject pipes/devices before reading them.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('这个路径不是普通文件，请选择 JSON 文件。');
    if (stat.size > maxBytes) throw new Error('文件超过 20 MB，请缩小文件后重试。');
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('文件超过 20 MB，请缩小文件后重试。');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await file.close(); }
}

export function createJSONTableServer() {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    const host = `127.0.0.1:${server.address().port}`;
    // Restrict browser access to this page: no CORS, foreign origins, or DNS rebinding.
    if (request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== `http://${host}`) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
      reply(403, { error: '仅允许本机页面访问。' });
      return;
    }
    try {
      if (request.method === 'GET' && request.url === '/') {
        const html = (await readFile(htmlURL, 'utf8')).replace('name="local-file-token" content=""', `name="local-file-token" content="${token}"`);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      if (request.method !== 'POST' || request.url !== '/api/read-file') {
        reply(404, { error: '没有这个页面。' });
        return;
      }
      if (request.headers['x-local-token'] !== token || request.headers['content-type'] !== 'application/json') {
        reply(403, { error: '页面已失效，请刷新页面后重试。' });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) {
          reply(413, { error: '文件路径过长。' });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('请求格式无效，请刷新页面后重试。'); }
      const path = normalizePath(body?.path);
      reply(200, { path, text: await readJSONFile(path) });
    } catch (error) {
      const message = {
        ENOENT: '找不到文件，请检查路径后重试。',
        ENOTDIR: '找不到文件，请检查路径后重试。',
        EACCES: '没有读取权限，请选择可以访问的 JSON 文件。',
        EPERM: '没有读取权限，请选择可以访问的 JSON 文件。'
      }[error.code] || (error.code ? '文件读取失败，请检查路径和权限。' : error.message);
      reply(400, { error: message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

if (import.meta.main) {
  const server = createJSONTableServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口 4329 已被占用，请关闭占用该端口的程序后重试。' : error.message);
    process.exitCode = 1;
  });
  server.listen(4329, '127.0.0.1', () => console.log('JSON 表格：http://127.0.0.1:4329（按 Ctrl+C 退出）'));
}
