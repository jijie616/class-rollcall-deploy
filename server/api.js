'use strict';

// HTTP 接口处理层（对应接口约定 3.4.4 的 11 个端点）
// 负责人：李文龙（A7）
//
// 本层只做三件事：校验入参、调用业务模块（lottery / scorer）、读写 store。
// 业务规则一律不在这里重复实现——尤其是抽签与结算，必须唯一来源于
// lottery.js 与 scorer.js，否则前后端各算一遍就会出现两套结果。

const { ApiError } = require('./errors.js');
const Lottery = require('./lottery.js');
const Scorer = require('./scorer.js');
const { normalizeSno, DUP_POLICIES } = require('./store-memory.js');

const SNO_MAX = 20;
const NAME_MAX = 50;
const MAJOR_MAX = 50;

/** 取正整数，非法时返回默认值 */
function toPositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 校验并规整导入行。
 * 行号由前端携带（Excel 的物理行号，含表头），服务端不猜——
 * 猜错会让老师改错行。
 */
function normalizeImportRows(rows) {
  if (!Array.isArray(rows)) {
    throw new ApiError('VALIDATION_ERROR', 'rows 必须是数组');
  }
  if (rows.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'rows 为空，没有可导入的数据');
  }

  const errors = [];
  const seen = new Map(); // sno -> 首次出现的行号
  const valid = [];

  rows.forEach((raw, i) => {
    const row = toPositiveInt(raw && raw.row, i + 1);
    const sno = normalizeSno(raw && raw.sno);
    const name = String((raw && raw.name) || '').trim();
    const major = String((raw && raw.major) || '').trim();

    if (sno === '') {
      errors.push({ row, sno: '', reason: '学号为空' });
      return;
    }
    if (sno.length > SNO_MAX) {
      errors.push({ row, sno, reason: '学号超过 ' + SNO_MAX + ' 个字符' });
      return;
    }
    if (name === '') {
      errors.push({ row, sno, reason: '姓名为空' });
      return;
    }
    if (name.length > NAME_MAX) {
      errors.push({ row, sno, reason: '姓名超过 ' + NAME_MAX + ' 个字符' });
      return;
    }
    if (major.length > MAJOR_MAX) {
      errors.push({ row, sno, reason: '专业超过 ' + MAJOR_MAX + ' 个字符' });
      return;
    }
    if (seen.has(sno)) {
      errors.push({ row, sno, reason: '与第 ' + seen.get(sno) + ' 行学号重复' });
      return;
    }
    seen.set(sno, row);
    valid.push({ row, sno, name, major });
  });

  return { valid, errors };
}

/** 名单为空是硬错误：无法点名（错误码 EMPTY_ROSTER） */
function assertRosterNotEmpty(students) {
  if (!students || students.length === 0) {
    throw new ApiError('EMPTY_ROSTER', '名单为空，请先导入学生名单');
  }
}

// 接口层的调用约定：**所有处理函数只接收一个对象**，
// 由 HTTP 层把「路径参数 + 查询串 + 请求体」合并后传入。
//
// 为什么不写成 (params, body) 两个参数：那样很容易出现
// "路由参数占了第一位、请求体被丢掉"的接线错误，而且单元测试直接调函数时
// 察觉不到（因为测试是把 body 当第一个参数传的），只有走真实 HTTP 才会暴露。
// 统一成单对象后，这类错误在结构上不可能发生。

