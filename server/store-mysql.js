'use strict';

// MySQL 存储实现（部署用）
// 负责人：李文龙（A7）
//
// 2026-10-16：已在真实 SQLPub MySQL 8.0.41 完成建表、持久化、并发、回滚验收。
//    范围及证据见 docs/真实MySQL验收_20261016.md；其他版本和线上部署仍需验证。
//    接口与 store-memory.js 完全一致，两者行为必须对齐，否则测试结论对生产不成立。
//
// 依赖 mysql2（部署时安装：npm i mysql2）。用延迟 require，未安装时不影响内存模式运行。

const { ApiError } = require('./errors.js');
const { normalizeSno, DUP_POLICIES } = require('./store-memory.js');

/** 把驱动层异常翻译成统一错误码，避免把 SQL 细节抛给前端 */
function wrapDbError(err) {
  const code = err && err.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    code === 'ER_BAD_DB_ERROR' ||
    code === 'ER_NO_SUCH_TABLE'
  ) {
    const wrapped = new ApiError('DB_UNAVAILABLE', '数据库连接或表结构异常（' + code + '）');
    // 仅保留驱动错误码供服务端诊断，不携带原始 SQL、参数或连接凭据。
    wrapped.dbCode = code;
    return wrapped;
  }
  return err;
}

function rowToStudent(r) {
  return {
    sno: r.sno,
    name: r.name,
    major: r.major || '',
    onCallCount: Number(r.on_call_count || 0),
    score: Number(r.score || 0),
  };
}

function rowToRoll(r) {
  return {
    id: Number(r.id),
    sno: r.sno,
    mode: r.mode,
    rndSeed: r.rnd_seed === null ? null : Number(r.rnd_seed),
    minScore: r.min_score === null ? null : Number(r.min_score),
    rosterSnapshot: r.roster_snapshot,
    present: r.present === null ? null : Number(r.present),
    repeatResult: r.repeat_result,
    answerBonus: r.answer_bonus === null ? null : Number(r.answer_bonus),
    delta: r.delta === null ? null : Number(r.delta),
    settled: Number(r.settled),
    settledAt: r.settled_at ? String(r.settled_at) : null,
    calledAt: r.called_at ? String(r.called_at) : null,
  };
}

