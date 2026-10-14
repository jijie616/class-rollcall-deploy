'use strict';

// 仅供启动回归测试预加载：不建立任何数据库网络连接。
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return {
      createPool() {
        return {
          async query(sql) {
            if (sql.startsWith('SELECT COUNT(*)')) return [[{ n: 0 }]];
            if (sql.startsWith('SELECT * FROM students')) return [[]];
            throw new Error('启动测试禁止写数据库：' + sql);
          },
        };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
