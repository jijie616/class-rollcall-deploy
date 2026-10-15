'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createMemoryStore } = require('../server/store-memory.js');
const { createMysqlStore } = require('../server/store-mysql.js');
const { createApi } = require('../server/api.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name, e);
  }
}
const roster = [{ sno: '001', name: '回归学生', major: '软件工程', score: 0, onCallCount: 0 }];
const payload = (id) => ({ id, present: 1, repeat: 'accurate', answerBonus: 3 });

function injectFailure(store, method) {
  const original = store.withTransaction.bind(store);
  store.withTransaction = (work) =>
    original((tx) => {
      tx[method] = async () => {
        throw new Error('injected ' + method);
      };
      return work(tx);
    });
  return () => {
    store.withTransaction = original;
  };
}

// 事务适配器测试替身：模拟 SQL 结果、提交与回滚，不替代真实 MySQL 验收。
function mysqlHarness(failAt = '') {
  let data = {
    student: { sno: '001', name: '回归学生', major: '', score: 0, on_call_count: 1 },
    roll: {
      id: 1,
      sno: '001',
      mode: 'random',
      settled: 0,
      rnd_seed: 1,
      min_score: 0,
      roster_snapshot: '[]',
      present: null,
      repeat_result: null,
      answer_bonus: null,
      delta: null,
      settled_at: null,
      called_at: '2026-10-14 23:00:00',
    },
    logs: [],
  };
  const events = [];
  let before;
  const conn = {
    async beginTransaction() {
      events.push('begin');
      before = structuredClone(data);
    },
    async query(sql, params) {
      events.push(sql);
      if (sql.startsWith('SELECT * FROM roll_records')) return [[structuredClone(data.roll)]];
      if (sql.startsWith('SELECT * FROM students')) return [[structuredClone(data.student)]];
      if (sql.startsWith('INSERT INTO roll_records')) {
        data.roll = {
          ...data.roll,
          id: 2,
          sno: params[0],
          mode: params[1],
          rnd_seed: params[2],
          min_score: params[3],
          roster_snapshot: params[4],
        };
        return [{ insertId: 2 }];
      }
      if (sql.startsWith('UPDATE roll_records')) {
        if (data.roll.settled) return [{ affectedRows: 0 }];
        Object.assign(data.roll, {
          present: params[0],
          repeat_result: params[1],
          answer_bonus: params[2],
          delta: params[3],
          settled: 1,
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE students SET score')) {
        if (failAt === 'score')
          throw Object.assign(new Error('write failed'), { code: 'ECONNREFUSED' });
        data.student.score += params[0];
        data.student.on_call_count += params[1];
        return [{ affectedRows: params[0] === 0 && params[1] === 0 ? 0 : 1 }];
      }
      if (sql.startsWith('INSERT INTO score_logs')) {
        if (failAt === 'logs') throw new Error('log write failed');
        data.logs.push(...params[0]);
        return [{ affectedRows: params[0].length }];
      }
      throw new Error('unexpected SQL: ' + sql);
    },
    async commit() {
      events.push('commit');
      if (failAt === 'commit') throw new Error('commit failed');
    },
    async rollback() {
      events.push('rollback');
      data = before;
    },
    release() {
      events.push('release');
    },
    destroy() {
      events.push('destroy');
    },
  };
  const pool = {
    async getConnection() {
      events.push('acquire');
      return conn;
    },
    async query() {
      throw new Error('事务不得使用池外查询');
    },
    async end() {},
  };
  return { store: createMysqlStore({}, { pool }), events, data: () => data };
}

async function startupTest() {
  const proc = spawn(
    process.execPath,
    [
      '--require',
      path.join(__dirname, 'fixtures/mysql-startup-stub.cjs'),
      path.join(__dirname, '../server/start-mysql.js'),
    ],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: '0',
        DB_HOST: 'test.invalid',
        DB_USER: 'test',
        DB_PASSWORD: 'test',
        DB_NAME: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  let output = '';
  let errors = '';
  proc.stderr.on('data', (b) => {
    errors += b;
  });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MySQL 启动超时：' + errors)), 5000);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('服务提前退出 ' + code + ': ' + errors));
      });
      proc.stdout.on('data', (b) => {
        output += b;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve('http://127.0.0.1:' + match[1]);
        }
      });
    });
    const res = await fetch(base + '/api/students');
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { rows: [], total: 0 });
    assert.equal(proc.exitCode, null, '服务应保持运行');
    assert.ok(output.includes('存储：mysql'));
  } finally {
    proc.kill();
    await exited;
  }
}

