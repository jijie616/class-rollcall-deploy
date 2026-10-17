'use strict';

// MySQL 模式启动器（跨平台，不需要 cross-env）
// 用法：先复制 .env.example 为本地配置并填好，再执行 npm run start:mysql
//
// 为什么不把凭据写进 package.json：凭据只应存在于本地环境变量或 .env 文件里，
// 而 .env 已在 .gitignore 中排除，不会进仓库。

const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach((line) => {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) return;
      const i = t.indexOf('=');
      if (i === -1) return;
      const k = t.slice(0, i).trim();
      const v = t
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!(k in process.env)) process.env[k] = v;
    });
}

process.env.STORE = 'mysql';

const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error('缺少数据库配置：' + missing.join(', '));
  console.error('请在项目根目录创建 .env（可参考 .env.example），或先导出这些环境变量。');
  process.exit(1);
}

console.log('以 MySQL 模式启动，目标库：' + process.env.DB_NAME + '@' + process.env.DB_HOST);
console.log('  数据库端口：' + (Number(process.env.DB_PORT || 3306) || 3306));
const { startServer } = require('./index.js');
startServer();
