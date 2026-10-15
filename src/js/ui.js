// UI 只持有展示状态，通过主控注入的回调上报操作，不直接调用接口。
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
const signed = (value) => `${value > 0 ? '+' : ''}${value}`;

export function createUi(document, chart) {
  const get = (id) => document.getElementById(id);
  let handlers;
  let busy = false;
  let mode = 'random';
  let lastRoll = null;
  let settled = false;
  let calls = 0;
  let preview = null;
  let previousFocus = null;
  let recoveryPending = false;
  let studentPage = { pageNo: 1, pageSize: 10, total: 0 };
  const pageInfo = {
    classroom: ['课堂点名', '从一次公平点名开始，让课堂参与有迹可循。'],
    students: ['学生名单', '把名单整理好，让每位同学都参与其中。'],
    ranking: ['积分排行榜', '看见每一份参与，也看见每一次进步。'],
  };

  function openDialog(id) {
    const dialog = get(id);
    if (!dialog.open) {
      previousFocus = document.activeElement;
      dialog.showModal();
    }
  }

  function closeDialog(id) {
    get(id).close();
    if (previousFocus?.isConnected) previousFocus.focus();
  }

  function updateButtons() {
    document.querySelectorAll('[data-page]').forEach((button) => {
      button.disabled = busy;
    });
    document.querySelectorAll('[data-busy]').forEach((element) => {
      element.disabled = busy;
    });
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.disabled = busy || recoveryPending || (lastRoll && !settled);
    });
    get('rollButton').disabled = busy || recoveryPending || Boolean(lastRoll && !settled);
    get('scoreButton').disabled = busy || recoveryPending || settled;
    get('previousStudents').disabled = busy || studentPage.pageNo <= 1;
    get('nextStudents').disabled =
      busy || studentPage.pageNo * studentPage.pageSize >= studentPage.total;
    get('main').setAttribute('aria-busy', String(busy));
  }

  function switchPage(page) {
    if (!pageInfo[page]) return;
    Object.keys(pageInfo).forEach((name) => {
      get(`page-${name}`).hidden = name !== page;
    });
    document.querySelectorAll('[data-page]').forEach((button) => {
      const active = button.dataset.page === page;
      button.classList.toggle('rc-nav--active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    get('pageTitle').textContent = pageInfo[page][0];
    get('pageDescription').textContent = pageInfo[page][1];
    document.defaultView.scrollTo(0, 0);
    if (page === 'ranking' && !busy) handlers.onRankingRequested(Number(get('rankingLimit').value));
  }

  function table(rows, ranking = false) {
    if (!rows.length) return '<p class="rc-empty">暂无学生数据，请先导入名单。</p>';
    return `<table><thead><tr>${ranking ? '<th scope="col">排名</th>' : ''}<th scope="col">学号</th><th scope="col">姓名</th><th scope="col">专业</th><th scope="col">随机点名次数</th><th scope="col">总积分</th></tr></thead><tbody>${rows.map((s, index) => `<tr>${ranking ? `<td>${index + 1}</td>` : ''}<td class="rc-number">${escapeHtml(s.sno)}</td><td><strong>${escapeHtml(s.name)}</strong></td><td>${escapeHtml(s.major || '—')}</td><td>${escapeHtml(s.onCallCount)}</td><td class="rc-number ${s.score < 0 ? 'rc-negative' : ''}">${escapeHtml(s.score)}</td></tr>`).join('')}</tbody></table>`;
  }

  async function enterBig() {
    document.body.classList.add('rc-big');
    get('exitBig').hidden = false;
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      /* 浏览器拒绝全屏时保留网页大屏。 */
    }
  }

  async function exitBig() {
    document.body.classList.remove('rc-big');
    get('exitBig').hidden = true;
    if (document.fullscreenElement) await document.exitFullscreen();
    get('bigButton').focus();
  }

  function showScore() {
    get('scoreForm').reset();
    updateScoreFields();
    get('scoreStudent').textContent =
      `${lastRoll.student.name} · ${lastRoll.student.sno} · ${lastRoll.mode === 'random' ? '随机点名' : '顺序点名'}`;
    openDialog('scoreDialog');
  }

  function updateScoreFields() {
    const present = get('scoreForm').elements.present.value === '1';
    get('repeatFields').disabled = !present;
    get('answerBonus').disabled = !present;
  }

  return {
    init(h) {
      handlers = h;
      const requestStudents = (pageNo = 1) =>
        handlers.onStudentsRequested({
          q: get('studentQuery').value,
          pageNo,
          pageSize: Number(get('studentPageSize').value),
        });
      get('studentSearch').addEventListener('submit', (event) => {
        event.preventDefault();
        requestStudents();
      });
      get('clearSearch').addEventListener('click', () => {
        get('studentQuery').value = '';
        requestStudents();
      });
      get('studentPageSize').addEventListener('change', () => requestStudents());
      get('previousStudents').addEventListener('click', () =>
        requestStudents(studentPage.pageNo - 1)
      );
      get('nextStudents').addEventListener('click', () => requestStudents(studentPage.pageNo + 1));
      get('retryStudents').addEventListener('click', () => requestStudents(studentPage.pageNo));
      get('recoverRecord').addEventListener('click', () => handlers.onRecoveryRequested());
      get('replayButton').addEventListener('click', () => {
        if (lastRoll?.mode === 'random') handlers.onReplayRequested(lastRoll.recordId);
      });
      document
        .querySelectorAll('[data-page]')
        .forEach((button) =>
          button.addEventListener('click', () => switchPage(button.dataset.page))
        );
      document.querySelectorAll('[data-mode]').forEach((button) =>
        button.addEventListener('click', () => {
          if (busy || recoveryPending || (lastRoll && !settled)) return;
          mode = button.dataset.mode;
          handlers.onModeChanged(mode);
          document.querySelectorAll('[data-mode]').forEach((item) => {
            item.classList.toggle('rc-button--primary', item.dataset.mode === mode);
            item.setAttribute('aria-pressed', String(item.dataset.mode === mode));
          });
          get('modeHint').textContent =
            mode === 'random'
              ? '积分越高，随机被点到的概率越低'
              : '按学号逐位点名，不增加随机点名次数';
          get('rollButton').textContent = mode === 'random' ? '开始随机点名' : '点下一位同学';
        })
      );
      get('rollButton').addEventListener('click', () => handlers.onRollRequested());
      get('scoreButton').addEventListener('click', showScore);
      get('scoreForm').addEventListener('change', updateScoreFields);
      get('scoreForm').addEventListener('submit', (event) => {
        event.preventDefault();
        if (busy || settled) return;
        const form = get('scoreForm');
        const present = Number(form.elements.present.value);
        handlers.onScoreSubmitted({
          present,
          repeat: present ? form.elements.repeat.value : 'none',
          answerBonus: present ? Number(form.elements.answerBonus.value) : 0,
        });
      });
      get('importButton').addEventListener('click', () => {
        get('importFile').value = '';
        get('importFile').click();
      });
      get('importFile').addEventListener('change', () => {
        if (!busy && get('importFile').files[0])
          handlers.onImportRequested(get('importFile').files[0]);
      });
      get('confirmImport').addEventListener('click', () => {
        if (!busy) handlers.onImportConfirmed();
      });
      ['cancelImport', 'cancelImportX'].forEach((id) =>
        get(id).addEventListener('click', () => {
          if (!busy) handlers.onImportCancelled();
        })
      );
      get('importDialog').addEventListener('cancel', (event) => {
        event.preventDefault();
        if (!busy) handlers.onImportCancelled();
      });
      get('scoreDialog').addEventListener('cancel', (event) => {
        if (busy) event.preventDefault();
      });
      document.querySelectorAll('[data-close]').forEach((button) =>
        button.addEventListener('click', () => {
          if (!busy) closeDialog(button.dataset.close);
        })
      );
      document
        .querySelectorAll('[data-export]')
        .forEach((button) => button.addEventListener('click', () => openDialog('exportDialog')));
      get('confirmExport').addEventListener('click', () => {
        if (!busy) handlers.onExportRequested();
      });
      get('refreshRanking').addEventListener('click', () =>
        handlers.onRankingRequested(Number(get('rankingLimit').value))
      );
      get('rankingLimit').addEventListener('change', () =>
        handlers.onRankingRequested(Number(get('rankingLimit').value))
      );
      get('probabilityButton').addEventListener('click', () => handlers.onProbabilitiesRequested());
      get('dismissNotice').addEventListener('click', () => {
        get('notice').hidden = true;
      });
      get('bigButton').addEventListener('click', enterBig);
      get('exitBig').addEventListener('click', exitBig);
      document.addEventListener('keydown', (event) => {
        if (
          event.key === 'Escape' &&
          document.body.classList.contains('rc-big') &&
          !document.querySelector('dialog[open]')
        )
          exitBig();
      });
      document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && document.body.classList.contains('rc-big')) exitBig();
      });
      updateButtons();
    },
    renderStudents(rows, total, meta = { pageNo: 1, pageSize: 10, rosterTotal: total, q: '' }) {
      get('studentTable').innerHTML = table(rows);
      if (!rows.length && meta.q)
        get('studentTable').textContent = '没有匹配的学生，请修改搜索条件。';
      studentPage = { ...meta, total };
      get('studentQuery').value = meta.q;
      get('studentPageSize').value = String(meta.pageSize);
      get('studentPageSummary').textContent =
        `全班 ${meta.rosterTotal} 人 · 匹配 ${total} 人 · 第 ${meta.pageNo} / ${Math.max(1, Math.ceil(total / meta.pageSize))} 页`;
      get('studentTotal').textContent = meta.rosterTotal;
      get('sidebarCount').textContent = `当前名单 / ${meta.rosterTotal} 位同学`;
      get('connectionStatus').textContent = '已连接课堂服务';
      updateButtons();
    },
    renderRollResult(result) {
      lastRoll = result;
      settled = false;
      if (!result.restored) calls += 1;
      get('sessionCalls').textContent = calls;
      get('pendingCalls').textContent = '1';
      get('studentName').textContent = result.student.name;
      get('studentMeta').textContent =
        `${result.student.sno} · ${result.student.major || '专业未填'}`;
      get('resultCaption').textContent =
        `${result.mode === 'random' ? '随机点名' : '顺序点名'} · 记录 #${result.recordId}`;
      get('resultScore').hidden = false;
      get('resultScore').textContent = `当前积分 ${result.student.score}`;
      get('scoreButton').hidden = false;
      get('replayButton').hidden = result.mode !== 'random';
      get('rollHelp').textContent = '请先登记本次表现并保存，避免漏记积分。';
      get('recentRecord').textContent = `${result.student.name} · 已点名，待登记表现`;
      updateButtons();
    },
    clearRoll() {
      lastRoll = null;
      settled = false;
      if (get('scoreDialog').open) closeDialog('scoreDialog');
      get('scoreButton').hidden = true;
      get('replayButton').hidden = true;
      get('pendingCalls').textContent = '0';
      get('studentName').textContent = '请重新点名';
      get('studentMeta').textContent = '原点名记录已失效';
      get('resultScore').hidden = true;
      get('resultCaption').textContent = '服务记录已变化';
      get('rollHelp').textContent = '请重新点名，再登记课堂表现。';
      get('recentRecord').textContent = '原本页记录已失效，未恢复其他记录。';
      updateButtons();
    },
    renderRecovery({ pending, mode: restoredMode }) {
      recoveryPending = pending;
      get('recoverRecord').hidden = !pending;
      if (restoredMode) {
        mode = restoredMode;
        document.querySelectorAll('[data-mode]').forEach((button) => {
          button.classList.toggle('rc-button--primary', button.dataset.mode === mode);
          button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
        });
        get('rollButton').textContent = mode === 'random' ? '开始随机点名' : '点下一位同学';
        get('modeHint').textContent =
          mode === 'random'
            ? '积分越高，随机被点到的概率越低'
            : '按学号逐位点名，不增加随机点名次数';
      }
      updateButtons();
    },
    renderProbabilities({ minScore, rows }) {
      get('probabilitySummary').textContent =
        `当前最低积分 ${minScore} · ${rows.length} 人 · 概率合计 ${(rows.reduce((sum, row) => sum + row.probability, 0) * 100).toFixed(2)}%`;
      get('probabilityTable').innerHTML =
        `<table><thead><tr><th>学号</th><th>姓名</th><th>积分</th><th>权重</th><th>概率</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.sno)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.score)}</td><td>${row.weight.toFixed(4)}</td><td>${(row.probability * 100).toFixed(2)}%</td></tr>`).join('')}</tbody></table>`;
      openDialog('probabilityDialog');
    },
    renderReplay(result) {
      get('replayResult').textContent =
        `记录 #${result.recordId} · 种子 ${result.seed} · 原记录学号 ${result.recordedSno} · 复算学号 ${result.picked.sno} · ${result.matched ? '结果一致' : '结果不一致，请核查'}`;
      openDialog('replayDialog');
    },
    renderSettlement(result) {
      settled = result.settled === true;
      get('pendingCalls').textContent = settled ? '0' : '1';
      get('resultScore').textContent =
        `已保存 · 本次 ${signed(result.delta)} · 总积分 ${result.score}`;
      get('recentRecord').textContent =
        `${lastRoll.student.name} · ${lastRoll.mode === 'random' ? '随机点名' : '顺序点名'} · 到场 ${signed(result.deltas.present)} / 复述 ${signed(result.deltas.repeat)} / 回答 ${signed(result.deltas.answer)} · 已保存`;
      get('rollHelp').textContent = '本次积分已保存，可以继续点名。';
      if (get('scoreDialog').open) closeDialog('scoreDialog');
      // 主控结算只回传当前学生，不另发接口请求；同步已展示的名单积分。
      const rows = get('studentTable').querySelectorAll('tbody tr');
      rows.forEach((row) => {
        if (row.cells[0].textContent === lastRoll.student.sno) {
          const cell = row.cells[4];
          cell.textContent = result.score;
          cell.classList.toggle('rc-negative', result.score < 0);
        }
      });
      updateButtons();
    },
    renderRanking(rows) {
      get('rankingTable').innerHTML = table(rows, true);
      get('rankingSummary').textContent = `当前展示 ${rows.length} 位同学 · 导出始终包含完整名单`;
      get('chartEmpty').hidden = rows.length > 0;
      get('chartWrap').hidden = rows.length === 0;
      try {
        chart.renderRanking(get('rankingChart'), rows);
      } catch (error) {
        this.renderError('CHART_UNAVAILABLE', error.message);
      }
    },
    renderImportPreview(value) {
      const wasPending = preview !== null;
      preview = value;
      if (!value) {
        if (get('importDialog').open) closeDialog('importDialog');
        if (wasPending) get('importFile').value = '';
        return;
      }
      get('importPreview').innerHTML =
        `<p><strong>${escapeHtml(value.fileName)}</strong></p><p>共 ${value.total} 人，已有学号 ${value.conflicts.length} 个。</p><p class="rc-muted">确认后更新已有学生的姓名与专业，保留积分、次数和历史；取消不写入。</p>${value.conflicts.length ? `<p>已有学号：${value.conflicts.map((c) => escapeHtml(c.sno)).join('、')}</p>` : ''}${value.warnings.length ? `<div class="rc-warning"><strong>请核对学号格式</strong><ul>${value.warnings.map((w) => `<li>${escapeHtml(w.reason)}</li>`).join('')}</ul></div>` : ''}`;
      openDialog('importDialog');
    },
    renderError(code, message) {
      get('notice').classList.remove('rc-notice--success');
      get('noticeText').textContent = `${message}（${code}）`;
      get('notice').hidden = false;
      // 模态框开启时页面提示位于遮罩之后，另将同一错误放进当前弹窗。
      document.querySelectorAll('.rc-dialog-error').forEach((item) => item.remove());
      const dialog = document.querySelector('dialog[open]');
      if (dialog) {
        const error = document.createElement('p');
        error.className = 'rc-dialog-error rc-warning';
        error.setAttribute('role', 'alert');
        error.textContent = message;
        dialog.append(error);
      }
      if (code === 'NETWORK_ERROR') get('connectionStatus').textContent = '连接异常，请重试';
    },
    setBusy(value) {
      busy = Boolean(value);
      if (busy) {
        get('notice').hidden = true;
        document.querySelectorAll('.rc-dialog-error').forEach((item) => item.remove());
      }
      updateButtons();
    },
    exportStarted(count) {
      closeDialog('exportDialog');
      get('notice').classList.add('rc-notice--success');
      get('noticeText').textContent =
        `已发起 ${count} 位同学的 Excel 下载，请在浏览器下载列表查看。`;
      get('notice').hidden = false;
    },
  };
}
