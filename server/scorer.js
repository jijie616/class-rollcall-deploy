'use strict';

// 课堂随机点名系统 —— 积分结算引擎（A6）
// 负责人：李文龙
//
// 规则来源：题目 Part·1 1.1（5）+ 接口约定 3.4.6 定稿的业务规则
//   · 初始积分 0
//   · 点到且到场 +1
//   · 准确复述所提问题 +0.5；未准确复述 -1；未提问不评（0）
//   · 准确回答问题 +0.5 ~ 3（0.5 步长，0 表示未获回答分）
//   · 未到场 +0，并跳过复述与回答评分（题目未规定缺席扣分，不自行发明）
//
// 数值约定：所有分值都是 0.5 的整数倍。内部按"半分"整数运算、出口再除以 2，
// 避免 0.5 反复累加产生浮点误差（例如 0.5 累加 6 次不等于 3 的问题）。
//
// 防重复结算：由调用方（server/api.js）依据 roll_records.settled 标志把关，
// 重复请求返回 409 ALREADY_SETTLED；本模块本身是纯函数，不触碰数据库。

const RULES = Object.freeze({
  PRESENT: 1, // 到场 +1
  ABSENT: 0, // 未到场 +0
  REPEAT_ACCURATE: 0.5, // 准确复述 +0.5
  REPEAT_INACCURATE: -1, // 未准确复述 -1
  REPEAT_NONE: 0, // 未提问，不评复述
  ANSWER_MIN: 0,
  ANSWER_MAX: 3,
  ANSWER_STEP: 0.5,
});

const REPEAT_VALUES = Object.freeze(['accurate', 'inaccurate', 'none']);

/** 分值 → 半分整数（规避浮点误差） */
function toHalf(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) {
    throw new RangeError('toHalf: 分值非法 ' + x);
  }
  return Math.round(n * 2);
}

/** 半分整数 → 分值 */
function fromHalf(h) {
  return h / 2;
}

/**
 * 校验回答加分是否落在允许档位（0 ~ 3，0.5 步长）。
 *
 * 注意这里**必须校验类型**，不能只做数值范围判断：
 * `Number(null) === 0`、`Number('') === 0`、`Number(false) === 0`、`Number([]) === 0`
 * 都是 JS 的经典陷阱，只比范围会让这些值冒充合法的 0 分溜过去。
 * 用半分整数判定步长，避免 1.5 * 2 之类的小数误差误判。
 */
function isValidAnswerBonus(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < RULES.ANSWER_MIN || v > RULES.ANSWER_MAX) return false;
  const half = v * 2;
  return Math.abs(half - Math.round(half)) < 1e-9;
}

/**
 * 严格解析"是否到场"。只接受 1/0 或 true/false。
 * 同样不能只做 Number() 转换——`Number(null) === 0` 会把"字段漏传"悄悄变成
 * "未到场"，进而把该学生的本次得分清零，属于静默数据损坏。
 */
function parsePresent(v) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  throw new RangeError('settle: present 只能是 0 / 1 / true / false，收到 ' + JSON.stringify(v));
}

/**
 * 结算一次点名。
 * @param {{sno: string, currentScore: number}} roll 点名记录；currentScore 由服务端
 *        在结算事务内读取（不在前端计算，避免被篡改）
 * @param {{present: 0|1, repeat?: 'accurate'|'inaccurate'|'none', answerBonus?: number}} input
 * @returns {{deltas: {present: number, repeat: number, answer: number}, delta: number, score: number}}
 *          delta 为本次总增量，score 为结算后的总积分
 */
function settle(roll, input) {
  if (!roll || typeof roll.sno !== 'string' || roll.sno === '') {
    throw new TypeError('settle: roll.sno 必填');
  }
  // 同样要求真实数字类型：currentScore 由服务端从数据库读出，
  // 若因字段名写错而取到 undefined，绝不能静默按 0 处理（会覆盖学生的真实积分）。
  if (typeof roll.currentScore !== 'number' || !Number.isFinite(roll.currentScore)) {
    throw new TypeError('settle: roll.currentScore 必须是有限数字，收到 ' + String(roll.currentScore));
  }
  const currentScore = roll.currentScore;

  const src = input || {};
  const present = parsePresent(src.present);

  const repeat = src.repeat === undefined || src.repeat === null ? 'none' : String(src.repeat);
  if (!REPEAT_VALUES.includes(repeat)) {
    throw new RangeError('settle: repeat 取值非法，应为 ' + REPEAT_VALUES.join(' / '));
  }

  // 未提供则默认 0（未获回答分）；提供了就必须是严格的 0~3 半档数值
  let answerBonus = 0;
  if (src.answerBonus !== undefined && src.answerBonus !== null) {
    if (!isValidAnswerBonus(src.answerBonus)) {
      throw new RangeError(
        'settle: answerBonus 必须是 0 ~ 3 之间的 0.5 档位，收到 ' + JSON.stringify(src.answerBonus)
      );
    }
    answerBonus = src.answerBonus;
  }

  // 未到场：+0，且跳过复述与回答评分
  if (present === 0) {
    return {
      deltas: { present: RULES.ABSENT, repeat: 0, answer: 0 },
      delta: 0,
      score: fromHalf(toHalf(currentScore)),
    };
  }

  let repeatDelta = RULES.REPEAT_NONE;
  if (repeat === 'accurate') repeatDelta = RULES.REPEAT_ACCURATE;
  else if (repeat === 'inaccurate') repeatDelta = RULES.REPEAT_INACCURATE;

  const sumHalf = toHalf(RULES.PRESENT) + toHalf(repeatDelta) + toHalf(answerBonus);
  return {
    deltas: {
      present: RULES.PRESENT,
      repeat: fromHalf(toHalf(repeatDelta)),
      answer: fromHalf(toHalf(answerBonus)),
    },
    delta: fromHalf(sumHalf),
    score: fromHalf(toHalf(currentScore) + sumHalf),
  };
}

module.exports = {
  RULES,
  REPEAT_VALUES,
  settle,
  parsePresent,
  toHalf,
  fromHalf,
  isValidAnswerBonus,
};