(async () => {
  await test('MySQL 入口真实监听 HTTP，驱动使用禁止联网的替身', startupTest);
  await test('MySQL 恢复查询在同一事务读取分项及当前积分，不修改结算', async () => {
    const harness = mysqlHarness();
    const api = createApi({ store: harness.store });
    await api.settleRoll(payload(1));
    const before = structuredClone(harness.data());
    harness.events.length = 0;
    const record = await api.getRecord({ id: 1 });
    assert.equal(record.settled, true);
    assert.equal(record.settlement.delta, 4.5);
    assert.equal(record.settlement.score, 4.5);
    assert.deepEqual(record.settlement.deltas, { present: 1, repeat: 0.5, answer: 3 });
    assert.deepEqual(harness.data(), before);
    assert.equal(harness.events.filter((e) => e === 'acquire').length, 1);
    assert.ok(harness.events.some((e) => e.includes('roll_records') && e.includes('FOR UPDATE')));
    assert.ok(harness.events.some((e) => e.includes('students') && e.includes('FOR UPDATE')));
    assert.ok(harness.events.includes('commit'));
  });

  for (const method of ['applyStudentDelta', 'addScoreLogs']) {
    await test('结算在 ' + method + ' 失败时完整回滚，并能重新结算', async () => {
      const store = createMemoryStore(roster);
      const api = createApi({ store });
      const roll = await api.roll({});
      const restore = injectFailure(store, method);
      await assert.rejects(api.settleRoll(payload(roll.recordId)), /injected/);
      assert.equal((await store.getRoll(roll.recordId)).settled, 0);
      assert.equal((await store.findStudent('001')).score, 0);
      assert.equal((await store.getScoreLogs()).length, 0);
      restore();
      assert.equal((await api.settleRoll(payload(roll.recordId))).score, 4.5);
      assert.equal((await store.getScoreLogs()).length, 3);
    });
  }
  await test('随机次数更新失败时不留下点名记录', async () => {
    const store = createMemoryStore(roster);
    const api = createApi({ store });
    const restore = injectFailure(store, 'applyStudentDelta');
    await assert.rejects(api.roll({}), /injected/);
    assert.equal((await store.listRecords()).length, 0);
    assert.equal((await store.findStudent('001')).onCallCount, 0);
    restore();
    assert.equal((await api.roll({})).recordId, 1);
  });
  await test('并发结算同一记录只加一次积分', async () => {
    const store = createMemoryStore(roster);
    const api = createApi({ store });
    const roll = await api.roll({});
    const results = await Promise.allSettled([
      api.settleRoll(payload(roll.recordId)),
      api.settleRoll(payload(roll.recordId)),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'ALREADY_SETTLED');
    assert.equal((await store.findStudent('001')).score, 4.5);
    assert.equal((await store.getScoreLogs()).length, 3);
  });
  await test('同一学生的两个记录并发结算不会覆盖积分', async () => {
    const store = createMemoryStore(roster);
    const api = createApi({ store });
    const a = await api.roll({});
    const b = await api.roll({});
    const results = await Promise.all([
      api.settleRoll(payload(a.recordId)),
      api.settleRoll(payload(b.recordId)),
    ]);
    assert.deepEqual(
      results.map((r) => r.score),
      [4.5, 9]
    );
    assert.equal((await store.findStudent('001')).score, 9);
    assert.equal((await store.getScoreLogs()).length, 6);
  });
  await test('未提交事务的修改不可被普通读取看到', async () => {
    const store = createMemoryStore(roster);
    let ready;
    let finish;
    const started = new Promise((r) => {
      ready = r;
    });
    const gate = new Promise((r) => {
      finish = r;
    });
    const work = store.withTransaction(async (tx) => {
      await tx.applyStudentDelta('001', { scoreDelta: 1 });
      ready();
      await gate;
    });
    await started;
    try {
      assert.equal((await store.findStudent('001')).score, 0);
    } finally {
      finish();
      await work;
    }
    assert.equal((await store.findStudent('001')).score, 1);
  });

  await test('MySQL 结算锁定记录与学生，同一连接提交状态、积分与流水', async () => {
    const h = mysqlHarness();
    assert.equal((await createApi({ store: h.store }).settleRoll(payload(1))).score, 4.5);
    assert.equal(h.data().roll.settled, 1);
    assert.equal(h.data().logs.length, 3);
    assert.ok(
      h.events.some((s) => s.startsWith('SELECT * FROM roll_records') && s.endsWith('FOR UPDATE'))
    );
    assert.ok(
      h.events.some((s) => s.startsWith('SELECT * FROM students') && s.endsWith('FOR UPDATE'))
    );
    assert.deepEqual(h.events.slice(-2), ['commit', 'release']);
  });
  for (const failAt of ['score', 'logs', 'commit']) {
    await test('MySQL ' + failAt + ' 故障时回滚，释放连接且不留下部分结算', async () => {
      const h = mysqlHarness(failAt);
      await assert.rejects(createApi({ store: h.store }).settleRoll(payload(1)));
      assert.equal(h.data().roll.settled, 0);
      assert.equal(h.data().student.score, 0);
      assert.equal(h.data().logs.length, 0);
      assert.deepEqual(h.events.slice(-2), ['rollback', 'release']);
    });
  }
  await test('MySQL 未到场零增量仍能正常结算', async () => {
    const h = mysqlHarness();
    const result = await createApi({ store: h.store }).settleRoll({ id: 1, present: 0 });
    assert.equal(result.score, 0);
    assert.equal(h.data().roll.settled, 1);
    assert.equal(h.data().logs.length, 0);
  });
  await test('MySQL 随机点名在同一事务提交记录和随机次数', async () => {
    const h = mysqlHarness();
    const result = await createApi({ store: h.store }).roll({});
    assert.equal(result.recordId, 2);
    assert.equal(h.data().roll.sno, result.student.sno);
    assert.equal(h.data().student.on_call_count, 2);
    assert.deepEqual(h.events.slice(-2), ['commit', 'release']);
  });
  await test('MySQL 随机次数写入失败时同时回滚新点名记录', async () => {
    const h = mysqlHarness('score');
    await assert.rejects(createApi({ store: h.store }).roll({}), { code: 'DB_UNAVAILABLE' });
    assert.equal(h.data().roll.id, 1);
    assert.equal(h.data().student.on_call_count, 1);
    assert.deepEqual(h.events.slice(-2), ['rollback', 'release']);
  });
  for (const failSecond of [false, true]) {
    await test(
      'MySQL 批量导入' + (failSecond ? '中途失败完整回滚' : '成功更新资料并保留积分和次数'),
      async () => {
        let students = [{ sno: '001', name: '旧姓名', major: '', score: 6, on_call_count: 2 }];
        let before;
        const events = [];
        const conn = {
          async beginTransaction() {
            before = structuredClone(students);
            events.push('begin');
          },
          async query(sql, params) {
            if (sql.startsWith('SELECT sno')) return [students.filter((s) => s.sno === params[0])];
            if (sql.startsWith('INSERT INTO students')) {
              if (failSecond && params[0] === '003') throw new Error('second insert failed');
              students.push({
                sno: params[0],
                name: params[1],
                major: params[2],
                score: 0,
                on_call_count: 0,
              });
              return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('UPDATE students SET name')) {
              const student = students.find((s) => s.sno === params[2]);
              student.name = params[0];
              student.major = params[1];
              return [{ affectedRows: 1 }];
            }
            throw new Error('unexpected SQL');
          },
          async commit() {
            events.push('commit');
          },
          async rollback() {
            students = before;
            events.push('rollback');
          },
          release() {
            events.push('release');
          },
        };
        const store = createMysqlStore(
          {},
          {
            pool: {
              async getConnection() {
                return conn;
              },
              async query() {
                throw new Error('pool query must not run');
              },
            },
          }
        );
        const rows = [
          { sno: '001', name: '新姓名', major: '软件工程' },
          { sno: '002', name: '新增甲', major: '' },
        ];
        if (failSecond) rows.push({ sno: '003', name: '新增乙', major: '' });
        const promise = createApi({ store }).commitImport({ rows });
        if (failSecond) {
          await assert.rejects(promise, /second insert failed/);
          assert.deepEqual(students, [
            { sno: '001', name: '旧姓名', major: '', score: 6, on_call_count: 2 },
          ]);
          assert.deepEqual(events, ['begin', 'rollback', 'release']);
        } else {
          const result = await promise;
          assert.deepEqual(result, { imported: 1, updated: 1, rejected: [] });
          assert.equal(students[0].name, '新姓名');
          assert.equal(students[0].score, 6);
          assert.equal(students[0].on_call_count, 2);
          assert.equal(students.length, 2);
          assert.deepEqual(events, ['begin', 'commit', 'release']);
        }
      }
    );
  }
  await test('MySQL 连接获取失败转为 DB_UNAVAILABLE', async () => {
    const store = createMysqlStore(
      {},
      {
        pool: {
          getConnection: async () => {
            throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
          },
        },
      }
    );
    await assert.rejects(
      store.withTransaction(() => {}),
      { code: 'DB_UNAVAILABLE' }
    );
  });
  await test('MySQL 回滚失败时销毁连接，并保留原始错误', async () => {
    const events = [];
    const store = createMysqlStore(
      {},
      {
        pool: {
          getConnection: async () => ({
            async beginTransaction() {},
            async rollback() {
              throw new Error('rollback failed');
            },
            release() {
              events.push('release');
            },
            destroy() {
              events.push('destroy');
            },
          }),
        },
      }
    );
    await assert.rejects(
      store.withTransaction(() => {
        throw new Error('original failure');
      }),
      /original failure/
    );
    assert.deepEqual(events, ['destroy']);
  });
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) process.exitCode = 1;
})();
