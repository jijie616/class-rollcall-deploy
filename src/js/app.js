// 主控状态机（A8）
// 负责人：李文龙
//
// 职责：把「用户操作 → 调接口 → 更新界面」串起来，是唯一允许调用所有模块的地方。
// 界面渲染全部委托给 ui.js（B4 杨泓），本文件不直接操作 DOM——
// 这样前端布局改版不需要动主控逻辑，两人可以并行开发。
//
// 与 ui.js 的契约见分工报告 3.4.2：
//   ui.init(handlers) 注入六个事件回调，app 侧调用 render* 系列渲染入口。

import { ApiError } from './api.js';

export function createApp({ ui, api, importer, xlsx }) {
  if (!ui || typeof ui.init !== 'function') {
    throw new TypeError('createApp: 需要 ui 对象（含 init 方法）');
  }
  if (!api) throw new TypeError('createApp: 需要 api 客户端');

  const state = {
    mode: 'random', // 'random' | 'sequence'
    cursor: null, // 顺序点名游标：上一位被点到的学号
    students: [],
    total: 0,
    ranking: [],
    lastRoll: null, // { recordId, student, mode }
    lastSettlement: null,
    pendingImport: null,
    busy: false,
  };

  /** 统一的错误出口：翻译成人能看懂的文案后交给界面 */
  function reportError(err) {
    const code = err instanceof ApiError ? err.code : 'INTERNAL';
    const text = err instanceof ApiError ? err.message : '发生未知错误，请重试';
    ui.renderError(code, text);
  }

  /** 包一层：进入忙状态 → 执行 → 退出忙状态，异常统一交给 reportError */
  async function run(task) {
    if (state.busy) return null;
    state.busy = true;
    ui.setBusy(true);
    try {
      return await task();
    } catch (err) {
      reportError(err);
      return null;
    } finally {
      state.busy = false;
      ui.setBusy(false);
    }
  }

  async function refreshStudents() {
    const r = await api.listStudents({});
    state.students = r.rows;
    state.total = r.total;
    ui.renderStudents(r.rows, r.total);
    return r;
  }

  const handlers = {
    // 选文件只解析、干跑校验和预览；确认回调才允许写入。
    async onImportRequested(file) {
      if (!file) return;
      await run(async () => {
        state.pendingImport = null;
        if (typeof ui.renderImportPreview !== 'function') {
          ui.renderError('INTERNAL', '界面未实现导入确认，未写入任何数据');
          return;
        }
        ui.renderImportPreview(null);
        if (!importer || !xlsx) {
          ui.renderError('INTERNAL', '导入功能未就绪：Excel 解析库未加载');
          return;
        }
        const parsed = await importer.parseFile(file, xlsx);
        if (parsed.errors.length > 0) {
          const first = parsed.errors[0];
          const code = first.reason.includes('重复') ? 'DUPLICATE_SNO_IN_FILE' : 'VALIDATION_ERROR';
          ui.renderError(
            code,
            '名单存在问题，共 ' +
              parsed.errors.length +
              ' 处：第 ' +
              first.row +
              ' 行 ' +
              first.reason
          );
          return;
        }
        const validation = await api.validateImport({ rows: parsed.rows });
        if (!validation.ok || validation.errors.length > 0) {
          const first = validation.errors[0];
          ui.renderError(
            'VALIDATION_ERROR',
            first ? '第 ' + first.row + ' 行：' + first.reason : '名单校验失败'
          );
          return;
        }
        state.pendingImport = {
          rows: parsed.rows,
          fileName: file.name || '学生名单',
          total: parsed.rows.length,
          conflicts: validation.conflicts,
          warnings: parsed.warnings,
        };
        ui.renderImportPreview({
          fileName: state.pendingImport.fileName,
          total: state.pendingImport.total,
          conflicts: validation.conflicts,
          warnings: parsed.warnings,
        });
      });
    },

    async onImportConfirmed() {
      await run(async () => {
        const pending = state.pendingImport;
        if (!pending) {
          ui.renderError('VALIDATION_ERROR', '请先选择并校验名单，再确认导入');
          return;
        }
        await api.commitImport({ rows: pending.rows, dupPolicy: 'update-info' });
        // 提交成功立即清掉待提交数据，刷新失败时也不会重复导入。
        state.pendingImport = null;
        ui.renderImportPreview(null);
        await refreshStudents();
      });
    },

    async onImportCancelled() {
      if (state.busy) return;
      state.pendingImport = null;
      if (typeof ui.renderImportPreview === 'function') ui.renderImportPreview(null);
    },

    async onModeChanged(mode) {
      if (state.busy) return;
      if (mode !== 'random' && mode !== 'sequence') {
        ui.renderError('VALIDATION_ERROR', '不支持的点名模式：' + mode);
        return;
      }
      state.mode = mode;
      // 随机点名不影响顺序模式的进度，只有顺序轮次结束才重置。
    },

    // 点名：随机模式走 /roll，顺序模式走 /roll/next
    async onRollRequested() {
      await run(async () => {
        if (state.students.length === 0) {
          ui.renderError('EMPTY_ROSTER', '名单为空，请先导入学生名单');
          return;
        }
        if (state.mode === 'random') {
          const r = await api.roll({ mode: 'random' });
          state.lastRoll = { recordId: r.recordId, student: r.student, mode: 'random' };
          state.lastSettlement = null;
          ui.renderRollResult({ student: r.student, mode: 'random', recordId: r.recordId });
          await refreshStudents();
          return;
        }
        const r = await api.rollNext({ cursor: state.cursor });
        if (r.next === null) {
          ui.renderError('VALIDATION_ERROR', '本轮顺序点名已完成，可重新开始新一轮');
          state.cursor = null;
          return;
        }
        state.cursor = r.next.sno;
        state.lastRoll = { recordId: r.recordId, student: r.next, mode: 'sequence' };
        state.lastSettlement = null;
        ui.renderRollResult({ student: r.next, mode: 'sequence', recordId: r.recordId });
      });
    },

    // 登记课堂表现并结算
    async onScoreSubmitted(payload) {
      await run(async () => {
        if (!state.lastRoll) {
          ui.renderError('VALIDATION_ERROR', '请先点名，再登记表现');
          return;
        }
        const r = await api.settleRoll({
          id: state.lastRoll.recordId,
          present: payload.present,
          repeat: payload.repeat,
          answerBonus: payload.answerBonus,
        });
        state.lastSettlement = r;
        // 结算后本地同步该学生的积分，避免"界面数字与服务端不一致"
        const idx = state.students.findIndex((s) => s.sno === r.sno);
        if (idx >= 0) state.students[idx].score = r.score;
        ui.renderSettlement({
          deltas: r.deltas,
          delta: r.delta,
          score: r.score,
          settled: true,
        });
      });
    },

    async onRankingRequested(limit) {
      await run(async () => {
        const rows = await api.ranking({ limit: limit || 10 });
        state.ranking = rows;
        ui.renderRanking(rows);
      });
    },

    // 导出详单：先向服务端要全量最新数据，再交给 exporter 生成文件
    async onExportRequested() {
      await run(async () => {
        const rows = await api.exportDetail();
        if (!exporterRef || typeof exporterRef.exportDetail !== 'function') {
          ui.renderError('INTERNAL', '导出功能未就绪：导出模块未加载');
          return;
        }
        exporterRef.exportDetail(rows);
      });
    },
  };

  // 导出模块由外部注入（B3 杨泓负责），这里只持有引用
  let exporterRef = null;

  /** 启动：注入回调、拉首屏数据 */
  async function start() {
    ui.init(handlers);
    await run(() => refreshStudents());
  }

  return {
    start,
    handlers,
    state,
    setExporter(exporter) {
      exporterRef = exporter;
    },
    /** 供调试与测试读取的内部方法 */
    _refreshStudents: refreshStudents,
  };
}
