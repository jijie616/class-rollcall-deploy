// 调试页启动脚本（配合 dev.html 使用，不是交付物）
// 作用：把 ui.debug.js / api.js / app.js / importer.js 接起来，让主控能在浏览器里跑。

import { createApiClient } from './api.js';
import { createApp } from './app.js';
import * as importer from './importer.js';
import { createDebugUi } from './ui.debug.js';

const root = document.getElementById('app');
const ui = createDebugUi(root);

// 接口基址：调试页由中间层同源托管，因此用默认的 /api
const api = createApiClient();

const app = createApp({
  ui,
  api,
  importer,
  xlsx: globalThis.XLSX || null, // 由 dev.html 里的 <script> 提供
});

// 把 app 挂到全局，便于在控制台手工调试（例如 __app.state）
globalThis.__app = app;

app
  .start()
  .then(() => {
    if (!globalThis.XLSX) {
      ui.renderError(
        'INTERNAL',
        '未加载 SheetJS，导入功能不可用；请确认 lib/xlsx.full.min.js 存在'
      );
    }
    if (location.hash === '#selftest') return selfTest();
  })
  .catch((err) => {
    ui.renderError('INTERNAL', '启动失败：' + err.message);
  });

/**
 * 浏览器自检（仅 dev.html#selftest 触发，不是交付物的一部分）
 * 目的：在真实浏览器里验证"点击 → 事件委托 → 主控 → 接口 → 重绘"整条链路，
 * 而不是只验证页面能渲染。结果写到 document.title，便于无头浏览器 dump 出来核对。
 */
async function selfTest() {
  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('找不到元素：' + sel);
    el.click();
  };

  try {
    click('[data-act="roll"]');
    await wait(400);
    const rollText = document.querySelector('.student .name');
    log.push('点名=' + (rollText ? rollText.textContent : '无'));

    click('[data-act="settle"][data-bonus="3"]');
    await wait(400);
    const result = document.querySelector('.result');
    log.push('结算=' + (result ? result.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : '无'));

    click('[data-act="mode"][data-value="sequence"]');
    await wait(150);
    click('[data-act="roll"]');
    await wait(400);
    log.push('顺序点名=' + (document.querySelector('.student .name') || {}).textContent);

    click('[data-act="ranking"]');
    await wait(400);
    const rows = document.querySelectorAll('#ranking tbody tr');
    log.push('排行榜行数=' + rows.length);

    document.title = 'SELFTEST|' + log.join('|');
  } catch (err) {
    document.title = 'SELFTEST_FAIL|' + err.message;
  }
}
