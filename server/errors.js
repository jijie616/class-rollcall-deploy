'use strict';

// 统一错误码与响应格式（对应接口约定 3.4.5）
// 负责人：李文龙（A7）

const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 400,
  DUPLICATE_SNO_IN_FILE: 400,
  EMPTY_ROSTER: 400,
  NOT_FOUND: 404,
  ALREADY_SETTLED: 409,
  DB_UNAVAILABLE: 503,
  INTERNAL: 500,
});

/** 业务异常：携带错误码，由 HTTP 层统一转成 3.4.5 的响应格式 */
class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code] || 500;
  }
}

/** 成功响应体 */
function ok(data) {
  return { ok: true, data };
}

/** 失败响应体 */
function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * 把任意异常规整为响应体。
 * 未分类异常一律收敛为 INTERNAL，且不向前端暴露堆栈（避免泄露实现细节）。
 */
function toErrorBody(err) {
  if (err instanceof ApiError) {
    return fail(err.code, err.message);
  }
  return fail('INTERNAL', '服务器内部错误，请重试或联系开发者');
}

module.exports = { ERROR_CODES, ApiError, ok, fail, toErrorBody };
