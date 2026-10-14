'use strict';

// 中间层接口测试（A7 / A10）
// 覆盖接口约定 3.4.4 的全部 11 个端点与 3.4.5 的错误码
//
// 数据构造思路：
//   1. 用 8 人虚拟名单（含 -1 分与 0 分）复现原型里的场景，概率可与原型页面互相对照；
//   2. 错误路径优先于正常路径——判 0 风险来自"重复加分""名单为空"这类异常分支，
//      正常路径反而是最容易写的；
//   3. 除直接调用处理函数外，再跑一轮真实 HTTP 往返，验证路由匹配、JSON 解析
//      与统一错误信封确实生效（只测函数会漏掉路由写错这类问题）。

const assert = require('assert');

const { createMemoryStore } = require('../server/store-memory.js');
const { createApi } = require('../server/api.js');
const { createServer, DEMO_ROSTER } = require('../server/index.js');
const { ApiError } = require('../server/errors.js');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log('  ✗ ' + name + ' → ' + err.message);
  }
}

/** 每个用例用独立的 store，避免用例之间互相污染 */
function freshApi(students) {
  const store = createMemoryStore(students || DEMO_ROSTER);
  return { store, api: createApi({ store }) };
}

async function expectApiError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ApiError, '应抛出 ApiError，实际 ' + err.constructor.name);
    assert.strictEqual(err.code, code, '错误码应为 ' + code + '，实际 ' + err.code);
    return err;
  }
  throw new Error('预期抛出 ' + code + '，但没有抛错');
}

