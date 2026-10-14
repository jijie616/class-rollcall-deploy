'use strict';

// 内存存储实现（开发与测试用）
// 负责人：李文龙（A7）
//
// 为什么需要它：MySQL 主机的连通性在部署前无法验证，而接口与业务逻辑必须能先跑通、
// 先测过。把数据访问抽成同一套接口后，内存实现用于测试与离线演示，
// MySQL 实现在部署时替换——两者行为必须一致，否则测试就失去意义。
//
// 接口清单（store-mysql.js 必须实现同一套）：
//   listStudents({ q, pageSize, pageNo }) -> { rows, total }
//   findStudent(sno)                      -> Student | null
//   allStudents()                         -> Student[]（按 sno 升序）
//   upsertStudents(rows, { dupPolicy })   -> { imported, updated, rejected }
//   createRoll(record)                    -> { id }
//   getRoll(id)                           -> Roll | null
//   settleRoll(id, patch)                 -> Roll | null（已结算返回 null，供上层转 409）
//   applyStudentDelta(sno, {scoreDelta, callCountDelta}) -> Student | null
//   addScoreLogs(entries)                 -> void
//   getScoreLogs()                        -> Log[]
//   getRanking(limit)                     -> Student[]
//   listRecords({ from, to, limit })      -> Roll[]
//   withTransaction(work)                -> Promise（work 接收事务专用 store）

const DUP_POLICIES = Object.freeze(['update-info', 'reject', 'skip']);

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

