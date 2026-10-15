// 正式入口复用搭档的主控与接口客户端，UI 不接触数据库凭据。
import { createApiClient } from './api.js';
import { createApp } from './app.js';
import * as importer from './importer.js';
import { createUi } from './ui.js';
import { createRankingChart } from './chart.js';
import { createExporter } from './exporter.js';

const chart = createRankingChart(globalThis.Chart);
const ui = createUi(document, chart);
const app = createApp({ ui, api: createApiClient(), importer, xlsx: globalThis.XLSX });
app.setExporter(createExporter(globalThis.XLSX, (count) => ui.exportStarted(count)));
app.start().catch(() => ui.renderError('INTERNAL', '页面启动失败，请刷新重试'));
window.addEventListener('pagehide', () => chart.destroy());
