'use strict';

// lottery.js 单元测试（A10）
// 测试函数：calcWeight / randomPick / replay / sequencePick / computeWeights
//
// 数据构造思路：
//   1. 除零与负权重是本题最致命的缺陷（原型阶段实际出现过），优先构造 score = minScore
//      以及全员负分的边界名单做回归；
//   2. 用原型里那 8 位同学的虚拟名单（含 -1、0、6 等跨度）做数值对照，
//      把服务端算出的概率与原型页面已经展示过的概率逐一比对；
//   3. 复演能力靠"同种子必得同结果"来验证，跑大量随机种子排除偶然；
//   4. "积分越高概率越低"是题目的硬性要求，用大样本统计验证，不能只看单次结果。

const assert = require('assert');
const L = require('../server/lottery.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log('  ✗ ' + name + ' → ' + err.message);
  }
}

// 原型使用的虚拟名单（8 人，含负积分）
const ROSTER = [
  { sno: '102401301', name: '陈一宁', major: '软件工程', score: 6 },
  { sno: '102401302', name: '林知远', major: '软件工程', score: 4.5 },
  { sno: '102401303', name: '周予安', major: '软件工程', score: 3 },
  { sno: '102401304', name: '许嘉禾', major: '软件工程', score: 2 },
  { sno: '102401305', name: '沈亦舟', major: '软件工程', score: 0 },
  { sno: '102401306', name: '顾思齐', major: '软件工程', score: -1 },
  { sno: '102401307', name: '唐可心', major: '软件工程', score: 1.5 },
  { sno: '102401308', name: '宋星野', major: '软件工程', score: 0 },
];

console.log('\n[lottery] 权重函数 calcWeight');

test('积分为 -1 且最低分也是 -1 时不再除零，返回 1', () => {
  assert.strictEqual(L.calcWeight(-1, -1), 1);
});

test('全员负分（-5 为最低）时分母仍 >= 1，权重为正', () => {
  const w = L.calcWeight(-5, -5);
  assert.strictEqual(w, 1);
  assert.ok(L.calcWeight(-3, -5) > 0);
});

test('score 低于 minScore 时抛 RangeError（防止调用方传错快照）', () => {
  assert.throws(() => L.calcWeight(1, 5), RangeError);
});

test('积分越高权重严格越低', () => {
  const min = -1;
  const weights = [6, 4.5, 3, 2, 1.5, 0, -1].map((s) => L.calcWeight(s, min));
  for (let i = 1; i < weights.length; i += 1) {
    assert.ok(weights[i - 1] < weights[i], '第 ' + i + ' 项应严格小于后一项');
  }
});

test('权重恒为正，且分母不会小于 1', () => {
  const candidates = [-1, -0.5, 0, 0.5, 3, 100];
  const min = -1;
  candidates.forEach((s) => {
    const w = L.calcWeight(s, min);
    assert.ok(w > 0, 'score=' + s + ' 权重应为正');
    assert.ok(w <= 1, 'score=' + s + ' 权重的分母应 >= 1');
  });
});

console.log('\n[lottery] 概率计算 computeWeights');

test('8 人名单的概率与原型页面显示一致（合计 100%）', () => {
  const snapshot = L.makeSnapshot(ROSTER);
  const { weights, minScore, total } = L.computeWeights(snapshot);
  assert.strictEqual(minScore, -1);
  assert.strictEqual(weights.length, 8);
  assert.strictEqual(Number(total.toFixed(4)), 3.0146);

  // 原型页面显示值：4.1 / 5.1 / 6.6 / 8.3 / 16.6 / 33.2 / 9.5 / 16.6
  const expectedPrecent = [4.1, 5.1, 6.6, 8.3, 16.6, 33.2, 9.5, 16.6];
  let sum = 0;
  snapshot.forEach((s, i) => {
    const p = (weights[i] / total) * 100;
    sum += p;
    assert.ok(
      Math.abs(p - expectedPrecent[i]) < 0.06,
      s.name + ' 概率应为 ' + expectedPrecent[i] + '%，实际 ' + p.toFixed(2) + '%'
    );
  });
  assert.strictEqual(Number(sum.toFixed(1)), 100.0);
});

test('全员同分时概率均等', () => {
  const flat = [0, 1, 2, 3].map((i) => ({ sno: 'S' + i, score: 2 }));
  const { weights, total } = L.computeWeights(L.makeSnapshot(flat));
  weights.forEach((w) => assert.strictEqual(w, 1));
  weights.forEach((w) => assert.strictEqual(Number((w / total).toFixed(6)), 0.25));
});

test('名单为空时抛 EMPTY_ROSTER', () => {
  assert.throws(() => L.computeWeights([]), /EMPTY_ROSTER/);
});

console.log('\n[lottery] 随机点名 randomPick');

test('单人名单必中该人，概率 100%', () => {
  const one = [{ sno: 'X001', name: '独苗', score: 3 }];
  const r = L.randomPick(one);
  assert.strictEqual(r.picked.sno, 'X001');
  assert.strictEqual(r.probabilities[0], 1);
});