/** 学号一律按字符串处理，禁止 Number() 转换（会丢前导零、超 15 位会踩浮点精度） */
function normalizeSno(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

function createMemoryStore(seedStudents = []) {
  const data = { students: new Map(), rolls: new Map(), scoreLogs: [], rollSeq: 0, logSeq: 0 };
  const store = buildMemoryStore(data);
  seedStudents.forEach((row) => {
    const sno = normalizeSno(row.sno);
    data.students.set(sno, {
      sno,
      name: String(row.name || '').trim(),
      major: String(row.major || '').trim(),
      onCallCount: Number(row.onCallCount || 0),
      score: Number(row.score || 0),
    });
  });

  // 写操作在私有副本上运行；失败时丢弃副本，成功时一次发布。
  // 队列保证并发事务不会覆盖彼此；普通读取只看到已提交的数据。
  let queue = Promise.resolve();
  store.withTransaction = (work) => {
    const result = queue.then(async () => {
      const draft = {
        students: new Map([...data.students].map(([k, v]) => [k, clone(v)])),
        rolls: new Map([...data.rolls].map(([k, v]) => [k, clone(v)])),
        scoreLogs: clone(data.scoreLogs),
        rollSeq: data.rollSeq,
        logSeq: data.logSeq,
      };
      const value = await work(buildMemoryStore(draft));
      Object.assign(data, draft);
      return value;
    });
    queue = result.catch(() => {});
    return result;
  };
  return store;
}

function buildMemoryStore(data) {
  function insertStudent(row) {
    const sno = normalizeSno(row.sno);
    data.students.set(sno, {
      sno,
      name: String(row.name || '').trim(),
      major: String(row.major || '').trim(),
      onCallCount: Number(row.onCallCount || 0),
      score: Number(row.score || 0),
    });
  }

  function sorted() {
    return [...data.students.values()].sort((a, b) => a.sno.localeCompare(b.sno));
  }

  return {
    /** 学生列表：支持关键字搜索与分页 */
    async listStudents({ q = '', pageSize = 0, pageNo = 1 } = {}) {
      const kw = String(q).trim().toLowerCase();
      let rows = sorted();
      if (kw) {
        rows = rows.filter(
          (s) =>
            s.sno.toLowerCase().includes(kw) ||
            s.name.toLowerCase().includes(kw) ||
            s.major.toLowerCase().includes(kw)
        );
      }
      const total = rows.length;
      if (pageSize > 0) {
        const p = Math.max(1, Number(pageNo) || 1);
        rows = rows.slice((p - 1) * pageSize, p * pageSize);
      }
      return { rows: clone(rows), total };
    },

    async allStudents() {
      return clone(sorted());
    },

    async findStudent(sno) {
      const s = data.students.get(normalizeSno(sno));
      return s ? clone(s) : null;
    },

    /**
     * 导入名单。
     * 与库内已有学号重复时按 dupPolicy 处理：
     *   update-info（默认，同步约定）：只更新姓名与专业，保留积分、点名次数与历史
     *   skip：跳过该行
     *   reject：整批拒绝
     */
    async upsertStudents(rows, { dupPolicy = 'update-info' } = {}) {
      if (!DUP_POLICIES.includes(dupPolicy)) {
        throw new Error('unsupported dupPolicy: ' + dupPolicy);
      }
      let imported = 0;
      let updated = 0;
      const rejected = [];

      for (const row of rows) {
        const sno = normalizeSno(row.sno);
        const existing = data.students.get(sno);
        if (!existing) {
          insertStudent(row);
          imported += 1;
          continue;
        }
        if (dupPolicy === 'skip') continue;
        if (dupPolicy === 'reject') {
          rejected.push({ sno, reason: '数据库已存在该学号' });
          continue;
        }
        // update-info：只覆盖姓名与专业
        existing.name = String(row.name || '').trim();
        existing.major = String(row.major || '').trim();
        updated += 1;
      }
      return { imported, updated, rejected };
    },

    async createRoll(record) {
      data.rollSeq += 1;
      const id = data.rollSeq;
      data.rolls.set(id, {
        id,
        sno: normalizeSno(record.sno),
        mode: record.mode,
        rndSeed: record.rndSeed === undefined ? null : record.rndSeed,
        minScore: record.minScore === undefined ? null : record.minScore,
        rosterSnapshot: record.rosterSnapshot === undefined ? null : record.rosterSnapshot,
        present: null,
        repeatResult: null,
        answerBonus: null,
        delta: null,
        settled: 0,
        settledAt: null,
        calledAt: record.calledAt || new Date().toISOString(),
      });
      return { id };
    },

    async getRoll(id) {
      const r = data.rolls.get(Number(id));
      return r ? clone(r) : null;
    },

    /** 结算落库。已结算过则返回 null（上层据此转 ALREADY_SETTLED） */
    async settleRoll(id, patch) {
      const key = Number(id);
      const r = data.rolls.get(key);
      if (!r || r.settled === 1) return null;
      r.present = patch.present;
      r.repeatResult = patch.repeatResult;
      r.answerBonus = patch.answerBonus;
      r.delta = patch.delta;
      r.settled = 1;
      r.settledAt = new Date().toISOString();
      return clone(r);
    },

    /** 更新学生积分与随机点名次数（增量写入，避免覆盖并发修改） */
    async applyStudentDelta(sno, { scoreDelta = 0, callCountDelta = 0 } = {}) {
      const s = data.students.get(normalizeSno(sno));
      if (!s) return null;
      s.score = Math.round((s.score + scoreDelta) * 100) / 100;
      s.onCallCount += callCountDelta;
      return clone(s);
    },

    async addScoreLogs(entries) {
      for (const e of entries) {
        data.logSeq += 1;
        data.scoreLogs.push({
          id: data.logSeq,
          sno: normalizeSno(e.sno),
          rollId: e.rollId === undefined ? null : e.rollId,
          delta: e.delta,
          reason: e.reason || '',
          createdAt: new Date().toISOString(),
        });
      }
    },

    async getScoreLogs() {
      return clone(data.scoreLogs);
    },

    async getRanking(limit = 10) {
      // 积分降序；同分按学号升序（契约 3.4.4 #7）
      const rows = sorted().sort((a, b) => b.score - a.score || a.sno.localeCompare(b.sno));
      const n = Number(limit);
      return clone(Number.isFinite(n) && n > 0 ? rows.slice(0, n) : rows);
    },

    async listRecords({ from = '', to = '', limit = 200 } = {}) {
      let rows = [...data.rolls.values()];
      if (from) rows = rows.filter((r) => r.calledAt >= from);
      if (to) rows = rows.filter((r) => r.calledAt <= to);
      rows.sort((a, b) => String(b.calledAt).localeCompare(String(a.calledAt)));
      const n = Number(limit);
      return clone(Number.isFinite(n) && n > 0 ? rows.slice(0, n) : rows);
    },
  };
}

module.exports = { createMemoryStore, normalizeSno, DUP_POLICIES };