function createMysqlStore(cfg, { pool: injectedPool } = {}) {
  let mysql;
  if (!injectedPool) {
    try {
      mysql = require('mysql2/promise');
    } catch (e) {
      throw new Error(
        '未安装 mysql2。部署到 MySQL 模式前请先执行：npm i mysql2（本地开发请用 STORE=memory）'
      );
    }
  }

  const pool =
    injectedPool ||
    mysql.createPool({
      host: cfg.host,
      port: cfg.port || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      dateStrings: true, // 时间统一按字符串返回，避免时区转换造成的偏差
    });

  function makeStore(executor, inTransaction = false) {
    async function q(sql, params) {
      try {
        const [rows] = await executor.query(sql, params);
        return rows;
      } catch (err) {
        throw wrapDbError(err);
      }
    }

    return {
      async listStudents({ q: kw = '', pageSize = 0, pageNo = 1 } = {}) {
        const like = '%' + String(kw).trim() + '%';
        const where =
          String(kw).trim() === '' ? '' : ' WHERE sno LIKE ? OR name LIKE ? OR major LIKE ?';
        const params = String(kw).trim() === '' ? [] : [like, like, like];
        const totalRows = await q('SELECT COUNT(*) AS n FROM students' + where, params);
        const total = Number(totalRows[0].n);
        let sql = 'SELECT * FROM students' + where + ' ORDER BY sno ASC';
        const p = [...params];
        if (pageSize > 0) {
          sql += ' LIMIT ? OFFSET ?';
          p.push(Number(pageSize), (Math.max(1, Number(pageNo) || 1) - 1) * Number(pageSize));
        }
        const rows = await q(sql, p);
        return { rows: rows.map(rowToStudent), total };
      },

      async allStudents() {
        const rows = await q(
          'SELECT * FROM students ORDER BY sno ASC' + (inTransaction ? ' FOR UPDATE' : '')
        );
        return rows.map(rowToStudent);
      },

      async findStudent(sno) {
        const rows = await q(
          'SELECT * FROM students WHERE sno = ? LIMIT 1' + (inTransaction ? ' FOR UPDATE' : ''),
          [normalizeSno(sno)]
        );
        return rows.length ? rowToStudent(rows[0]) : null;
      },

      async upsertStudents(rows, { dupPolicy = 'update-info' } = {}) {
        if (!inTransaction) return withTransaction((tx) => tx.upsertStudents(rows, { dupPolicy }));
        if (!DUP_POLICIES.includes(dupPolicy)) {
          throw new Error('unsupported dupPolicy: ' + dupPolicy);
        }
        let imported = 0;
        let updated = 0;
        const rejected = [];
        for (const r of rows) {
          const sno = normalizeSno(r.sno);
          const name = String(r.name || '').trim();
          const major = String(r.major || '').trim();
          const existing = await q('SELECT sno FROM students WHERE sno = ? LIMIT 1 FOR UPDATE', [
            sno,
          ]);
          const exists = existing.length > 0;

          if (!exists) {
            await q(
              'INSERT INTO students (sno, name, major, on_call_count, score) VALUES (?, ?, ?, 0, 0)',
              [sno, name, major]
            );
            imported += 1;
            continue;
          }
          if (dupPolicy === 'skip') continue;
          if (dupPolicy === 'reject') {
            rejected.push({ sno, reason: '数据库已存在该学号' });
            continue;
          }
          // update-info：只更新姓名与专业，积分、点名次数与历史一律保留
          await q('UPDATE students SET name = ?, major = ? WHERE sno = ?', [name, major, sno]);
          updated += 1;
        }
        return { imported, updated, rejected };
      },

      async createRoll(record) {
        const rows = await q(
          'INSERT INTO roll_records (sno, mode, rnd_seed, min_score, roster_snapshot) VALUES (?, ?, ?, ?, ?)',
          [
            normalizeSno(record.sno),
            record.mode,
            record.rndSeed === undefined ? null : record.rndSeed,
            record.minScore === undefined ? null : record.minScore,
            record.rosterSnapshot === undefined ? null : record.rosterSnapshot,
          ]
        );
        return { id: Number(rows.insertId) };
      },

      async getRoll(id) {
        const rows = await q(
          'SELECT * FROM roll_records WHERE id = ? LIMIT 1' + (inTransaction ? ' FOR UPDATE' : ''),
          [Number(id)]
        );
        return rows.length ? rowToRoll(rows[0]) : null;
      },

      /**
       * 结算落库。用 `WHERE settled = 0` 做条件更新，靠数据库保证幂等：
       * 并发下只有一个请求能拿到 affectedRows=1，其余返回 null → 上层转 409。
       */
      async settleRoll(id, patch) {
        const res = await q(
          'UPDATE roll_records SET present = ?, repeat_result = ?, answer_bonus = ?, delta = ?, settled = 1, settled_at = CURRENT_TIMESTAMP WHERE id = ? AND settled = 0',
          [patch.present, patch.repeatResult, patch.answerBonus, patch.delta, Number(id)]
        );
        if (Number(res.affectedRows) !== 1) return null;
        return this.getRoll(id);
      },

      async applyStudentDelta(sno, { scoreDelta = 0, callCountDelta = 0 } = {}) {
        // 增量更新而非"读出来再写回去"，避免并发下互相覆盖
        await q(
          'UPDATE students SET score = score + ?, on_call_count = on_call_count + ? WHERE sno = ?',
          [scoreDelta, callCountDelta, normalizeSno(sno)]
        );
        return this.findStudent(sno);
      },

      async addScoreLogs(entries) {
        if (entries.length === 0) return;
        const values = entries.map((e) => [
          normalizeSno(e.sno),
          e.rollId === undefined ? null : e.rollId,
          e.delta,
          e.reason || '',
        ]);
        await q('INSERT INTO score_logs (sno, roll_id, delta, reason) VALUES ?', [values]);
      },

      async getScoreLogs() {
        const rows = await q('SELECT * FROM score_logs ORDER BY id ASC');
        return rows.map((r) => ({
          id: Number(r.id),
          sno: r.sno,
          rollId: r.roll_id === null ? null : Number(r.roll_id),
          delta: Number(r.delta),
          reason: r.reason || '',
          createdAt: r.created_at ? String(r.created_at) : null,
        }));
      },

      async getRanking(limit = 10) {
        const n = Number(limit);
        const sql =
          Number.isFinite(n) && n > 0
            ? 'SELECT * FROM students ORDER BY score DESC, sno ASC LIMIT ?'
            : 'SELECT * FROM students ORDER BY score DESC, sno ASC';
        const rows = await q(sql, Number.isFinite(n) && n > 0 ? [n] : []);
        return rows.map(rowToStudent);
      },

      async listRecords({ from = '', to = '', limit = 200 } = {}) {
        const where = [];
        const params = [];
        if (from) {
          where.push('called_at >= ?');
          params.push(from);
        }
        if (to) {
          where.push('called_at <= ?');
          params.push(to);
        }
        let sql = 'SELECT * FROM roll_records';
        if (where.length) sql += ' WHERE ' + where.join(' AND ');
        sql += ' ORDER BY called_at DESC';
        const n = Number(limit);
        if (Number.isFinite(n) && n > 0) {
          sql += ' LIMIT ?';
          params.push(n);
        }
        const rows = await q(sql, params);
        return rows.map(rowToRoll);
      },
    };
  }

  async function withTransaction(work) {
    let conn;
    let destroyed = false;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const result = await work(makeStore(conn, true));
      await conn.commit();
      return result;
    } catch (err) {
      if (conn) {
        try {
          await conn.rollback();
        } catch (_) {
          // 回滚失败的连接不可放回池；保留导致本次失败的原始异常。
          destroyed = true;
          conn.destroy();
        }
      }
      throw wrapDbError(err);
    } finally {
      if (conn && !destroyed) conn.release();
    }
  }

  return { ...makeStore(pool), withTransaction, close: () => pool.end() };
}

module.exports = { createMysqlStore };
