'use strict';

// 测试总入口：依次运行各测试文件，任一失败即整体失败（供 CI 与提交前自测使用）
// 用法：node tests/run-all.js    或    npm test

const { execFileSync } = require('child_process');
const path = require('path');

const FILES = [
  'test-lottery.js',
  'test-scorer.js',
  'test-importer.js',
  'test-api.js',
  'test-app.js',
  'test-regressions.js',
  'test-chart.js',
  'test-exporter.js',
  'test-integration.js',
  'test-deployment.js',
];

let failed = 0;
for (const file of FILES) {
  console.log('\n════════ ' + file + ' ════════');
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, file)], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    console.log(out.trimEnd());
  } catch (err) {
    failed += 1;
    console.log((err.stdout || '').trimEnd());
    console.log((err.stderr || '').trimEnd());
    console.log('→ ' + file + ' 失败');
  }
}

console.log('\n════════════════════════════════');
if (failed > 0) {
  console.log('测试失败：' + failed + ' / ' + FILES.length + ' 个文件未通过');
  process.exit(1);
}
console.log('全部测试文件通过（' + FILES.length + ' / ' + FILES.length + '）');
console.log(
  '端到端冒烟需先启动服务：node server/index.js，再 SMOKE_BASE=... node tests/smoke-e2e.js'
);
