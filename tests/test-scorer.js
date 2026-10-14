'use strict';

// scorer.js 单元测试（A10）
// 测试函数：settle / isValidAnswerBonus / toHalf / fromHalf
//
// 数据构造思路：
//   1. 覆盖题目列出的全部计分分支：到场与未到场、复述的三种取值、
//      回答加分的档位边界（0 / 0.5 / 3）；
//   2. 重点构造 0.5 步长的组合，验证"0.5 反复累加"不产生浮点误差；
//   3. 构造负积分学生（题目允许扣分，积分会降到负数）；
//   4. 非法入参必须抛错，不能静默按 0 处理——否则前端传错档位会被悄悄吞掉。

const assert = require('assert');
const S = require('../server/scorer.js');

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

console.log('\n[scorer] 正常计分分支');

test('到场 + 准确复述 + 回答 3 → 本次 +4.5', () => {
  const r = S.settle({ sno: '102401306', currentScore: -1 }, {
    present: 1,
    repeat: 'accurate',
    answerBonus: 3,
  });
  assert.strictEqual(r.deltas.present, 1);
  assert.strictEqual(r.deltas.repeat, 0.5);
  assert.strictEqual(r.deltas.answer, 3);
  assert.strictEqual(r.delta, 4.5);
  assert.strictEqual(r.score, 3.5);
});

test('到场 + 未准确复述 + 回答 3 → 本次 +3（原型实测过的场景）', () => {
  const r = S.settle({ sno: '102401306', currentScore: -1 }, {
    present: 1,
    repeat: 'inaccurate',
    answerBonus: 3,
  });
  assert.strictEqual(r.deltas.repeat, -1);
  assert.strictEqual(r.delta, 3);
  assert.strictEqual(r.score, 2);
});

test('到场 + 未提问 + 回答 0 → 仅 +1', () => {
  const r = S.settle({ sno: 'X001', currentScore: 0 }, { present: 1, repeat: 'none', answerBonus: 0 });
  assert.strictEqual(r.delta, 1);
  assert.strictEqual(r.score, 1);
});

test('到场 + 未提问 + 回答 0.5 → +1.5', () => {
  const r = S.settle({ sno: 'X001', currentScore: 0 }, {
    present: 1,
    repeat: 'none',
    answerBonus: 0.5,
  });
  assert.strictEqual(r.delta, 1.5);
});

test('省略 repeat 与 answerBonus 时默认未提问、不加分', () => {
  const r = S.settle({ sno: 'X001', currentScore: 5 }, { present: 1 });
  assert.strictEqual(r.delta, 1);
  assert.strictEqual(r.score, 6);
});

test('未到场 → 本次 0，且忽略复述与回答加分（不发明缺席扣分）', () => {
  const r = S.settle({ sno: 'X002', currentScore: 7 }, {
    present: 0,
    repeat: 'accurate',
    answerBonus: 3,
  });
  assert.strictEqual(r.delta, 0);
  assert.strictEqual(r.score, 7);
  assert.deepStrictEqual(r.deltas, { present: 0, repeat: 0, answer: 0 });
});

console.log('\n[scorer] 负积分与总分累积');

test('负积分学生结算后积分正确回升', () => {
  const r = S.settle({ sno: 'X003', currentScore: -1 }, { present: 1, repeat: 'none' });
  assert.strictEqual(r.score, 0);
});

test('极低负积分也能正常结算', () => {
  const r = S.settle({ sno: 'X004', currentScore: -12.5 }, {
    present: 1,
    repeat: 'accurate',
    answerBonus: 1,
  });
  assert.strictEqual(r.delta, 2.5);
  assert.strictEqual(r.score, -10);
});

console.log('\n[scorer] 0.5 步长的浮点精度');

test('连续结算 20 次 +0.5 复述，结果精确等于 +10（无浮点误差）', () => {
  let score = 0;
  for (let i = 0; i < 20; i += 1) {
    const r = S.settle({ sno: 'X005', currentScore: score }, {
      present: 1,
      repeat: 'accurate',
      answerBonus: 0,
    });
    score = r.score;
  }
  // 每次 +1.5，20 次应为 30，且必须是"干净"的 0.5 倍数
  assert.strictEqual(score, 30);
  assert.strictEqual(score * 2, Math.round(score * 2));
});

test('0.5 步长反复累加不会产生 1.4999999999999998 之类的尾差', () => {
  // 直接累加浮点：0.5 + 0.5 + 0.5 在 JS 里恰好是 1.5，但 0.1 类步长不是。
  // 这里构造成"每次加 0.5、共 3 次"，验证结算链路输出的是干净的 1.5。
  let score = 0;
  for (let i = 0; i < 3; i += 1) {
    score = S.settle({ sno: 'X006', currentScore: score }, {
      present: 1,
      repeat: 'accurate',
      answerBonus: 0,
    }).score;
  }
  assert.strictEqual(score, 4.5);
  assert.strictEqual(score.toString(), '4.5');
});

