'use strict';

// 主控状态机测试（A8）
// 方式：用桩件替掉 ui.js（B4 尚未交付），对着**真实启动的中间层**跑完整交互链路。
//
// 数据构造思路：
//   1. ui 用桩件记录调用，断言"主控把什么交给了界面"——这样在杨泓的 ui.js 交付前
//      就能先把主控逻辑验证到位，交付后只需替换桩件即可；
//   2. 接口层不桩，直接连真实服务，避免"桩件和真实服务行为不一致"导致的假通过；
//   3. 重点覆盖错误路径与状态迁移：重复结算、名单为空、顺序点名轮次结束、
//      切换模式时保持顺序游标、导出模块未就绪。

const assert = require('assert');

const { createMemoryStore } = require('../server/store-memory.js');
const { createServer, DEMO_ROSTER } = require('../server/index.js');

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

/** 桩件 UI：记录所有渲染入口与事件注入 */
function stubUi() {
  const calls = {
    handlers: null,
    students: [],
    rollResults: [],
    settlements: [],
    rankings: [],
    errors: [],
    busy: [],
    importPreviews: [],
  };
  return {
    calls,
    init(h) {
      calls.handlers = h;
    },
    renderStudents(rows, total) {
      calls.students.push({ rows, total });
    },
    renderRollResult(r) {
      calls.rollResults.push(r);
    },
    renderSettlement(s) {
      calls.settlements.push(s);
    },
    renderRanking(r) {
      calls.rankings.push(r);
    },
    renderError(code, msg) {
      calls.errors.push({ code, msg });
    },
    setBusy(b) {
      calls.busy.push(b);
    },
    renderImportPreview(preview) {
      calls.importPreviews.push(preview);
    },
  };
}

