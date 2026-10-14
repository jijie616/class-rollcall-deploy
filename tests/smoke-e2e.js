'use strict';

// 端到端冒烟测试：对着真实启动的服务进程，按前端会走的顺序完整跑一遍。
//
// 与 test-api.js 的区别：那边用进程内调用与临时端口验证逻辑与路由；
// 这里验证的是"真的把服务起起来之后能不能用"——入口文件、默认存储、
// 静态托管、以及跨请求的状态保持（抽签 → 复演 → 结算 → 排名）。
//
// 用法：先启动服务（PORT=8791 node server/index.js），再执行本脚本。

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8787';

let step = 0;
function log(title, detail) {
  step += 1;
  console.log(
    '  ' + String(step).padStart(2, '0') + '. ' + title + (detail ? '  → ' + detail : '')
  );
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}

(async function main() {
  console.log('\n端到端冒烟测试 @ ' + BASE);

  const health = await call('GET', '/api/students');
  assert(health.status === 200 && health.ok, '/api/students 应返回 200 且 ok');
  log('学生列表', health.data.total + ' 人');
  const rosterBefore = health.data.total;

  // 记录基线：内存存储会跨运行累积，断言一律用增量，保证脚本可重复执行
  const recordsBefore = (await call('GET', '/api/records?limit=500')).data.length;

  const prob = await call('GET', '/api/probabilities');
  assert(prob.ok, '概率端点应成功');
  const sum = prob.data.rows.reduce((a, r) => a + r.probability, 0);
  assert(Math.abs(sum - 1) < 1e-9, '概率之和应为 1');
  log('概率查看', '最低分 ' + prob.data.minScore + '，概率合计 ' + (sum * 100).toFixed(1) + '%');

  const roll = await call('POST', '/api/roll', { mode: 'random' });
  assert(roll.ok, '随机点名应成功');
  assert(
    roll.data.probabilities.length === rosterBefore,
    '概率项数应等于名单人数（' + rosterBefore + '）'
  );
  log(
    '随机点名',
    '#' +
      roll.data.recordId +
      ' 抽中 ' +
      roll.data.student.name +
      '（' +
      roll.data.student.sno +
      '）种子 ' +
      roll.data.seed
  );

  const replay = await call('GET', '/api/roll/' + roll.data.recordId + '/replay');
  assert(replay.ok, '复演应成功');
  assert(replay.data.matched === true, '复演结果必须与落库中签人一致');
  log('按种子复演', 'matched=' + replay.data.matched + '，服务端独立复算命中同一人');

  const before = (await call('GET', '/api/students')).data.rows.find(
    (s) => s.sno === roll.data.student.sno
  );
  const settle = await call('POST', '/api/roll/' + roll.data.recordId + '/settle', {
    present: 1,
    repeat: 'accurate',
    answerBonus: 3,
  });
  assert(settle.ok, '结算应成功');
  assert(settle.data.delta === 4.5, '到场+准确复述+回答3 应为 +4.5，实际 ' + settle.data.delta);
  log(
    '积分结算',
    '本次 +' + settle.data.delta + '，总积分 ' + before.score + ' → ' + settle.data.score
  );

  const again = await call('POST', '/api/roll/' + roll.data.recordId + '/settle', { present: 1 });
  assert(again.status === 409 && again.error.code === 'ALREADY_SETTLED', '重复结算应返回 409');
  log('重复结算防护', '409 ' + again.error.code);

  const seq1 = await call('POST', '/api/roll/next', { cursor: null });
  const seq2 = await call('POST', '/api/roll/next', { cursor: seq1.data.next.sno });
  assert(seq1.data.next.sno !== seq2.data.next.sno, '顺序点名应逐位推进');
  log('顺序点名', seq1.data.next.name + ' → ' + seq2.data.next.name);

  const ranking = await call('GET', '/api/ranking?limit=5');
  assert(ranking.ok && ranking.data.length === 5, '排行榜应返回 5 条');
  for (let i = 1; i < ranking.data.length; i += 1) {
    assert(ranking.data[i - 1].score >= ranking.data[i].score, '排行榜应按积分降序');
  }
  log('排行榜', ranking.data.map((s) => s.name + ' ' + s.score).join(' / '));

  const exported = await call('GET', '/api/export/detail');
  assert(exported.data.length === rosterBefore, '导出应包含完整名单');
  const keys = Object.keys(exported.data[0]).sort().join(',');
  assert(keys === 'major,name,onCallCount,score,sno', '导出字段应为五个必需字段，实际 ' + keys);
  log('导出数据', exported.data.length + ' 行，字段 ' + keys);

  const records = await call('GET', '/api/records?limit=500');
  const added = records.data.length - recordsBefore;
  assert(added === 3, '本轮应新增 3 条点名记录（1 随机 + 2 顺序），实际 ' + added);
  const mine = records.data.filter((r) => r.id >= roll.data.recordId);
  assert(
    mine.some((r) => r.mode === 'random') && mine.some((r) => r.mode === 'sequence'),
    '两种模式都应出现'
  );
  const settledRoll = mine.find((r) => r.id === roll.data.recordId);
  assert(settledRoll.settled === 1, '本次抽签的记录应已结算');
  assert(settledRoll.delta === 4.5, '已结算记录的增量应为 4.5，实际 ' + settledRoll.delta);
  log(
    '历史记录',
    '新增 ' + added + ' 条，本次记录 settled=' + settledRoll.settled + ' delta=' + settledRoll.delta
  );

  const uniqueA = 'SMOKE' + Date.now();
  const uniqueB = 'SMOKE' + (Date.now() + 1);
  const imported = await call('POST', '/api/import/commit', {
    rows: [
      { row: 2, sno: uniqueA, name: '冒烟测试甲', major: '软件工程' },
      { row: 3, sno: uniqueB, name: '冒烟测试乙', major: '软件工程' },
    ],
    dupPolicy: 'update-info',
  });
  assert(imported.ok && imported.data.imported === 2, '导入应新增 2 人');
  const after = await call('GET', '/api/students');
  assert(after.data.total === rosterBefore + 2, '导入后名单应增加 2 人');
  log(
    '导入提交',
    '新增 ' + imported.data.imported + ' 人，名单 ' + rosterBefore + ' → ' + after.data.total
  );

  const dup = await call('POST', '/api/import/commit', {
    rows: [{ row: 2, sno: uniqueA, name: '改名后', major: '计算机科学与技术' }],
    dupPolicy: 'update-info',
  });
  assert(dup.ok && dup.data.updated === 1, '重复学号应走更新分支');
  const afterDup = await call('GET', '/api/students');
  assert(afterDup.data.total === rosterBefore + 2, '更新不应增加人数');
  log('重复学号策略', 'updated=' + dup.data.updated + '，人数保持 ' + afterDup.data.total);

  console.log('\n端到端流程全部通过（' + step + ' 步）');
})().catch((err) => {
  console.error('\n冒烟测试失败：' + err.message);
  process.exit(1);
});