function createApi({ store }) {
  if (!store || typeof store.withTransaction !== 'function') {
    throw new TypeError('store 必须提供 withTransaction，写操作不得降级为非事务执行');
  }
  return {
    // #1 学生列表
    async listStudents({ q = '', pageSize = '', pageNo = '' } = {}) {
      return store.listStudents({
        q,
        pageSize: toPositiveInt(pageSize, 0),
        pageNo: toPositiveInt(pageNo, 1),
      });
    },

    // #2 导入干跑校验（不写库）
    async validateImport({ rows } = {}) {
      const { valid, errors } = normalizeImportRows(rows);
      if (errors.some((e) => e.reason.includes('重复'))) {
        throw new ApiError(
          'DUPLICATE_SNO_IN_FILE',
          '同一文件内存在重复学号：' +
            errors
              .filter((e) => e.reason.includes('重复'))
              .map((e) => '第 ' + e.row + ' 行 ' + e.sno)
              .join('、')
        );
      }
      const conflicts = [];
      for (const r of valid) {
        const exists = await store.findStudent(r.sno);
        if (exists) conflicts.push({ sno: r.sno, row: r.row, exists: true });
      }
      return { ok: errors.length === 0, conflicts, errors, willImport: valid.length };
    },

    // #3 导入提交
    async commitImport({ rows, dupPolicy: dupPolicyIn } = {}) {
      const { valid, errors } = normalizeImportRows(rows);
      if (errors.length > 0) {
        const dup = errors.find((e) => e.reason.includes('重复'));
        if (dup) {
          throw new ApiError(
            'DUPLICATE_SNO_IN_FILE',
            '同一文件内存在重复学号，第 ' + dup.row + ' 行 ' + dup.sno + '（' + dup.reason + '）'
          );
        }
        throw new ApiError(
          'VALIDATION_ERROR',
          '存在 ' +
            errors.length +
            ' 行非法数据，未写入任何记录：第 ' +
            errors[0].row +
            ' 行 ' +
            errors[0].reason
        );
      }
      const dupPolicy = dupPolicyIn === undefined ? 'update-info' : String(dupPolicyIn);
      if (!DUP_POLICIES.includes(dupPolicy)) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'dupPolicy 取值非法，应为 ' + DUP_POLICIES.join(' / ') + '，收到 ' + dupPolicy
        );
      }
      const result = await store.withTransaction((tx) => tx.upsertStudents(valid, { dupPolicy }));
      return { imported: result.imported, updated: result.updated, rejected: result.rejected };
    },

    // #4 随机点名（服务端抽签，前端不得参与决定中签人）
    async roll({ mode: modeIn } = {}) {
      const mode = modeIn === undefined ? 'random' : String(modeIn);
      if (mode !== 'random') {
        throw new ApiError('VALIDATION_ERROR', '本端点只处理随机点名，收到 mode=' + mode);
      }
      return store.withTransaction(async (store) => {
        const students = await store.allStudents();
        assertRosterNotEmpty(students);

        const result = Lottery.randomPick(students);
        const pickedStudent = students.find((s) => s.sno === result.picked.sno);

        const { id } = await store.createRoll({
          sno: result.picked.sno,
          mode: 'random',
          rndSeed: result.seed,
          minScore: result.minScore,
          rosterSnapshot: JSON.stringify(result.snapshot),
        });
        const updated = await store.applyStudentDelta(result.picked.sno, { callCountDelta: 1 });
        if (!updated) throw new ApiError('NOT_FOUND', '中签学生不存在，抽签未保存');

        return {
          recordId: id,
          calledAt: (await store.getRoll(id)).calledAt,
          student: {
            sno: result.picked.sno,
            name: pickedStudent ? pickedStudent.name : '',
            major: pickedStudent ? pickedStudent.major : '',
            score: pickedStudent ? pickedStudent.score : 0,
          },
          mode: 'random',
          seed: result.seed,
          minScore: result.minScore,
          total: result.total,
          probabilities: result.snapshot.map((s, i) => {
            const stu = students.find((x) => x.sno === s.sno);
            return {
              sno: s.sno,
              name: stu ? stu.name : '',
              score: s.score,
              weight: result.weights[i],
              probability: result.probabilities[i],
            };
          }),
        };
      });
    },

    // #5 顺序点名（游标由前端持有；不增加随机点名次数）
    async rollNext({ cursor: cursorIn } = {}) {
      const cursor = cursorIn === undefined || cursorIn === null ? null : String(cursorIn);
      return store.withTransaction(async (store) => {
        const students = await store.allStudents();
        assertRosterNotEmpty(students);

        const { next, roundEnded } = Lottery.sequencePick(students, cursor);
        if (next === null) {
          return { recordId: null, next: null, roundEnded: true };
        }
        const { id } = await store.createRoll({ sno: next.sno, mode: 'sequence' });
        return { recordId: id, next, roundEnded, calledAt: (await store.getRoll(id)).calledAt };
      });
    },

    // #6 积分结算（settled 标志防重复加分）
    async settleRoll({ id: idIn, present, repeat, answerBonus } = {}) {
      const id = toPositiveInt(idIn, 0);
      if (!id) throw new ApiError('VALIDATION_ERROR', '记录 ID 非法');

      return store.withTransaction(async (store) => {
        const roll = await store.getRoll(id);
        if (!roll) throw new ApiError('NOT_FOUND', '未找到点名记录 #' + id);
        if (roll.settled === 1) {
          throw new ApiError(
            'ALREADY_SETTLED',
            '该次点名已于 ' + roll.settledAt + ' 结算，不能重复加分'
          );
        }

        const student = await store.findStudent(roll.sno);
        if (!student) throw new ApiError('NOT_FOUND', '未找到学号 ' + roll.sno + ' 对应的学生');

        // 规则计算交给 scorer.js；入参校验也在那里（含 JS 类型陷阱的拦截）
        let outcome;
        try {
          outcome = Scorer.settle(
            { sno: roll.sno, currentScore: student.score },
            {
              present,
              repeat,
              answerBonus,
            }
          );
        } catch (err) {
          throw new ApiError('VALIDATION_ERROR', err.message);
        }

        const settled = await store.settleRoll(id, {
          present: outcome.deltas.present, // 1=到场 0=未到场，直接取自结算结果
          repeatResult: repeat === undefined || repeat === null ? 'none' : String(repeat),
          answerBonus: answerBonus === undefined || answerBonus === null ? 0 : answerBonus,
          delta: outcome.delta,
        });
        if (!settled) {
          // 并发下被抢先结算：同样按重复结算处理
          throw new ApiError('ALREADY_SETTLED', '该次点名已被结算，不能重复加分');
        }

        const updated = await store.applyStudentDelta(roll.sno, { scoreDelta: outcome.delta });
        if (!updated) throw new ApiError('NOT_FOUND', '学生不存在，结算未保存');

        // 积分流水按项拆分落库，便于审计与博客 3.2 的追溯说明
        const logEntries = [];
        if (outcome.deltas.present !== 0) {
          logEntries.push({ delta: outcome.deltas.present, reason: '到场' });
        }
        if (outcome.deltas.repeat !== 0) {
          logEntries.push({
            delta: outcome.deltas.repeat,
            reason: outcome.deltas.repeat > 0 ? '准确复述问题' : '未准确复述问题',
          });
        }
        if (outcome.deltas.answer !== 0) {
          logEntries.push({ delta: outcome.deltas.answer, reason: '准确回答问题' });
        }
        await store.addScoreLogs(logEntries.map((e) => ({ ...e, sno: roll.sno, rollId: id })));

        return {
          recordId: id,
          sno: roll.sno,
          deltas: outcome.deltas,
          delta: outcome.delta,
          score: updated.score,
        };
      });
    },

    // 只读恢复：同一事务读取记录与当前学生，绝不重新执行结算。
    async getRecord({ id: idIn } = {}) {
      const id = toPositiveInt(idIn, 0);
      if (!id) throw new ApiError('VALIDATION_ERROR', '记录 ID 非法');
      return store.withTransaction(async (tx) => {
        const record = await tx.getRoll(id);
        if (!record) throw new ApiError('NOT_FOUND', '点名记录不存在或服务已重启');
        const student = await tx.findStudent(record.sno);
        if (!student) throw new ApiError('NOT_FOUND', '记录对应的学生不存在');
        const settled = record.settled === 1;
        let settlement = null;
        if (settled) {
          const outcome = Scorer.settle(
            { sno: record.sno, currentScore: 0 },
            {
              present: record.present,
              repeat: record.repeatResult,
              answerBonus: record.answerBonus,
            }
          );
          settlement = {
            recordId: id,
            sno: record.sno,
            deltas: outcome.deltas,
            delta: record.delta,
            score: student.score,
          };
        }
        return {
          recordId: id,
          calledAt: record.calledAt,
          mode: record.mode,
          student,
          settled,
          settlement,
        };
      });
    },

    // #7 排行榜
    async ranking({ limit = '10' } = {}) {
      return store.getRanking(toPositiveInt(limit, 10));
    },

    // #8 完整导出数据
    async exportDetail() {
      return store.allStudents();
    },

    // #9 概率查看（与实际抽签共用同一套规则）
    async probabilities() {
      const students = await store.allStudents();
      assertRosterNotEmpty(students);
      const snapshot = Lottery.makeSnapshot(students);
      const { minScore, weights, total } = Lottery.computeWeights(snapshot);
      return {
        minScore,
        total,
        rows: snapshot.map((s, i) => {
          const stu = students.find((x) => x.sno === s.sno);
          return {
            sno: s.sno,
            name: stu ? stu.name : '',
            score: s.score,
            weight: weights[i],
            probability: weights[i] / total,
          };
        }),
      };
    },

    // #10 点名历史
    async records({ from = '', to = '', limit = '200' } = {}) {
      return store.listRecords({ from, to, limit: toPositiveInt(limit, 200) });
    },

    // #11 按种子复演（创新点 I1：公平性可验证）
    async replayRoll({ id: idIn } = {}) {
      const id = toPositiveInt(idIn, 0);
      if (!id) throw new ApiError('VALIDATION_ERROR', '记录 ID 非法');

      const roll = await store.getRoll(id);
      if (!roll) throw new ApiError('NOT_FOUND', '未找到点名记录 #' + id);
      if (roll.mode !== 'random') {
        throw new ApiError('VALIDATION_ERROR', '顺序点名没有随机种子，无法复演');
      }
      if (roll.rndSeed === null || roll.rosterSnapshot === null) {
        throw new ApiError('VALIDATION_ERROR', '该记录缺少种子或名单快照，无法复演');
      }

      let again;
      try {
        again = Lottery.replay(roll.rndSeed, roll.rosterSnapshot);
      } catch (err) {
        throw new ApiError('INTERNAL', '复演失败：' + err.message);
      }
      return {
        recordId: id,
        seed: roll.rndSeed,
        minScore: roll.minScore,
        roster: JSON.parse(roll.rosterSnapshot),
        picked: again.picked,
        recordedSno: roll.sno,
        matched: again.picked.sno === roll.sno,
        probabilities: again.probabilities,
      };
    },
  };
}