/** 起一个真实服务并返回 { baseUrl, close } */
async function startServer(students) {
  const server = createServer({
    store: createMemoryStore(students === undefined ? DEMO_ROSTER : students),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/api',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

(async function main() {
  const { createApiClient } = await import('../src/js/api.js');
  const { createApp } = await import('../src/js/app.js');
  const { ApiError } = await import('../src/js/api.js');
  const importer = await import('../src/js/importer.js');
  const XLSX = require('../lib/xlsx.full.min.js');
  function excelFile(matrix) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), '名单');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return { name: '回归名单.xlsx', arrayBuffer: async () => buf };
  }
  const validFile = () =>
    excelFile([
      ['学号', '姓名', '专业'],
      ['00123', '新增学生', '软件工程'],
    ]);

  console.log('\n[app] 启动与首屏');

  await test('start() 注入联调事件回调，并拉取首屏名单', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    assert.ok(ui.calls.handlers, '应调用 ui.init 注入回调');
    assert.deepStrictEqual(
      Object.keys(ui.calls.handlers).sort(),
      [
        'onExportRequested',
        'onImportRequested',
        'onImportConfirmed',
        'onImportCancelled',
        'onModeChanged',
        'onRankingRequested',
        'onRollRequested',
        'onScoreSubmitted',
        'onStudentsRequested',
        'onRecoveryRequested',
        'onProbabilitiesRequested',
        'onReplayRequested',
      ].sort()
    );
    assert.strictEqual(ui.calls.students.length, 1);
    assert.strictEqual(ui.calls.students[0].total, 8);
    assert.strictEqual(ui.calls.students[0].rows.length, 8);
    await srv.close();
  });

  await test('执行期间 setBusy 依次收到 true / false', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    ui.calls.busy.length = 0;
    await ui.calls.handlers.onRankingRequested(5);
    assert.deepStrictEqual(ui.calls.busy, [true, false]);
    await srv.close();
  });

  console.log('\n[app] 随机点名与结算');

  await test('随机点名把结果交给 renderRollResult，并记录 recordId', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    ui.calls.handlers = ui.calls.handlers; // 保持引用清晰
    await ui.calls.handlers.onModeChanged('random');
    await ui.calls.handlers.onRollRequested();
    assert.strictEqual(ui.calls.rollResults.length, 1);
    const r = ui.calls.rollResults[0];
    assert.ok(r.recordId > 0);
    assert.strictEqual(r.mode, 'random');
    assert.ok(r.student.sno && r.student.name);
    assert.strictEqual(
      app.state.students.reduce((sum, student) => sum + student.onCallCount, 0),
      DEMO_ROSTER.reduce((sum, student) => sum + student.onCallCount, 0) + 1,
      '点名后名单中的随机次数应与服务端同步'
    );
    assert.strictEqual(ui.calls.errors.length, 0);
    await srv.close();
  });

  await test('结算 +4.5 后 renderSettlement 收到正确增量，且本地积分同步', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onRollRequested();
    const sno = ui.calls.rollResults[0].student.sno;
    const before = app.state.students.find((s) => s.sno === sno).score;

    await ui.calls.handlers.onScoreSubmitted({ present: 1, repeat: 'accurate', answerBonus: 3 });
    assert.strictEqual(ui.calls.settlements.length, 1);
    const s = ui.calls.settlements[0];
    assert.strictEqual(s.delta, 4.5);
    assert.strictEqual(s.score, Math.round((before + 4.5) * 100) / 100);
    assert.strictEqual(app.state.students.find((x) => x.sno === sno).score, s.score);
    await srv.close();
  });

  await test('重复结算 → renderError 收到 ALREADY_SETTLED', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onRollRequested();
    await ui.calls.handlers.onScoreSubmitted({ present: 1, repeat: 'none' });
    await ui.calls.handlers.onScoreSubmitted({ present: 1, repeat: 'none' });
    assert.strictEqual(ui.calls.errors.length, 1);
    assert.strictEqual(ui.calls.errors[0].code, 'ALREADY_SETTLED');
    assert.strictEqual(ui.calls.settlements.length, 1, '第二次不应再渲染结算');
    await srv.close();
  });

  await test('未点名就提交结算 → 提示先点名', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onScoreSubmitted({ present: 1, repeat: 'none' });
    assert.strictEqual(ui.calls.errors[0].code, 'VALIDATION_ERROR');
    assert.ok(ui.calls.errors[0].msg.includes('请先点名'));
    await srv.close();
  });

  await test('结算入参非法（present=null）→ 报 VALIDATION_ERROR', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onRollRequested();
    await ui.calls.handlers.onScoreSubmitted({ present: null });
    assert.strictEqual(ui.calls.errors[0].code, 'VALIDATION_ERROR');
    assert.strictEqual(ui.calls.settlements.length, 0);
    await srv.close();
  });

  console.log('\n[app] 顺序点名与游标');

  await test('顺序点名逐位推进，游标按学号前进', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onModeChanged('sequence');
    await ui.calls.handlers.onRollRequested();
    const first = ui.calls.rollResults[0].student.sno;
    assert.strictEqual(app.state.cursor, first);
    await app.handlers.onScoreSubmitted({ present: 0 });
    await ui.calls.handlers.onRollRequested();
    const second = ui.calls.rollResults[1].student.sno;
    assert.notStrictEqual(second, first);
    assert.ok(second > first, '顺序点名应按学号递增');
    await srv.close();
  });

  await test('切随机点名再切回顺序，继续原来的顺序进度', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onModeChanged('sequence');
    await ui.calls.handlers.onRollRequested();
    const first = app.state.cursor;
    assert.ok(first);
    await app.handlers.onScoreSubmitted({ present: 0 });
    await ui.calls.handlers.onModeChanged('random');
    await ui.calls.handlers.onRollRequested();
    assert.strictEqual(app.state.cursor, first);
    await app.handlers.onScoreSubmitted({ present: 0 });
    await ui.calls.handlers.onModeChanged('sequence');
    await ui.calls.handlers.onRollRequested();
    assert.strictEqual(app.state.cursor, DEMO_ROSTER[1].sno);
    await srv.close();
  });

  await test('本轮点完后再点 → 提示本轮已完成', async () => {
    const srv = await startServer([
      { sno: 'S001', name: '甲', major: '', score: 0 },
      { sno: 'S002', name: '乙', major: '', score: 0 },
    ]);
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onModeChanged('sequence');
    await ui.calls.handlers.onRollRequested();
    await app.handlers.onScoreSubmitted({ present: 0 });
    await ui.calls.handlers.onRollRequested();
    await app.handlers.onScoreSubmitted({ present: 0 });
    await ui.calls.handlers.onRollRequested();
    assert.strictEqual(ui.calls.rollResults.length, 2, '两人名单只应点出两次');
    assert.ok(ui.calls.errors[0].msg.includes('本轮'));
    await srv.close();
  });

  await test('模式取值非法 → 报错且不改变当前模式', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onModeChanged('乱传的值');
    assert.strictEqual(ui.calls.errors[0].code, 'VALIDATION_ERROR');
    assert.strictEqual(app.state.mode, 'random');
    await srv.close();
  });

  console.log('\n[app] 导入预览与确认（真实 xlsx + HTTP）');

  await test('选文件只做校验，展示冲突与数字学号警告；确认后保留已有积分和次数', async () => {
    const srv = await startServer([
      { sno: '123', name: '旧姓名', major: '', score: 6, onCallCount: 2 },
    ]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(
        excelFile([
          ['学号', '姓名', '专业'],
          [123, '新姓名', '软件工程'],
        ])
      );
      const preview = ui.calls.importPreviews.at(-1);
      assert.equal(preview.total, 1);
      assert.equal(preview.conflicts[0].sno, '123');
      assert.ok(preview.warnings.length > 0);
      assert.equal((await api.listStudents()).rows[0].name, '旧姓名');
      await app.handlers.onImportConfirmed();
      const student = (await api.listStudents()).rows[0];
      assert.equal(student.name, '新姓名');
      assert.equal(student.score, 6);
      assert.equal(student.onCallCount, 2);
      assert.equal(app.state.pendingImport, null);
    } finally {
      await srv.close();
    }
  });

  await test('取消导入不写库，之后确认也不能提交旧名单', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      await app.handlers.onImportCancelled();
      await app.handlers.onImportConfirmed();
      assert.equal((await api.listStudents()).total, 0);
      assert.equal(ui.calls.errors.at(-1).code, 'VALIDATION_ERROR');
    } finally {
      await srv.close();
    }
  });

  await test('重新选择异常文件会清除上一份待确认名单', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      await app.handlers.onImportRequested(
        excelFile([
          ['学号', '姓名'],
          ['', '异常学生'],
        ])
      );
      assert.equal(app.state.pendingImport, null);
      await app.handlers.onImportConfirmed();
      assert.equal((await api.listStudents()).total, 0);
    } finally {
      await srv.close();
    }
  });

  await test('服务器校验失败时不允许确认导入', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      api.validateImport = async () => {
        throw new ApiError('DB_UNAVAILABLE', '数据库离线');
      };
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      assert.equal(app.state.pendingImport, null);
      assert.equal(ui.calls.errors.at(-1).code, 'DB_UNAVAILABLE');
      assert.equal((await api.listStudents()).total, 0);
    } finally {
      await srv.close();
    }
  });

  await test('UI 没有预览入口时停止导入，不能跳过确认写库', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      delete ui.renderImportPreview;
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      assert.equal(app.state.pendingImport, null);
      assert.equal(ui.calls.errors.at(-1).code, 'INTERNAL');
      assert.equal((await api.listStudents()).total, 0);
    } finally {
      await srv.close();
    }
  });

  await test('导入提交失败后保留预览，重试成功且前导零保留', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const commit = api.commitImport;
      api.commitImport = async () => {
        throw new ApiError('NETWORK_ERROR', '提交前断网');
      };
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      await app.handlers.onImportConfirmed();
      assert.ok(app.state.pendingImport);
      assert.equal(app.state.busy, false);
      api.commitImport = commit;
      await app.handlers.onImportConfirmed();
      assert.equal((await api.listStudents()).rows[0].sno, '00123');
      assert.equal(app.state.pendingImport, null);
    } finally {
      await srv.close();
    }
  });

  await test('连续点击确认只发一次提交，忙碌时不切换模式', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const commit = api.commitImport;
      let commits = 0;
      api.commitImport = (input) => {
        commits++;
        return commit(input);
      };
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      await Promise.all([
        app.handlers.onImportConfirmed(),
        app.handlers.onImportConfirmed(),
        app.handlers.onModeChanged('sequence'),
      ]);
      assert.equal(commits, 1);
      assert.equal(app.state.mode, 'random');
      assert.equal((await api.listStudents()).total, 1);
    } finally {
      await srv.close();
    }
  });

  await test('提交成功但刷新失败时清除待导入状态，重试不会重复提交', async () => {
    const srv = await startServer([]);
    try {
      const ui = stubUi();
      const api = createApiClient({ baseUrl: srv.baseUrl });
      const list = api.listStudents;
      const app = createApp({ ui, api, importer, xlsx: XLSX });
      await app.start();
      await app.handlers.onImportRequested(validFile());
      api.listStudents = async () => {
        throw new ApiError('NETWORK_ERROR', '刷新失败');
      };
      await app.handlers.onImportConfirmed();
      assert.equal(app.state.pendingImport, null);
      api.listStudents = list;
      await app.handlers.onImportConfirmed();
      assert.equal((await api.listStudents()).total, 1);
      assert.equal(ui.calls.errors.at(-1).code, 'VALIDATION_ERROR');
    } finally {
      await srv.close();
    }
  });

  console.log('\n[app] 排行榜、导出、空名单、断网');

  await test('请求排行榜 → renderRanking 收到指定条数', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onRankingRequested(5);
    assert.strictEqual(ui.calls.rankings.length, 1);
    assert.strictEqual(ui.calls.rankings[0].length, 5);
    await srv.close();
  });

  await test('导出模块未注入 → 报"未就绪"，不静默失败', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onExportRequested();
    assert.strictEqual(ui.calls.errors[0].code, 'INTERNAL');
    assert.ok(ui.calls.errors[0].msg.includes('未就绪'));
    await srv.close();
  });

  await test('注入导出模块后，导出拿到完整名单并交给 exporter', async () => {
    const srv = await startServer();
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    let exported = null;
    app.setExporter({
      exportDetail(rows) {
        exported = rows;
      },
    });
    await app.start();
    await ui.calls.handlers.onExportRequested();
    assert.ok(Array.isArray(exported));
    assert.strictEqual(exported.length, 8);
    assert.strictEqual(ui.calls.errors.length, 0);
    await srv.close();
  });

  await test('名单为空时点名 → 提示先导入名单', async () => {
    const srv = await startServer([]);
    const ui = stubUi();
    const app = createApp({ ui, api: createApiClient({ baseUrl: srv.baseUrl }) });
    await app.start();
    await ui.calls.handlers.onRollRequested();
    assert.strictEqual(ui.calls.errors[0].code, 'EMPTY_ROSTER');
    assert.strictEqual(ui.calls.rollResults.length, 0);
    await srv.close();
  });

  await test('服务连不上 → 报 NETWORK_ERROR，不抛未捕获异常', async () => {
    const ui = stubUi();
    const app = createApp({
      ui,
      api: createApiClient({ baseUrl: 'http://127.0.0.1:1/api' }),
    });
    await app.start();
    assert.strictEqual(ui.calls.errors.length, 1);
    assert.strictEqual(ui.calls.errors[0].code, 'NETWORK_ERROR');
    assert.strictEqual(ui.calls.students.length, 0);
  });

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length > 0) {
    failures.forEach((f) => console.log('  ✗ ' + f.name + ' → ' + f.message));
    process.exit(1);
  }
})();
