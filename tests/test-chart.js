'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { buildRankingConfig, createRankingChart } = await import('../src/js/chart.js');
  const rows = [
    { sno: '001', name: '甲', major: '软件工程', score: 3, onCallCount: 1 },
    { sno: '002', name: '乙', major: '', score: -1, onCallCount: 4 },
  ];
  const before = structuredClone(rows);
  const config = buildRankingConfig(rows);
  assert.deepEqual(config.data.labels, ['甲', '乙']);
  assert.deepEqual(config.data.datasets[0].data, [3, -1]);
  assert.deepEqual(config.data.datasets[1].data, [1, 4]);
  assert.notEqual(config.data.datasets[0].yAxisID, config.data.datasets[1].yAxisID);
  assert.equal(config.options.scales.score.min, undefined);
  assert.equal(config.options.scales.count.ticks.precision, 0);
  assert.ok(config.options.plugins.tooltip.callbacks.title([{ dataIndex: 0 }]).includes('001'));
  assert.deepEqual(rows, before);
  let created = 0;
  let destroyed = 0;
  class ChartFake {
    constructor() {
      created += 1;
    }
    destroy() {
      destroyed += 1;
    }
  }
  const chart = createRankingChart(ChartFake);
  chart.renderRanking({}, rows);
  chart.renderRanking({}, rows);
  assert.equal(created, 2);
  assert.equal(destroyed, 1);
  assert.equal(chart.renderRanking({}, []), null);
  assert.equal(destroyed, 2);
  chart.destroy();
  assert.equal(destroyed, 2);
  assert.throws(() => createRankingChart(null).renderRanking({}, rows), /未加载/);
  assert.deepEqual(buildRankingConfig([]).data.labels, []);
  console.log('图表验证通过：负分、独立次数轴、提示信息、输入不变、重复绘制释放与空态。');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