(async function main() {
  console.log('\n[api] #1 学生列表');

  await test('返回全部学生，按学号升序', async () => {
    const { api } = freshApi();
    const r = await api.listStudents({});
    assert.strictEqual(r.total, 8);
    assert.deepStrictEqual(
      r.rows.map((s) => s.sno),
      DEMO_ROSTER.map((s) => s.sno)
    );
  });

  await test('关键字搜索命中姓名与学号', async () => {
    const { api } = freshApi();
    assert.strictEqual((await api.listStudents({ q: '顾思齐' })).total, 1);
    assert.strictEqual((await api.listStudents({ q: '102401306' })).total, 1);
    assert.strictEqual((await api.listStudents({ q: '软件工程' })).total, 8);
    assert.strictEqual((await api.listStudents({ q: '不存在的关键字' })).total, 0);
  });

  await test('分页返回正确切片与总数', async () => {
    const { api } = freshApi();
    const page1 = await api.listStudents({ pageSize: '3', pageNo: '1' });
    const page2 = await api.listStudents({ pageSize: '3', pageNo: '2' });
    assert.strictEqual(page1.total, 8);
    assert.strictEqual(page1.rows.length, 3);
    assert.strictEqual(page2.rows.length, 3);
    assert.notStrictEqual(page1.rows[0].sno, page2.rows[0].sno);
  });

  console.log('\n[api] #4 随机点名');

  await test('返回记录 ID、学生、种子、最低分与 8 项概率', async () => {
    const { api } = freshApi();
    const r = await api.roll({ mode: 'random' });
    assert.ok(r.recordId > 0);
    assert.ok(r.student.sno && r.student.name);
    assert.ok(Number.isInteger(r.seed));
    assert.strictEqual(r.minScore, -1);
    assert.strictEqual(r.probabilities.length, 8);
  });

  await test('概率之和为 1，且与 #9 概率端点完全一致', async () => {
    const { api } = freshApi();
    const roll = await api.roll({});
    const sum = roll.probabilities.reduce((a, p) => a + p.probability, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, '概率和应为 1，实际 ' + sum);

    const prob = await api.probabilities();
    assert.strictEqual(prob.minScore, roll.minScore);
    roll.probabilities.forEach((p, i) => {
      assert.strictEqual(p.sno, prob.rows[i].sno);
      assert.ok(Math.abs(p.probability - prob.rows[i].probability) < 1e-12);
    });
  });

  await test('中签学生的随机点名次数 +1', async () => {
    const { api, store } = freshApi();
    const before = (await store.findStudent('102401301')).onCallCount;
    const r = await api.roll({});
    const s = await store.findStudent(r.student.sno);
    if (r.student.sno === '102401301') {
      assert.strictEqual(s.onCallCount, before + 1);
    }
    const totalCalls = (await store.allStudents()).reduce((a, x) => a + x.onCallCount, 0);
    assert.strictEqual(totalCalls, DEMO_ROSTER.reduce((a, x) => a + (x.onCallCount || 0), 0) + 1);
  });

  await test('名单为空时抛 EMPTY_ROSTER', async () => {
    const { api } = freshApi([]);
    await expectApiError(api.roll({}), 'EMPTY_ROSTER');
  });

  await test('mode 传非 random 时拒绝', async () => {
    const { api } = freshApi();
    await expectApiError(api.roll({ mode: 'sequence' }), 'VALIDATION_ERROR');
  });

  console.log('\n[api] #5 顺序点名');

  await test('游标为 null 时从学号最小者开始', async () => {
    const { api } = freshApi();
    const r = await api.rollNext({ cursor: null });
    assert.strictEqual(r.next.sno, '102401301');
    assert.strictEqual(r.roundEnded, false);
    assert.ok(r.recordId > 0);
  });

  await test('逐位推进，最后一位返回 roundEnded', async () => {
    const { api } = freshApi();
    let cursor = null;
    const visited = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await api.rollNext({ cursor });
      assert.strictEqual(r.roundEnded, false);
      visited.push(r.next.sno);
      cursor = r.next.sno;
    }
    assert.strictEqual(visited.length, 8);
    assert.deepStrictEqual(visited, DEMO_ROSTER.map((s) => s.sno));
    const end = await api.rollNext({ cursor });
    assert.strictEqual(end.next, null);
    assert.strictEqual(end.roundEnded, true);
    assert.strictEqual(end.recordId, null);
  });

  await test('顺序点名不增加随机点名次数', async () => {
    const { api, store } = freshApi();
    const before = (await store.allStudents()).reduce((a, s) => a + s.onCallCount, 0);
    await api.rollNext({ cursor: null });
    await api.rollNext({ cursor: '102401301' });
    const after = (await store.allStudents()).reduce((a, s) => a + s.onCallCount, 0);
    assert.strictEqual(after, before);
  });

  console.log('\n[api] #6 积分结算');

  await test('到场 + 准确复述 + 回答 3 → +4.5，积分落库正确', async () => {
    const { api, store } = freshApi();
    const roll = await api.roll({});
    const r = await api.settleRoll({ id: String(roll.recordId), present: 1, repeat: 'accurate', answerBonus: 3 });
    assert.strictEqual(r.delta, 4.5);
    const s = await store.findStudent(roll.student.sno);
    assert.strictEqual(s.score, Math.round((roll.student.score + 4.5) * 100) / 100);
  });

  await test('重复结算返回 ALREADY_SETTLED，且积分不再变化', async () => {
    const { api, store } = freshApi();
    const roll = await api.roll({});
    await api.settleRoll({ id: String(roll.recordId), present: 1, repeat: 'none' });
    const after1 = (await store.findStudent(roll.student.sno)).score;

    await expectApiError(
      api.settleRoll({ id: String(roll.recordId), present: 1, repeat: 'accurate', answerBonus: 3 }),
      'ALREADY_SETTLED'
    );
    const after2 = (await store.findStudent(roll.student.sno)).score;
    assert.strictEqual(after2, after1, '重复结算不应再加分');
  });

  await test('未到场 → 本次 0 分并照常落库', async () => {
    const { api, store } = freshApi();
    const roll = await api.roll({});
    const r = await api.settleRoll({ id: String(roll.recordId), present: 0, answerBonus: 3 });
    assert.strictEqual(r.delta, 0);
    const s = await store.findStudent(roll.student.sno);
    assert.strictEqual(s.score, roll.student.score);
  });

  await test('非法入参（present=null）转成 VALIDATION_ERROR，不静默按未到场处理', async () => {
    const { api, store } = freshApi();
    const roll = await api.roll({});
    const before = (await store.findStudent(roll.student.sno)).score;
    await expectApiError(
      api.settleRoll({ id: String(roll.recordId), present: null }),
      'VALIDATION_ERROR'
    );
    const after = (await store.findStudent(roll.student.sno)).score;
    assert.strictEqual(after, before, '校验失败不得改动积分');
    const roll2 = await store.getRoll(roll.recordId);
    assert.strictEqual(roll2.settled, 0, '校验失败不得置为已结算');
  });

  await test('记录不存在返回 NOT_FOUND', async () => {
    const { api } = freshApi();
    await expectApiError(api.settleRoll({ id: '99999', present: 1 }), 'NOT_FOUND');
  });

  await test('结算写入积分流水，且每笔可按 roll_id 追溯', async () => {
    const { api, store } = freshApi();
    const roll = await api.roll({});
    await api.settleRoll({ id: String(roll.recordId), present: 1, repeat: 'accurate', answerBonus: 3 });
    const logs = await store.getScoreLogs();
    assert.strictEqual(logs.length, 3);
    logs.forEach((l) => assert.strictEqual(l.rollId, roll.recordId));
    assert.strictEqual(
      logs.reduce((a, l) => a + l.delta, 0),
      4.5
    );
    assert.deepStrictEqual(
      logs.map((l) => l.reason).sort(),
      ['到场', '准确复述问题', '准确回答问题'].sort()
    );
  });

  console.log('\n[api] #11 复演（创新点 I1）');

  await test('随机点名记录可复演，结果与落库中签人一致', async () => {
    const { api } = freshApi();
    const roll = await api.roll({});
    const r = await api.replayRoll({ id: String(roll.recordId) });
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.picked.sno, roll.student.sno);
    assert.strictEqual(r.seed, roll.seed);
    assert.strictEqual(r.roster.length, 8);
  });

  await test('连续 200 次抽签，每一次都能复演出同一人', async () => {
    const { api } = freshApi();
    for (let i = 0; i < 200; i += 1) {
      const roll = await api.roll({});
      const r = await api.replayRoll({ id: String(roll.recordId) });
      assert.strictEqual(r.matched, true, '第 ' + i + ' 次复演不一致');
    }
  });

  await test('顺序点名记录无法复演（没有种子），返回 VALIDATION_ERROR', async () => {
    const { api } = freshApi();
    const r = await api.rollNext({ cursor: null });
    await expectApiError(api.replayRoll({ id: String(r.recordId) }), 'VALIDATION_ERROR');
  });

  console.log('\n[api] #2 / #3 导入校验与提交');

  const IMPORT_ROWS = [
    { row: 2, sno: '102401401', name: '新同学甲', major: '软件工程' },
    { row: 3, sno: '102401402', name: '新同学乙', major: '软件工程' },
  ];

  await test('干跑校验：新学号无冲突，willImport 计数正确', async () => {
    const { api } = freshApi();
    const r = await api.validateImport({ rows: IMPORT_ROWS });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.conflicts.length, 0);
    assert.strictEqual(r.willImport, 2);
  });

  await test('干跑校验：识别出与库内已存在的学号冲突', async () => {
    const { api } = freshApi();
    const r = await api.validateImport({
      rows: [{ row: 2, sno: '102401301', name: '陈一宁', major: '软件工程' }],
    });
    assert.strictEqual(r.conflicts.length, 1);
    assert.strictEqual(r.conflicts[0].sno, '102401301');
  });

  await test('文件内重复学号 → DUPLICATE_SNO_IN_FILE，带行号', async () => {
    const { api } = freshApi();
    const err = await expectApiError(
      api.validateImport({
        rows: [
          { row: 2, sno: '102401401', name: '甲', major: '' },
          { row: 7, sno: '102401401', name: '甲重复', major: '' },
        ],
      }),
      'DUPLICATE_SNO_IN_FILE'
    );
    assert.ok(err.message.includes('第 7 行'), '应指出重复行号，实际：' + err.message);
  });

  await test('提交导入：新增 2 人', async () => {
    const { api } = freshApi();
    const r = await api.commitImport({ rows: IMPORT_ROWS, dupPolicy: 'update-info' });
    assert.strictEqual(r.imported, 2);
    assert.strictEqual(r.updated, 0);
    assert.strictEqual((await api.listStudents({})).total, 10);
  });

  await test('与库内重复时更新姓名专业，保留积分与点名次数', async () => {
    const { api, store } = freshApi();
    const before = await store.findStudent('102401306');
    assert.strictEqual(before.score, -1);
    assert.strictEqual(before.onCallCount, 0);

    const r = await api.commitImport({
      rows: [{ row: 2, sno: '102401306', name: '顾思齐', major: '计算机科学与技术' }],
      dupPolicy: 'update-info',
    });
    assert.strictEqual(r.updated, 1);

    const after = await store.findStudent('102401306');
    assert.strictEqual(after.major, '计算机科学与技术');
    assert.strictEqual(after.score, -1, '积分必须保留');
    assert.strictEqual(after.onCallCount, 0, '点名次数必须保留');
  });

  await test('提交时存在非法行 → VALIDATION_ERROR，一行都不写', async () => {
    const { api } = freshApi();
    await expectApiError(
      api.commitImport({
        rows: [
          { row: 2, sno: '102401401', name: '甲', major: '' },
          { row: 3, sno: '102401402', name: '', major: '' },
        ],
      }),
      'VALIDATION_ERROR'
    );
    assert.strictEqual((await api.listStudents({})).total, 8, '整批应回滚，未写入任何行');
  });

  await test('dupPolicy 非法 → VALIDATION_ERROR', async () => {
    const { api } = freshApi();
    await expectApiError(
      api.commitImport({ rows: IMPORT_ROWS, dupPolicy: '覆盖全部' }),
      'VALIDATION_ERROR'
    );
  });

  await test('rows 不是数组 / 为空 → VALIDATION_ERROR', async () => {
    const { api } = freshApi();
    await expectApiError(api.commitImport({ rows: 'abc' }), 'VALIDATION_ERROR');
    await expectApiError(api.commitImport({ rows: [] }), 'VALIDATION_ERROR');
  });

  console.log('\n[api] #7 / #8 / #9 / #10 排行榜、导出、概率、历史');

  await test('排行榜按积分降序，同分按学号升序', async () => {
    const { api } = freshApi([
      { sno: 'S002', name: 'B', major: '', score: 3 },
      { sno: 'S001', name: 'A', major: '', score: 3 },
      { sno: 'S003', name: 'C', major: '', score: 5 },
    ]);
    const r = await api.ranking({ limit: '10' });
    assert.deepStrictEqual(r.map((s) => s.sno), ['S003', 'S001', 'S002']);
  });

  await test('排行榜 limit 生效', async () => {
    const { api } = freshApi();
    assert.strictEqual((await api.ranking({ limit: '3' })).length, 3);
    assert.strictEqual((await api.ranking({ limit: '999' })).length, 8);
  });

  await test('导出数据包含全部学生与五个必需字段', async () => {
    const { api } = freshApi();
    const rows = await api.exportDetail();
    assert.strictEqual(rows.length, 8);
    const keys = Object.keys(rows[0]).sort();
    assert.deepStrictEqual(keys, ['major', 'name', 'onCallCount', 'score', 'sno']);
  });

  await test('历史记录返回点名过的记录，含模式与结算状态', async () => {
    const { api } = freshApi();
    await api.roll({});
    await api.rollNext({ cursor: null });
    const rows = await api.records({ limit: '50' });
    assert.strictEqual(rows.length, 2);
    const modes = rows.map((r) => r.mode).sort();
    assert.deepStrictEqual(modes, ['random', 'sequence']);
  });

  console.log('\n[api] HTTP 层（真实往返，验证路由与错误信封）');

  const server = createServer({ store: createMemoryStore(DEMO_ROSTER) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  await test('GET /api/students 返回 ok:true 信封', async () => {
    const res = await fetch(base + '/api/students');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.data.total, 8);
  });

  await test('POST /api/roll → 200，且服务端完成抽签', async () => {
    const res = await fetch(base + '/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'random' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.data.student.sno);
    // 复演端点走 HTTP 再验一次
    const rep = await fetch(base + '/api/roll/' + body.data.recordId + '/replay');
    const repBody = await rep.json();
    assert.strictEqual(repBody.data.matched, true);
  });

  await test('［接线回归］POST /api/roll/next 的 cursor 必须真正生效', async () => {
    // 这条曾经真实失败过：HTTP 层把路由参数当成第一个实参、请求体被整个丢弃，
    // 导致无论传什么 cursor 都返回第一位同学。只测函数不测 HTTP 是发现不了的。
    const first = await fetch(base + '/api/roll/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: null }),
    }).then((r) => r.json());
    const second = await fetch(base + '/api/roll/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: first.data.next.sno }),
    }).then((r) => r.json());
    assert.notStrictEqual(
      second.data.next.sno,
      first.data.next.sno,
      'cursor 未生效：两次返回同一个人（' + first.data.next.sno + '）'
    );
    assert.ok(second.data.next.sno > first.data.next.sno, '顺序点名应按学号递增');
  });

  await test('［接线回归］POST /api/roll 的 mode 必须真正生效', async () => {
    const res = await fetch(base + '/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'sequence' }),
    });
    assert.strictEqual(res.status, 400, 'mode=sequence 应被拒绝；若返回 200 说明请求体没传进去');
    const body = await res.json();
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
  });

  await test('［接线回归］POST /api/import/commit 的 rows 必须真正生效', async () => {
    const before = await fetch(base + '/api/students').then((r) => r.json());
    const res = await fetch(base + '/api/import/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: [{ row: 2, sno: 'HTTP9001', name: '接线测试', major: '软件工程' }],
        dupPolicy: 'update-info',
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.data.imported, 1);
    const after = await fetch(base + '/api/students').then((r) => r.json());
    assert.strictEqual(after.data.total, before.data.total + 1, '名单应真的多了一人');
  });

  await test('［接线回归］POST /api/roll/:id/settle 的 body 必须真正生效', async () => {
    const created = await fetch(base + '/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const res = await fetch(base + '/api/roll/' + created.data.recordId + '/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ present: null }),
    });
    assert.strictEqual(res.status, 400, 'present=null 应被拒绝；若返回 200 说明请求体没传进去');
    const body = await res.json();
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
  });

  await test('未知路径返回 404 + NOT_FOUND 信封', async () => {
    const res = await fetch(base + '/api/not-exist');
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  });

  await test('请求体非 JSON → 400 VALIDATION_ERROR（不是 500）', async () => {
    const res = await fetch(base + '/api/import/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{坏掉的 JSON',
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
  });

  await test('重复结算走 HTTP 返回 409 ALREADY_SETTLED', async () => {
    const created = await fetch(base + '/api/roll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const id = created.data.recordId;
    const first = await fetch(base + '/api/roll/' + id + '/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ present: 1, repeat: 'none' }),
    });
    assert.strictEqual(first.status, 200);
    const second = await fetch(base + '/api/roll/' + id + '/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ present: 1, repeat: 'none' }),
    });
    assert.strictEqual(second.status, 409);
    const body = await second.json();
    assert.strictEqual(body.error.code, 'ALREADY_SETTLED');
  });

  await server.close();

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length > 0) {
    failures.forEach((f) => console.log('  ✗ ' + f.name + ' → ' + f.message));
    process.exit(1);
  }
})();
