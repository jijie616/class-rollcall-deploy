'use strict';

// 前端模块的补充入口，不修改主线现有测试清单。
const { execFileSync } = require('node:child_process');
const path = require('node:path');

for (const file of ['test-chart.js', 'test-exporter.js']) {
  execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
}
console.log('前端补充测试全部通过（2 个文件）');
