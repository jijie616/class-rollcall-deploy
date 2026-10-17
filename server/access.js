'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

// 课堂演示站点的共享访问门禁；生产环境必须配置，不替代个人账户或课堂隔离。
function createAccessGate(env = process.env) {
  const user = env.APP_ACCESS_USER || '';
  const password = env.APP_ACCESS_PASSWORD || '';
  const enabled = Boolean(user || password);
  if (enabled || env.NODE_ENV === 'production') {
    if (!user || !password || user.includes(':') || /[\r\n]/.test(user) || password.length < 12) {
      throw new Error(
        '部署访问配置无效：需设置 APP_ACCESS_USER 和至少 12 字符的 APP_ACCESS_PASSWORD'
      );
    }
  }
  const digest = (value) => createHash('sha256').update(value).digest();
  const expected = digest(`${user}:${password}`);
  return function allow(req, res) {
    if (!enabled) return true;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization');
    const match = /^Basic ([a-zA-Z0-9+/]+={0,2})$/i.exec(req.headers.authorization || '');
    if (match && timingSafeEqual(expected, digest(Buffer.from(match[1], 'base64')))) return true;
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Class Rollcall", charset="UTF-8"',
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: '请使用课堂访问账号登录' },
      })
    );
    return false;
  };
}

module.exports = { createAccessGate };
