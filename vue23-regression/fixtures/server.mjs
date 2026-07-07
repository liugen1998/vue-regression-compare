// fixtures 本地模拟站：node fixtures/server.mjs
// 静态托管 /v2 /v3 /vendor /shared，并提供两端共用的 mock API（同一后端）。
// 环境变量 VMR_FIXTURE_VOLATILE=1 时 gmv 每次请求随机抖动，用于演示 live 模式的数据漂移归因。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const VOLATILE = process.env.VMR_FIXTURE_VOLATILE === '1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rIdx = range => (range === '近30天' ? 2 : 1);
const gIdx = region => ({ 全国: 0, 华东: 1, 华北: 2 }[region] ?? 3);

function summary(range, region) {
  const r = rIdx(range), g = gIdx(region);
  return {
    gmv: 1234567 * r + g * 13579 + (VOLATILE ? Math.floor(Math.random() * 10) : 0),
    orders: 8642 * r + g * 77,
    users: 3141 * r + g * 11,
    traceId: 'trace-' + Math.random().toString(36).slice(2), // 应被 apiIgnoreFields 归一化剔除
    timestamp: Date.now(),
  };
}
const bars = (range, region) => {
  const r = rIdx(range), g = gIdx(region);
  return { cats: ['华东', '华北', '华南', '西部'], values: [820, 932, 1290, 901].map(v => v * r + g * 7), timestamp: Date.now() };
};
const trend = (range, region) => {
  const r = rIdx(range), g = gIdx(region);
  return { days: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], values: [150, 230, 224, 218, 135, 147, 260].map(v => v * r + g), timestamp: Date.now() };
};
const regionDetail = name => ({ name, total: [...String(name)].reduce((s, c) => s + c.charCodeAt(0), 0) * 37, timestamp: Date.now() });
const detail = (range, region) => ({ total: 4321 * rIdx(range) + gIdx(region) * 3, timestamp: Date.now() });

createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const q = k => u.searchParams.get(k) || '';
  if (u.pathname.startsWith('/api/')) {
    await sleep(40); // 模拟后端耗时
    const body =
      u.pathname === '/api/summary' ? summary(q('range'), q('region')) :
      u.pathname === '/api/bars' ? bars(q('range'), q('region')) :
      u.pathname === '/api/trend' ? trend(q('range'), q('region')) :
      u.pathname === '/api/region' ? regionDetail(q('name')) :
      u.pathname === '/api/detail' ? detail(q('range'), q('region')) : null;
    if (!body) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  const safe = normalize(u.pathname).replace(/^([.\\/])+/, '');
  const file = join(ROOT, safe === '' || safe === '/' ? 'v2/index.html' : safe);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found: ' + safe);
  }
}).listen(PORT, () => console.log(`fixtures 模拟站已启动：http://127.0.0.1:${PORT}/v2/index.html 与 /v3/index.html（volatile=${VOLATILE}）`));