test('所有返回值都是 0.5 的整数倍', () => {
  const combos = [];
  [0, 1].forEach((present) => {
    S.REPEAT_VALUES.forEach((repeat) => {
      [0, 0.5, 1, 1.5, 2, 2.5, 3].forEach((answerBonus) => {
        combos.push({ present, repeat, answerBonus });
      });
    });
  });
  combos.forEach((c) => {
    const r = S.settle({ sno: 'X008', currentScore: 1.5 }, c);
    assert.strictEqual(r.delta * 2, Math.round(r.delta * 2), 'delta 不是 0.5 倍数：' + r.delta);
    assert.strictEqual(r.score * 2, Math.round(r.score * 2), 'score 不是 0.5 倍数：' + r.score);
    assert.ok(Number.isFinite(r.delta) && Number.isFinite(r.score));
  });
});

console.log('\n[scorer] 回答加分档位校验 isValidAnswerBonus');

test('合法档位 0 / 0.5 / 1 / 1.5 / 2 / 2.5 / 3 全部通过', () => {
  [0, 0.5, 1, 1.5, 2, 2.5, 3].forEach((v) => {
    assert.strictEqual(S.isValidAnswerBonus(v), true, v + ' 应合法');
  });
});

test('越界与非法步长被拒绝', () => {
  [-0.5, 3.5, 0.3, 1.2, 4, NaN, Infinity].forEach((v) => {
    assert.strictEqual(S.isValidAnswerBonus(v), false, String(v) + ' 应非法');
  });
});

test('JS 类型陷阱：null / undefined / 字符串 / 布尔被拒绝（Number(null) === 0）', () => {
  [null, undefined, '0', '1.5', '', false, true, [], {}].forEach((v) => {
    assert.strictEqual(S.isValidAnswerBonus(v), false, JSON.stringify(v) + ' 应非法');
  });
});

console.log('\n[scorer] parsePresent 严格解析到场状态');

test('接受 1 / 0 / true / false', () => {
  assert.strictEqual(S.parsePresent(1), 1);
  assert.strictEqual(S.parsePresent(0), 0);
  assert.strictEqual(S.parsePresent(true), 1);
  assert.strictEqual(S.parsePresent(false), 0);
});

test('拒绝 null / undefined / 字符串 / 其他数字（漏传字段不能变成"未到场"）', () => {
  [null, undefined, '1', '0', '', 2, -1, NaN, []].forEach((v) => {
    assert.throws(() => S.parsePresent(v), RangeError, JSON.stringify(v) + ' 应抛错');
  });
});

console.log('\n[scorer] 非法入参必须抛错（不能静默按 0 处理）');

test('present 不是 0/1/true/false 时抛 RangeError', () => {
  assert.throws(() => S.settle({ sno: 'X009', currentScore: 0 }, { present: 2 }), RangeError);
  assert.throws(() => S.settle({ sno: 'X009', currentScore: 0 }, { present: 'yes' }), RangeError);
  assert.throws(() => S.settle({ sno: 'X009', currentScore: 0 }, { present: null }), RangeError);
  assert.throws(() => S.settle({ sno: 'X009', currentScore: 0 }, {}), RangeError);
});

test('answerBonus 传字符串也要拒绝（不做隐式类型转换）', () => {
  assert.throws(
    () => S.settle({ sno: 'X009', currentScore: 0 }, { present: 1, answerBonus: '1.5' }),
    RangeError
  );
});

test('repeat 取值非法时抛 RangeError', () => {
  assert.throws(
    () => S.settle({ sno: 'X009', currentScore: 0 }, { present: 1, repeat: 'maybe' }),
    RangeError
  );
});

test('answerBonus 越界或步长错误时抛 RangeError', () => {
  assert.throws(
    () => S.settle({ sno: 'X009', currentScore: 0 }, { present: 1, answerBonus: 3.5 }),
    RangeError
  );
  assert.throws(
    () => S.settle({ sno: 'X009', currentScore: 0 }, { present: 1, answerBonus: 0.3 }),
    RangeError
  );
});

test('roll.currentScore 缺失或类型不对时抛 TypeError', () => {
  assert.throws(() => S.settle({ sno: 'X009' }, { present: 1 }), TypeError);
  assert.throws(() => S.settle({ sno: 'X009', currentScore: 'abc' }, { present: 1 }), TypeError);
  assert.throws(() => S.settle({ sno: 'X009', currentScore: null }, { present: 1 }), TypeError);
  assert.throws(() => S.settle({ sno: 'X009', currentScore: NaN }, { present: 1 }), TypeError);
});

test('roll.sno 缺失时抛 TypeError', () => {
  assert.throws(() => S.settle({ currentScore: 0 }, { present: 1 }), TypeError);
});

console.log('\n[scorer] 半分换算工具函数');

test('toHalf / fromHalf 互为逆运算且无误差', () => {
  [0, 0.5, 1, 1.5, 2, 2.5, 3, -1, -3.5, 12.5].forEach((v) => {
    assert.strictEqual(S.fromHalf(S.toHalf(v)), v, v + ' 换算不一致');
  });
});

test('toHalf 拒绝非数字', () => {
  assert.throws(() => S.toHalf('abc'), RangeError);
  assert.throws(() => S.toHalf(NaN), RangeError);
});

console.log('\n──────────────────────────────');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  failures.forEach((f) => console.log('  ✗ ' + f.name + ' → ' + f.message));
  process.exit(1);
}
