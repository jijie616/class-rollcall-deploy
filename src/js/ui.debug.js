// 临时调试 UI，正式 UI 交付后替换。实现接口 v2.1：八个事件与导入预览。
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function table(rows, ranking = false) {
  if (!rows.length) return '<p class="empty">暂无数据</p>';
  return (
    '<table><thead><tr>' +
    (ranking ? '<th>名次</th>' : '') +
    '<th>学号</th><th>姓名</th><th>专业</th><th>积分</th><th>随机次数</th></tr></thead><tbody>' +
    rows
      .map(
        (r, i) =>
          '<tr>' +
          (ranking ? '<td>' + (i + 1) + '</td>' : '') +
          [r.sno, r.name, r.major || '-', r.score, r.onCallCount]
            .map((v) => '<td>' + esc(v) + '</td>')
            .join('') +
          '</tr>'
      )
      .join('') +
    '</tbody></table>'
  );
}

export function createDebugUi(root) {
  let handlers;
  const state = {
    mode: 'random',
    student: null,
    settlement: null,
    error: null,
    students: [],
    total: 0,
    ranking: null,
    preview: null,
    busy: false,
  };

  function paint() {
    const s = state.student;
    const st = state.settlement;
    const p = state.preview;
    const disabled = state.busy ? 'disabled' : '';
    root.innerHTML = `<div class="dbg">
      <h1>课堂随机点名系统 · 调试界面</h1>
      <p class="warn">这是本地调试用的临时界面，正式界面由杨泓交付后替换。</p>
      <div class="bar">
        <button data-act="mode" data-value="random" ${state.busy || state.mode === 'random' ? 'disabled' : ''}>随机点名</button>
        <button data-act="mode" data-value="sequence" ${state.busy || state.mode === 'sequence' ? 'disabled' : ''}>按学号顺序</button>
        <button data-act="roll" class="primary" ${disabled}>开始点名</button>
        <button data-act="ranking" ${disabled}>查看排行榜</button>
        <button data-act="export" ${disabled}>导出详单</button>
        <label class="file">导入名单 Excel<input type="file" data-act="import" accept=".xlsx,.xls,.csv" ${disabled}></label>
      </div>
      ${state.error ? `<div class="error"><b>${esc(state.error.code)}</b>：${esc(state.error.message)}</div>` : ''}
      ${
        p
          ? `<div class="panel" id="importPreview"><h2>确认导入</h2>
        <p>${esc(p.fileName)}：共 ${esc(p.total)} 人，其中 ${p.conflicts.length} 个学号已存在。</p>
        <p>确认后更新已有学生的姓名与专业，保留积分、随机次数和历史；此时尚未写入数据。</p>
        ${p.conflicts.length ? `<p>已有学号：${p.conflicts.map((c) => esc(c.sno)).join('、')}</p>` : ''}
        ${p.warnings.map((w) => `<p class="warn">${esc(w.reason)}</p>`).join('')}
        <button data-act="import-confirm" ${disabled}>确认导入</button>
        <button data-act="import-cancel" ${disabled}>取消导入</button></div>`
          : ''
      }
      <div class="panel"><h2>点名结果</h2>
        ${s ? `<div class="student"><span class="name">${esc(s.name)}</span><span class="meta">${esc(s.sno)} · ${esc(s.major || '专业未填')}</span></div>` : '<p class="empty">尚未点名</p>'}
        ${
          s
            ? `<div class="settle">
          <button data-act="settle" data-present="1" data-repeat="none" data-bonus="0" ${disabled}>到场（未提问）+1</button>
          <button data-act="settle" data-present="1" data-repeat="accurate" data-bonus="0" ${disabled}>到场+准确复述 +1.5</button>
          <button data-act="settle" data-present="1" data-repeat="inaccurate" data-bonus="0" ${disabled}>到场+未复述 +0</button>
          <button data-act="settle" data-present="1" data-repeat="accurate" data-bonus="3" ${disabled}>到场+复述+回答3 +4.5</button>
          <button data-act="settle" data-present="0" data-repeat="none" data-bonus="0" ${disabled}>未到场 +0</button>
        </div>`
            : ''
        }
        ${st ? `<div class="result">本次 <b>${st.delta > 0 ? '+' : ''}${esc(st.delta)}</b>，当前总积分 <b>${esc(st.score)}</b> （到场 ${esc(st.deltas.present)} / 复述 ${esc(st.deltas.repeat)} / 回答 ${esc(st.deltas.answer)}）</div>` : ''}
      </div>
      <div class="panel"><h2>学生名单 <small id="rosterTotal">共 ${state.total} 人</small></h2><div id="roster" class="roster">${table(state.students)}</div></div>
      <div class="panel"><h2>积分排行榜</h2><div id="ranking" class="roster">${state.ranking ? table(state.ranking, true) : '<p class="empty">点击上方“查看排行榜”</p>'}</div></div>
    </div>`;
  }

  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t) || !handlers || state.busy || t.disabled) return;
    const act = t.getAttribute('data-act');
    if (act === 'mode') {
      state.mode = t.getAttribute('data-value');
      handlers.onModeChanged(state.mode);
      paint();
    } else if (act === 'roll') handlers.onRollRequested();
    else if (act === 'ranking') handlers.onRankingRequested(10);
    else if (act === 'export') handlers.onExportRequested();
    else if (act === 'import-confirm') handlers.onImportConfirmed();
    else if (act === 'import-cancel') handlers.onImportCancelled();
    else if (act === 'settle')
      handlers.onScoreSubmitted({
        present: Number(t.getAttribute('data-present')),
        repeat: t.getAttribute('data-repeat'),
        answerBonus: Number(t.getAttribute('data-bonus')),
      });
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!state.busy && handlers && t.getAttribute('data-act') === 'import' && t.files?.[0]) {
      handlers.onImportRequested(t.files[0]);
    }
  });

  return {
    init(h) {
      handlers = h;
      paint();
    },
    renderStudents(rows, total) {
      state.students = rows;
      state.total = total;
      paint();
    },
    renderRollResult(r) {
      state.student = r.student;
      state.settlement = null;
      state.error = null;
      paint();
    },
    renderSettlement(s) {
      state.settlement = s;
      state.error = null;
      paint();
    },
    renderRanking(rows) {
      state.ranking = rows;
      state.error = null;
      paint();
    },
    renderImportPreview(preview) {
      state.preview = preview;
      state.error = null;
      paint();
    },
    renderError(code, message) {
      state.error = { code, message };
      paint();
    },
    setBusy(busy) {
      state.busy = !!busy;
      paint();
    },
  };
}