test('同一批学生无论传入顺序如何，快照与权重一致（先按学号排序）', () => {
  const shuffled = [...ROSTER].reverse();
  const a = L.randomPick(ROSTER, 12345);
  const b = L.randomPick(shuffled, 12345);
  assert.deepStrictEqual(a.picked.sno, b.picked.sno);
  assert.deepStrictEqual(a.weights, b.weights);
});

test('相同种子必然得到相同结果（确定性）', () => {
  const a = L.randomPick(ROSTER, 20261014);
  const b = L.randomPick(ROSTER, 20261014);
  assert.strictEqual(a.picked.sno, b.picked.sno);
});

test('不同种子会抽到不同的人（不是恒返回同一人）', () => {
  const seen = new Set();
  for (let seed = 0; seed < 200; seed += 1) {
    seen.add(L.randomPick(ROSTER, seed).picked.sno);
  }
  assert.ok(seen.size >= 6, '200 个种子只抽到 ' + seen.size + ' 人，分布异常');
});

test('中签者一定是名单内的人', () => {
  const snos = new Set(ROSTER.map((s) => s.sno));
  for (let seed = 0; seed < 500; seed += 1) {
    assert.ok(snos.has(L.randomPick(ROSTER, seed).picked.sno));
  }
});

test('返回的 seed 是 32 位无符号整数', () => {
  const r = L.randomPick(ROSTER);
  assert.ok(Number.isInteger(r.seed));
  assert.ok(r.seed >= 0 && r.seed <= 0xffffffff);
});

console.log('\n[lottery] 复演 replay（公平性可验证的核心）');

test('按落库种子与快照复演，必须重现同一次结果（1000 次）', () => {
  for (let i = 0; i < 1000; i += 1) {
    const first = L.randomPick(ROSTER);
    const again = L.replay(first.seed, first.snapshot);
    assert.strictEqual(
      again.picked.sno,
      first.picked.sno,
      '种子 ' + first.seed + ' 复演不一致'
    );
  }
});

test('复演结果与原始权重、概率完全一致', () => {
  const first = L.randomPick(ROSTER, 777);
  const again = L.replay(777, first.snapshot);
  assert.deepStrictEqual(again.weights, first.weights);
  assert.deepStrictEqual(again.probabilities, first.probabilities);
  assert.strictEqual(again.minScore, first.minScore);
});

test('快照传 JSON 字符串也能复演（落库形态为 TEXT）', () => {
  const first = L.randomPick(ROSTER, 888);
  const again = L.replay(888, JSON.stringify(first.snapshot));
  assert.strictEqual(again.picked.sno, first.picked.sno);
});

console.log('\n[lottery] 统计验证：积分越高被点到概率越低（题目的硬性要求）');

test('20000 次抽样中，最低分者被抽中次数显著多于最高分者', () => {
  const counts = {};
  const N = 20000;
  for (let i = 0; i < N; i += 1) {
    const sno = L.randomPick(ROSTER).picked.sno;
    counts[sno] = (counts[sno] || 0) + 1;
  }
  const lowest = counts['102401306']; // 顾思齐 -1 分
  const highest = counts['102401301']; // 陈一宁 6 分
  assert.ok(lowest > highest * 5, '最低分 ' + lowest + ' 次 vs 最高分 ' + highest + ' 次，未体现反比');
  // 理论比例 33.17 : 4.15 ≈ 8.0，给足容错区间
  const ratio = lowest / highest;
  assert.ok(ratio > 4 && ratio < 14, '实际比例 ' + ratio.toFixed(2) + '，偏离理论值 8.0 过多');
});

console.log('\n[lottery] 顺序点名 sequencePick');

test('游标为 null 时，从学号最小者开始', () => {
  const r = L.sequencePick(ROSTER, null);
  assert.strictEqual(r.next.sno, '102401301');
  assert.strictEqual(r.roundEnded, false);
});

test('按学号升序逐位推进', () => {
  const snos = L.sortBySno(ROSTER).map((s) => s.sno);
  let cursor = null;
  const visited = [];
  for (let i = 0; i < snos.length; i += 1) {
    const r = L.sequencePick(ROSTER, cursor);
    assert.strictEqual(r.roundEnded, false);
    visited.push(r.next.sno);
    cursor = r.next.sno;
  }
  assert.deepStrictEqual(visited, snos);
});

test('点到最后一位后提示本轮结束', () => {
  const last = L.sortBySno(ROSTER).pop().sno;
  const r = L.sequencePick(ROSTER, last);
  assert.strictEqual(r.next, null);
  assert.strictEqual(r.roundEnded, true);
});

test('游标失效（不在名单中）时从头开始，不抛错', () => {
  const r = L.sequencePick(ROSTER, 'NOT_EXIST');
  assert.strictEqual(r.next.sno, '102401301');
  assert.strictEqual(r.roundEnded, false);
});

test('顺序点名与随机点名结果无关（游标独立）', () => {
  L.randomPick(ROSTER, 999);
  const r = L.sequencePick(ROSTER, '102401302');
  assert.strictEqual(r.next.sno, '102401303');
});

console.log('\n──────────────────────────────');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  failures.forEach((f) => console.log('  ✗ ' + f.name + ' → ' + f.message));
  process.exit(1);
}