// 路由表：路径 → 处理函数。params 来自路径捕获组，query 来自查询串，body 来自请求体。
const ROUTES = [
  {
    method: 'GET',
    re: /^\/api\/roll\/(\d+)\/?$/,
    handler: 'getRecord',
    input: 'query',
    keys: ['id'],
  },
  { method: 'GET', re: /^\/api\/students\/?$/, handler: 'listStudents', input: 'query' },
  { method: 'POST', re: /^\/api\/import\/validate\/?$/, handler: 'validateImport', input: 'body' },
  { method: 'POST', re: /^\/api\/import\/commit\/?$/, handler: 'commitImport', input: 'body' },
  { method: 'POST', re: /^\/api\/roll\/?$/, handler: 'roll', input: 'body' },
  { method: 'POST', re: /^\/api\/roll\/next\/?$/, handler: 'rollNext', input: 'body' },
  {
    method: 'POST',
    re: /^\/api\/roll\/(\d+)\/settle\/?$/,
    handler: 'settleRoll',
    input: 'body',
    keys: ['id'],
  },
  {
    method: 'GET',
    re: /^\/api\/roll\/(\d+)\/replay\/?$/,
    handler: 'replayRoll',
    input: 'query',
    keys: ['id'],
  },
  { method: 'GET', re: /^\/api\/ranking\/?$/, handler: 'ranking', input: 'query' },
  { method: 'GET', re: /^\/api\/export\/detail\/?$/, handler: 'exportDetail', input: 'query' },
  { method: 'GET', re: /^\/api\/probabilities\/?$/, handler: 'probabilities', input: 'query' },
  { method: 'GET', re: /^\/api\/records\/?$/, handler: 'records', input: 'query' },
];

/** 匹配路由；未命中返回 null */
function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (m && r.method === method) {
      const params = {};
      (r.keys || []).forEach((k, i) => {
        params[k] = m[i + 1];
      });
      return { handler: r.handler, input: r.input, params };
    }
  }
  return null;
}

module.exports = { createApi, matchRoute, normalizeImportRows, ROUTES, toPositiveInt };
