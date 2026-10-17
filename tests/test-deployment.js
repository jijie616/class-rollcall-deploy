'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { createServer, DEMO_ROSTER } = require('../server/index.js');
const { createMemoryStore } = require('../server/store-memory.js');
const { createMysqlStore } = require('../server/store-mysql.js');
const { createAccessGate } = require('../server/access.js');
const env = {
  NODE_ENV: 'production',
  APP_ACCESS_USER: 'teacher',
  APP_ACCESS_PASSWORD: 'deployment-test-only-password',
};
const authorization =
  'Basic ' + Buffer.from(env.APP_ACCESS_USER + ':' + env.APP_ACCESS_PASSWORD).toString('base64');
let passed = 0;
async function test(name, work) {
  await work();
  passed++;
  console.log('  ✓ ' + name);
}
async function withServer(work, { store = createMemoryStore(DEMO_ROSTER), accessEnv = env } = {}) {
  const server = createServer({ store, accessEnv });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`, store);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
(async () => {
  await test('生产环境缺失、半配置、弱口令或非法账号时拒绝启动', async () => {
    for (const bad of [
      { NODE_ENV: 'production' },
      { APP_ACCESS_USER: 'teacher' },
      { APP_ACCESS_PASSWORD: 'long-enough-password' },
      { ...env, APP_ACCESS_PASSWORD: 'short' },
      { ...env, APP_ACCESS_USER: 'a:b' },
    ])
      assert.throws(() => createAccessGate(bad), /部署访问配置无效/);
  });
  await test('本地未配置门禁时保持原有页面和接口', () =>
    withServer(
      async (base) => {
        assert.equal((await fetch(base + '/')).status, 200);
        assert.equal((await fetch(base + '/api/students')).status, 200);
      },
      { accessEnv: {} }
    ));
  await test('匿名访问不能读取名单或写入点名，健康检查只返回就绪状态', () =>
    withServer(async (base, store) => {
      for (const route of ['/', '/js/main.js', '/api/students']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 401);
        assert.ok(response.headers.get('www-authenticate').startsWith('Basic '));
      }
      assert.equal((await fetch(base + '/api/roll', { method: 'POST', body: '{}' })).status, 401);
      assert.deepEqual(await store.listRecords(), []);
      const health = await fetch(base + '/healthz');
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
      assert.equal((await fetch(base + '/healthz', { method: 'HEAD' })).status, 200);
    }));
  await test('错误或畸形 Authorization 均拒绝，不把口令写入响应', () =>
    withServer(async (base) => {
      for (const header of [
        'Bearer not-basic',
        'Basic !!!',
        'Basic ' + Buffer.from('teacher:wrong-password').toString('base64'),
      ]) {
        const response = await fetch(base + '/api/students', {
          headers: { authorization: header },
        });
        assert.equal(response.status, 401);
        assert.ok(!(await response.text()).includes(env.APP_ACCESS_PASSWORD));
      }
    }));
  await test('正确账号可打开资源和完成点名，返回中不包含门禁凭据', () =>
    withServer(async (base) => {
      const headers = { authorization, 'Content-Type': 'application/json' };
      assert.equal((await fetch(base + '/', { headers })).status, 200);
      assert.equal((await fetch(base + '/js/main.js', { headers })).status, 200);
      const response = await fetch(base + '/api/roll', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'random' }),
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(JSON.parse(text).data.recordId > 0);
      assert.ok(!text.includes(env.APP_ACCESS_PASSWORD));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }));
  await test('数据库不可用的健康检查返回 503，不暴露数据库错误', () =>
    withServer(
      async (base) => {
        const response = await fetch(base + '/healthz');
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false });
      },
      {
        store: {
          withTransaction() {},
          async listStudents() {
            throw new Error('private database diagnostics');
          },
        },
      }
    ));
  await test('MySQL 健康诊断保留错误码、抑制重复日志，恢复后能再次报告且不泄露异常内容', async () => {
    let failureCode = 'ECONNREFUSED';
    const secret = 'private-password-and-sql-parameters';
    const logs = [];
    const originalError = console.error;
    const store = createMysqlStore({}, {
      pool: {
        async query(sql) {
          if (failureCode) throw Object.assign(new Error(secret), { code: failureCode, sql: secret });
          return [sql.startsWith('SELECT COUNT(*)') ? [{ n: 0 }] : []];
        },
      },
    });
    console.error = (...args) => logs.push(args.join(' '));
    try {
      await withServer(async (base) => {
        async function unhealthy() {
          const response = await fetch(base + '/healthz');
          assert.equal(response.status, 503);
          assert.deepEqual(await response.json(), { ok: false });
        }
        await unhealthy();
        await unhealthy();
        assert.equal(logs.length, 1);
        assert.ok(logs[0].endsWith('code=ECONNREFUSED'));
        failureCode = 'ER_ACCESS_DENIED_ERROR';
        await unhealthy();
        assert.equal(logs.length, 2);
        assert.ok(logs[1].endsWith('code=ER_ACCESS_DENIED_ERROR'));
        failureCode = '';
        assert.equal((await fetch(base + '/healthz')).status, 200);
        failureCode = 'ECONNREFUSED';
        await unhealthy();
        assert.equal(logs.length, 3);
        failureCode = secret;
        await unhealthy();
        assert.equal(logs.length, 4);
        assert.ok(logs[3].endsWith('code=UNKNOWN'));
        assert.ok(!logs.join('\n').includes(secret));
      }, { store });
    } finally {
      console.error = originalError;
    }
  });
  await test('跨站或不明来源的写请求被拒绝，同源已认证操作可继续', () =>
    withServer(async (base, store) => {
      for (const extra of [
        { origin: 'https://unrelated.invalid' },
        { origin: 'null' },
        { 'sec-fetch-site': 'cross-site' },
      ]) {
        assert.equal(
          (
            await fetch(base + '/api/roll', {
              method: 'POST',
              headers: { authorization, ...extra },
              body: '{}',
            })
          ).status,
          403
        );
      }
      assert.deepEqual(await store.listRecords(), []);
      assert.equal(
        (
          await fetch(base + '/api/roll', {
            method: 'POST',
            headers: { authorization, origin: base },
            body: '{}',
          })
        ).status,
        200
      );
    }));
  await test('畸形路径编码返回 400，服务继续响应', () =>
    withServer(async (base) => {
      assert.equal((await fetch(base + '/%E0%A4%A', { headers: { authorization } })).status, 400);
      assert.equal((await fetch(base + '/healthz')).status, 200);
    }));
  await test('非法绝对请求地址返回 400，不触发未处理异常', () =>
    withServer(async (base) => {
      const status = await new Promise((resolve, reject) => {
        const target = new URL(base);
        const request = http.request(
          {
            hostname: target.hostname,
            port: target.port,
            path: 'http://[',
            headers: { authorization },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          }
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 400);
      assert.equal((await fetch(base + '/healthz')).status, 200);
    }));
  await test('生产 MySQL 启动器尊重平台 PORT 并启用门禁，驱动替身不联网', async () => {
    const child = spawn(
      process.execPath,
      [
        '--require',
        path.join(__dirname, 'fixtures/mysql-startup-stub.cjs'),
        path.join(__dirname, '../server/start-mysql.js'),
      ],
      {
        env: {
          ...process.env,
          ...env,
          PORT: '0',
          DB_HOST: 'test.invalid',
          DB_PORT: '3312',
          DB_USER: 'test',
          DB_PASSWORD: 'test',
          DB_NAME: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const exited = new Promise((resolve) => child.on('exit', resolve));
    let output = '';
    try {
      const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('启动超时')), 6000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error('提前退出 ' + code));
        });
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
        child.stderr.on('data', () => {});
      });
      assert.equal((await fetch(base + '/healthz')).status, 200);
      assert.equal((await fetch(base + '/')).status, 401);
      assert.equal((await fetch(base + '/', { headers: { authorization } })).status, 200);
      assert.ok(!output.includes(env.APP_ACCESS_PASSWORD));
      assert.ok(output.includes('数据库端口：3312'));
    } finally {
      child.kill();
      await exited;
    }
  });
  console.log(`部署准备回归通过 ${passed} 项`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
