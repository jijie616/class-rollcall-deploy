'use strict';

// HTTP 服务入口：静态托管前端 + 挂载 /api 路由
// 负责人：李文龙（A7）
//
// 启动：node server/index.js
// 环境变量：
//   PORT       监听端口，默认 8787
//   STORE      'memory'（默认，用内置演示名单）| 'mysql'
//   DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME   —— STORE=mysql 时必填
//
// 说明：本地开发默认用内存存储，不需要数据库即可完整跑通 12 个端点；
//      部署时把 STORE 切到 mysql。数据库凭据只存在于本进程环境变量中，
//      前端永远拿不到（对应"前端无需数据库密码"的约定）。

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createApi, matchRoute } = require('./api.js');
const { createMemoryStore } = require('./store-memory.js');
const { ApiError, ok, fail, toErrorBody } = require('./errors.js');
const { createAccessGate } = require('./access.js');

const PORT = Number(process.env.PORT || 8787);
const STORE_KIND = String(process.env.STORE || 'memory');
const SRC_DIR = path.join(__dirname, '..', 'src');
const LIB_DIR = path.join(__dirname, '..', 'lib');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/** 演示名单：仅用于本地无数据库时跑通流程，字段与真实名单一致 */
const DEMO_ROSTER = [
  { sno: '102401301', name: '陈一宁', major: '软件工程', score: 6, onCallCount: 3 },
  { sno: '102401302', name: '林知远', major: '软件工程', score: 4.5, onCallCount: 2 },
  { sno: '102401303', name: '周予安', major: '软件工程', score: 3, onCallCount: 2 },
  { sno: '102401304', name: '许嘉禾', major: '软件工程', score: 2, onCallCount: 1 },
  { sno: '102401305', name: '沈亦舟', major: '软件工程', score: 0, onCallCount: 1 },
  { sno: '102401306', name: '顾思齐', major: '软件工程', score: -1, onCallCount: 0 },
  { sno: '102401307', name: '唐可心', major: '软件工程', score: 1.5, onCallCount: 1 },
  { sno: '102401308', name: '宋星野', major: '软件工程', score: 0, onCallCount: 0 },
];

function buildStore() {
  if (STORE_KIND === 'mysql') {
    // 延迟 require：没装 mysql2 或没配数据库时不影响内存模式运行
    const { createMysqlStore } = require('./store-mysql.js');
    return createMysqlStore({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
  }
  return createMemoryStore(DEMO_ROSTER);
}

/** 读取请求体并解析 JSON（限制 1MB，防止超大请求打满内存） */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new ApiError('VALIDATION_ERROR', '请求体过大（上限 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new ApiError('VALIDATION_ERROR', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 静态文件托管：仅允许 src/ 与 lib/ 两个目录，阻断路径穿越 */
function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    sendJson(res, 400, fail('VALIDATION_ERROR', '非法路径编码'));
    return;
  }
  if (rel.includes('..')) {
    sendJson(res, 400, fail('VALIDATION_ERROR', '非法路径'));
    return;
  }
  const candidates = [path.join(SRC_DIR, rel), path.join(LIB_DIR, rel.replace(/^\/lib/, ''))];
  const file = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!file) {
    sendJson(res, 404, fail('NOT_FOUND', '文件不存在：' + rel));
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function createServer({ store, accessEnv = process.env } = {}) {
  const allow = createAccessGate(accessEnv);
  const activeStore = store || buildStore();
  const api = createApi({ store: activeStore });

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, fail('VALIDATION_ERROR', '非法请求地址'));
      return;
    }
    const pathname = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // 只暴露就绪状态，不返回学生、数据库地址、账号或异常详情。
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/healthz') {
      try {
        await activeStore.listStudents({ pageSize: 1 });
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 503, { ok: false });
      }
      return;
    }
    if (!allow(req, res)) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let sameOrigin = true;
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          sameOrigin =
            ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
        } catch {
          sameOrigin = false;
        }
      }
      if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, 403, fail('FORBIDDEN', '不允许跨站提交课堂操作'));
        return;
      }
    }

    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }

    const route = matchRoute(req.method, pathname);
    if (!route) {
      sendJson(res, 404, fail('NOT_FOUND', '未知接口：' + req.method + ' ' + pathname));
      return;
    }

    try {
      const query = Object.fromEntries(url.searchParams.entries());
      const body = route.input === 'body' ? await readJsonBody(req) : {};
      // 合并优先级：查询串 < 请求体 < 路径参数（路径参数最可靠，不允许被覆盖）
      const input = { ...query, ...body, ...route.params };
      const data = await api[route.handler](input);
      sendJson(res, 200, ok(data));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) {
        console.error('[api] 未分类异常 ' + req.method + ' ' + pathname, err);
      }
      sendJson(res, status, toErrorBody(err));
    }
  });
}

function startServer({ port = PORT, store } = {}) {
  const server = createServer({ store });
  server.listen(port, '0.0.0.0', () => {
    console.log('课堂随机点名系统 · 中间层已启动');
    console.log('  地址：http://127.0.0.1:' + server.address().port + '/');
    console.log('  存储：' + STORE_KIND);
    if (STORE_KIND === 'memory') {
      console.log('  提示：内存模式重启后数据清空，仅用于本地开发与演示');
    }
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { createServer, startServer, buildStore, DEMO_ROSTER };
