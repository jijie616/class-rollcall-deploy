'use strict';

// 课堂随机点名系统 —— 加权随机抽签与顺序点名（A4 / A5）
// 负责人：李文龙
//
// 为什么放在服务端：题目把"抽取非随机"列为判 0 项。算法不在浏览器运行，
// 前端只能展示结果，"不能由 UI 指定中签人"从结构上成立。
//
// 公平性设计：
//   1. 种子来自 crypto 真随机源（不可预测）；
//   2. 抽签本身用确定性 PRNG（mulberry32），给定种子必得同一结果；
//   3. 种子 + 名单快照一并落库，任何人可用 GET /api/roll/:id/replay 原样复演，
//      复算结果与落库结果一致，即可自证非人为指定。

const crypto = require('crypto');

/** 32 位无符号随机种子（真随机源） */
function makeSeed() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

/**
 * mulberry32：确定性伪随机数生成器。
 * 同一个种子必然产生同一串数值——这是"可复演"的前提。
 * @param {number} seed 32 位无符号整数
 * @returns {() => number} 返回 [0, 1) 区间的随机数
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 中签权重：w = 1 / (1 + score - minScore)
 *
 * 这是本模块最关键的一处。最初设计为 w = 1 / (1 + score)，但题目允许扣分，
 * 积分为 -1 时直接除零，分数更低时权重会变成负数——原型阶段由杨泓发现。
 * 改为先按名单最低分平移：
 *   分母 >= 1 恒成立（不会除零、不会负权重）
 *   同一份名单内，积分越高权重严格越低
 *   全员同分时权重相等
 *
 * @param {number} score    该学生当前积分
 * @param {number} minScore 本次抽签快照中的最低积分（必须与快照取自同一时刻）
 * @returns {number} 权重，恒为正数
 */
function calcWeight(score, minScore) {
  const denom = 1 + Number(score) - Number(minScore);
  if (!Number.isFinite(denom) || denom < 1) {
    throw new RangeError(
      'calcWeight: 分母必须 >= 1，实际 score=' + score + ' minScore=' + minScore
    );
  }
  return 1 / denom;
}

/** 按学号升序排序，不改动入参。学号一律按字符串比较，避免前导零与精度问题 */
function sortBySno(students) {
  return [...students].sort((a, b) => String(a.sno).localeCompare(String(b.sno)));
}

/** 生成名单快照：只保留复演必需的两个字段，按学号升序，落库与复演共用 */
function makeSnapshot(students) {
  return sortBySno(students).map((s) => ({ sno: String(s.sno), score: Number(s.score) }));
}

/** 由快照算出全部权重、归一化概率与最低分 */
function computeWeights(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    throw new Error('EMPTY_ROSTER: 名单为空，无法抽签');
  }
  const minScore = Math.min(...snapshot.map((s) => Number(s.score)));
  const weights = snapshot.map((s) => calcWeight(s.score, minScore));
  const total = weights.reduce((a, b) => a + b, 0);
  return { minScore, weights, total };
}

/**
 * 轮盘赌抽样（O(n)）。抽签与复演共用同一段代码，保证结果必然一致。
 * @param {Array<{sno:string, score:number}>} snapshot 名单快照（已排序）
 * @param {number} seed 种子
 */
function pickFromSnapshot(snapshot, seed) {
  const { minScore, weights, total } = computeWeights(snapshot);
  const target = mulberry32(seed >>> 0)() * total;
  let acc = 0;
  let idx = snapshot.length - 1; // 兜底取最后一位，规避浮点累加误差导致的越界
  for (let i = 0; i < snapshot.length; i++) {
    acc += weights[i];
    if (target < acc) {
      idx = i;
      break;
    }
  }
  return {
    picked: snapshot[idx],
    pickedIndex: idx,
    minScore,
    weights,
    probabilities: weights.map((w) => w / total),
    total,
  };
}

/**
 * 随机点名。
 * @param {Array<{sno:string,name:string,score:number}>} students 当前名单
 * @param {number} [seed] 不传则用真随机源生成；传入即用于复演测试
 * @returns {{picked, pickedIndex, minScore, weights, probabilities, total, seed, snapshot}}
 */
function randomPick(students, seed) {
  const snapshot = makeSnapshot(students);
  const usedSeed = seed === undefined || seed === null ? makeSeed() : seed >>> 0;
  return { ...pickFromSnapshot(snapshot, usedSeed), seed: usedSeed, snapshot };
}

/**
 * 复演：给定落库的种子与名单快照，重现当次抽签结果。
 * 与 randomPick 走同一段抽样代码，因此结果必然一致。
 * @param {number} seed
 * @param {Array<{sno:string, score:number}>} snapshot
 */
function replay(seed, snapshot) {
  const normalized = Array.isArray(snapshot) ? snapshot : JSON.parse(String(snapshot));
  return pickFromSnapshot(normalized, seed);
}

/**
 * 顺序点名：按学号升序推进，游标为"上一位被点到的学号"。
 * 顺序点名不增加随机点名次数，也不受随机点名影响。
 * @param {Array} students
 * @param {string|null} cursor 上一位的学号；null 表示本轮从头开始
 * @returns {{next: object|null, roundEnded: boolean}}
 */
function sequencePick(students, cursor) {
  const list = sortBySno(students);
  if (list.length === 0) {
    throw new Error('EMPTY_ROSTER: 名单为空，无法点名');
  }
  if (cursor === null || cursor === undefined || cursor === '') {
    return { next: list[0], roundEnded: false };
  }
  const i = list.findIndex((s) => String(s.sno) === String(cursor));
  if (i === -1) {
    // 游标失效（名单被重新导入等）：本轮从头开始，不抛错
    return { next: list[0], roundEnded: false };
  }
  if (i >= list.length - 1) {
    return { next: null, roundEnded: true };
  }
  return { next: list[i + 1], roundEnded: false };
}

module.exports = {
  makeSeed,
  mulberry32,
  calcWeight,
  sortBySno,
  makeSnapshot,
  computeWeights,
  randomPick,
  replay,
  sequencePick,
};
