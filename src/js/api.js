// 前端 HTTP 客户端（A7 前端部分）
// 负责人：李文龙
//
// 职责：把 11 个端点包成函数，统一处理接口基址、JSON 序列化与 3.4.5 的错误信封。
// 业务规则一律不在这里判断——前端只负责"把请求发出去、把结果交回来"，
// 中签人、积分增量、概率全部由服务端决定。
//
// 错误统一抛 ApiError，带 code 字段（取值同服务端 error.code），
// 便于 ui.js 直接把 code 映射成提示文案，而不用解析字符串。

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {string} [options.baseUrl] 接口基址，默认同源 /api
 * @param {Function} [options.fetchImpl] 便于测试替换
 */
export function createApiClient({ baseUrl = '/api', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  async function request(method, path, body) {
    let res;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // 网络层失败（断网、服务未启动）与业务失败要区分开，便于提示不同的文案
      throw new ApiError('NETWORK_ERROR', '无法连接服务，请确认中间层已启动', 0);
    }

    let json = null;
    try {
      json = await res.json();
    } catch (err) {
      throw new ApiError('NETWORK_ERROR', '服务返回的不是合法 JSON', res.status);
    }

    if (!json || json.ok !== true) {
      const code = (json && json.error && json.error.code) || 'INTERNAL';
      const message = (json && json.error && json.error.message) || '请求失败';
      throw new ApiError(code, message, res.status);
    }
    return json.data;
  }

  /** 拼接查询串，自动跳过空值 */
  function qs(params) {
    const parts = Object.entries(params || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    return parts.length ? '?' + parts.join('&') : '';
  }

  return {
    /** 暴露基址：导入模块需要自己发请求时复用，避免两处硬编码不一致 */
    baseUrl,
    // #1 学生列表
    listStudents({ q, pageSize, pageNo } = {}) {
      return request('GET', '/students' + qs({ q, pageSize, pageNo }));
    },
    // #2 导入干跑校验
    validateImport({ rows } = {}) {
      return request('POST', '/import/validate', { rows });
    },
    // #3 导入提交
    commitImport({ rows, dupPolicy = 'update-info' } = {}) {
      return request('POST', '/import/commit', { rows, dupPolicy });
    },
    // #4 随机点名
    roll({ mode = 'random' } = {}) {
      return request('POST', '/roll', { mode });
    },
    // #5 顺序点名
    rollNext({ cursor = null } = {}) {
      return request('POST', '/roll/next', { cursor });
    },
    // #6 积分结算
    settleRoll({ id, present, repeat, answerBonus } = {}) {
      return request('POST', '/roll/' + encodeURIComponent(String(id)) + '/settle', {
        present,
        repeat,
        answerBonus,
      });
    },
    // #7 排行榜
    ranking({ limit = 10 } = {}) {
      return request('GET', '/ranking' + qs({ limit }));
    },
    // #8 完整导出数据
    exportDetail() {
      return request('GET', '/export/detail');
    },
    // #9 概率查看
    probabilities() {
      return request('GET', '/probabilities');
    },
    // #10 点名历史
    records({ from, to, limit } = {}) {
      return request('GET', '/records' + qs({ from, to, limit }));
    },
    // #11 按种子复演
    replayRoll({ id } = {}) {
      return request('GET', '/roll/' + encodeURIComponent(String(id)) + '/replay');
    },
  };
}
