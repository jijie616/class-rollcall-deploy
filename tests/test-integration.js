'use strict';
const assert = require('node:assert/strict');
const { createMemoryStore } = require('../server/store-memory.js');
const { createServer, DEMO_ROSTER } = require('../server/index.js');

(async () => {
  const { createApp } = await import('../src/js/app.js');
  const { createApiClient } = await import('../src/js/api.js');
  const students = Array.from({ length: 25 }, (_, i) => ({
    sno: String(i).padStart(5, '0'),
    name: `学生${i}`,
    major: '软件工程',
    score: i - 4,
    onCallCount: 0,
  }));
  let passed = 0;
  async function test(name, fn) {
    const store = createMemoryStore(students);
    const server = createServer({ store });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
      const api = createApiClient({ baseUrl });
      const values = new Map();
      const storage = {
        getItem: (key) => values.get(key),
        setItem: (key, value) => values.set(key, value),
      };
      const make = (client = api) => {
        const events = { errors: [], settlements: [], results: [], probabilities: [], replays: [] };
        const ui = {
          init() {},
          setBusy() {},
          renderStudents() {},
          renderRecovery() {},
          clearRoll() {},
          renderError: (code, message) => events.errors.push({ code, message }),
          renderSettlement: (result) => events.settlements.push(result),
          renderRollResult: (result) => events.results.push(result),
          renderProbabilities: (result) => events.probabilities.push(result),
          renderReplay: (result) => events.replays.push(result),
        };
        return { app: createApp({ ui, api: client, recoveryStorage: storage }), events };
      };
      await fn({ api, make, store, storage, baseUrl });
      passed++;
      console.log(`  ✓ ${name}`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  await test('按 ID 查询未结算和已结算记录，只读查询不重复加分', async ({ api, store }) => {
    const roll = await api.roll();
    const pending = await api.getRecord({ id: roll.recordId });
    assert.equal(pending.calledAt, roll.calledAt);
    assert.equal(pending.settlement, null);
    await api.settleRoll({ id: roll.recordId, present: 1, repeat: 'accurate', answerBonus: 3 });
    const before = await store.allStudents();
    const settled = await api.getRecord({ id: roll.recordId });
    assert.equal(settled.settled, true);
    assert.equal(settled.settlement.delta, 4.5);
    assert.deepEqual(settled.settlement.deltas, { present: 1, repeat: 0.5, answer: 3 });
    await api.getRecord({ id: roll.recordId });
    assert.deepEqual(await store.allStudents(), before);
    await assert.rejects(api.getRecord({ id: 999 }), (error) => error.code === 'NOT_FOUND');
    await assert.rejects(api.getRecord({ id: 0 }), (error) => error.code === 'VALIDATION_ERROR');
  });
  await test('丢失结算响应后自动核验成功，一次加分且解除待核验', async ({ api, make, store }) => {
    const faulty = {
      ...api,
      settleRoll: async (input) => {
        await api.settleRoll(input);
        throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
      },
    };
    const { app } = make(faulty);
    await app.start();
    await app.handlers.onRollRequested();
    const before = (await store.findStudent(app.state.lastRoll.student.sno)).score;
    await app.handlers.onScoreSubmitted({ present: 1, repeat: 'accurate', answerBonus: 3 });
    assert.equal(app.state.lastSettlement.delta, 4.5);
    assert.equal(app.state.recoveryPending, false);
    assert.equal((await store.findStudent(app.state.lastRoll.student.sno)).score, before + 4.5);
    await app.handlers.onRollRequested();
    assert.equal((await api.records()).length, 2);
  });
  await test('结算和核验都断网时保留待核验，恢复后只读查回结果', async ({ api, make }) => {
    let offline = true;
    const faulty = {
      ...api,
      settleRoll: async (input) => {
        await api.settleRoll(input);
        throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
      },
      getRecord: (input) => {
        if (offline) throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
        return api.getRecord(input);
      },
    };
    const { app } = make(faulty);
    await app.start();
    await app.handlers.onRollRequested();
    await app.handlers.onScoreSubmitted({ present: 0 });
    assert.equal(app.state.recoveryPending, true);
    await app.handlers.onRollRequested();
    assert.equal((await api.records()).length, 1);
    offline = false;
    await app.handlers.onRecoveryRequested();
    assert.equal(app.state.lastSettlement.delta, 0);
    assert.equal(app.state.recoveryPending, false);
  });
  await test('请求尚未提交就断网，核验保持未结算，重试后只保存一次', async ({ api, make }) => {
    let first = true;
    const faulty = {
      ...api,
      settleRoll: (input) => {
        if (first) {
          first = false;
          throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
        }
        return api.settleRoll(input);
      },
    };
    const { app } = make(faulty);
    await app.start();
    await app.handlers.onRollRequested();
    await app.handlers.onScoreSubmitted({ present: 1 });
    assert.equal(app.state.lastSettlement, null);
    await app.handlers.onScoreSubmitted({ present: 1 });
    assert.equal(app.state.lastSettlement.delta, 1);
  });
  await test('刷新恢复本页待结算记录与顺序游标，不创建新的点名', async ({ api, make }) => {
    const first = make();
    await first.app.start();
    await first.app.handlers.onModeChanged('sequence');
    await first.app.handlers.onRollRequested();
    const second = make();
    await second.app.start();
    assert.equal(second.app.state.lastRoll.recordId, first.app.state.lastRoll.recordId);
    assert.equal(second.app.state.mode, 'sequence');
    assert.equal(second.app.state.cursor, '00000');
    assert.equal(second.events.results[0].restored, true);
    await second.app.handlers.onScoreSubmitted({ present: 0 });
    await second.app.handlers.onRollRequested();
    assert.equal(second.app.state.cursor, '00001');
    assert.equal((await api.records()).length, 2);
  });
  await test('刷新时已在服务器结算，恢复成功结果并允许继续', async ({ api, make }) => {
    const first = make();
    await first.app.start();
    await first.app.handlers.onRollRequested();
    await api.settleRoll({ id: first.app.state.lastRoll.recordId, present: 0 });
    const second = make();
    await second.app.start();
    assert.equal(second.app.state.lastSettlement.delta, 0);
    await second.app.handlers.onRollRequested();
    assert.equal((await api.records()).length, 2);
  });
  await test('服务重启后相同 ID 不同创建时间不恢复其他学生记录', async ({ api, make, storage }) => {
    const roll = await api.roll();
    storage.setItem(
      'class-rollcall.session.v1',
      JSON.stringify({
        mode: 'random',
        cursor: null,
        record: {
          recordId: roll.recordId,
          calledAt: 'old-incarnation',
          sno: roll.student.sno,
          mode: 'random',
        },
      })
    );
    const { app, events } = make();
    await app.start();
    assert.equal(app.state.lastRoll, null);
    assert.equal(app.state.recoveryPending, false);
    assert.equal(events.errors.at(-1).code, 'NOT_FOUND');
  });
  await test('无保存记录不读取全库最新待结算记录', async ({ api, make }) => {
    await api.roll();
    const { app } = make();
    await app.start();
    assert.equal(app.state.lastRoll, null);
  });
  await test('名单分页及搜索分开统计，筛选空结果仍可全班点名', async ({ api, make }) => {
    const { app } = make();
    await app.start();
    assert.equal(app.state.students.length, 10);
    await app.handlers.onStudentsRequested({ pageNo: 3 });
    assert.equal(app.state.students.length, 5);
    await app.handlers.onStudentsRequested({ q: '00000', pageNo: 1 });
    assert.equal(app.state.students[0].sno, '00000');
    assert.equal(app.state.matchedTotal, 1);
    assert.equal(app.state.total, 25);
    await app.handlers.onStudentsRequested({ q: '无此学生' });
    assert.equal(app.state.students.length, 0);
    assert.equal(app.state.total, 25);
    await app.handlers.onRollRequested();
    assert.ok(app.state.lastRoll);
    await assert.rejects(api.replayRoll({ id: 999 }), (error) => error.code === 'NOT_FOUND');
  });
  await test('首次名单断网后可以重试，非法分页不改变查询', async ({ api, make }) => {
    let first = true;
    const { app, events } = make({
      ...api,
      listStudents: (input) => {
        if (first) {
          first = false;
          throw Object.assign(new Error(), { code: 'NETWORK_ERROR' });
        }
        return api.listStudents(input);
      },
    });
    await app.start();
    assert.equal(app.state.studentsLoaded, false);
    await app.handlers.onStudentsRequested();
    assert.equal(app.state.total, 25);
    await app.handlers.onStudentsRequested({ pageNo: -1 });
    assert.equal(events.errors.at(-1).code, 'VALIDATION_ERROR');
    assert.equal(app.state.query.pageNo, 1);
  });
  await test('概率随积分更新，随机复演一致，顺序记录不能复演', async ({ api, make }) => {
    const { app, events } = make();
    await app.start();
    await app.handlers.onProbabilitiesRequested();
    const probability = events.probabilities[0];
    assert.equal(probability.minScore, -4);
    assert.ok(
      Math.abs(probability.rows.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-10
    );
    await app.handlers.onRollRequested();
    await app.handlers.onReplayRequested(app.state.lastRoll.recordId);
    assert.equal(events.replays[0].matched, true);
    await app.handlers.onScoreSubmitted({ present: 1 });
    await app.handlers.onProbabilitiesRequested();
    assert.notDeepEqual(events.probabilities[1].rows, probability.rows);
    const sequential = await api.rollNext({});
    await app.handlers.onReplayRequested(sequential.recordId);
    assert.equal(events.errors.at(-1).code, 'VALIDATION_ERROR');
  });
  console.log(`联调回归通过 ${passed} 项`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
