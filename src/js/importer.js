// Excel 学生名单导入（A3）
// 负责人：李文龙
//
// 职责边界：本模块只负责"把 Excel 变成可信的行数据并给出错误/警告"，
// 解析不碰网络与数据库。主控通过 api.js 校验并在确认后提交。
// 下方 commit 是保留的兼容辅助函数，当前主控不直接使用它。
//
// 设计要点：
//   1. SheetJS 通过参数注入（parseFile 的第二个参数），因此核心逻辑可以在 Node 里
//      用纯数组直接跑单测，不需要真实 xlsx 文件，也不需要把 SheetJS 装进依赖；
//   2. 学号一律 String(cell).trim()。Excel 把学号存成数字时，SheetJS 会解析成 number，
//      直接落库会丢前导零、超过 15 位还会踩浮点精度；
//   3. 更重要的是：如果源文件本身就把学号存成了数字格式，前导零在"读取之前"就已经
//      丢了，String() 变不回来。这种情况必须给出警告让老师改格式重导，
//      而不是假装转换成功——所以本模块会检查单元格类型（t === 'n'）。

/** 表头别名：容忍老师名单里常见的列名写法 */
export const HEADER_ALIASES = {
  sno: ['学号', '学生学号', '编号', '学籍号', 'sno', 'id', 'no'],
  name: ['姓名', '学生姓名', '名字', 'name'],
  major: ['专业', '专业名称', '班级', '学院', 'major', 'class'],
};

export const LIMITS = { sno: 20, name: 50, major: 50 };

/** 规整表头文本：去空白、去换行、全角转半角常见符号 */
export function normalizeHeader(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .toLowerCase();
}

/** 取单元格原始值；支持 SheetJS 的 {v,t} 结构与直接传值 */
export function cellValue(cell) {
  if (cell && typeof cell === 'object' && 'v' in cell) return cell.v;
  return cell;
}

/** 取单元格类型；SheetJS 中 'n' 表示数字型 */
export function cellType(cell) {
  if (cell && typeof cell === 'object' && 't' in cell) return cell.t;
  return typeof cell === 'number' ? 'n' : 's';
}

/** 在矩阵中定位表头行，并建立"字段 → 列号"映射 */
export function findHeaderRow(matrix) {
  const maxScan = Math.min(matrix.length, 10); // 表头一般在前几行
  for (let i = 0; i < maxScan; i += 1) {
    const row = matrix[i] || [];
    const map = {};
    row.forEach((cell, col) => {
      const h = normalizeHeader(cellValue(cell));
      if (h === '') return;
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (map[field] === undefined && aliases.some((a) => normalizeHeader(a) === h)) {
          map[field] = col;
        }
      }
    });
    if (map.sno !== undefined && map.name !== undefined) {
      return { index: i, map };
    }
  }
  return null;
}

/**
 * 把二维矩阵转成待导入的行，并给出错误与警告。
 * @param {Array<Array>} matrix 第一维是行、第二维是列；行列号按 Excel 物理行号（从 1 开始）
 * @returns {{rows: Array, errors: Array, warnings: Array, header: object|null}}
 *   rows: [{ row, sno, name, major }] 仅含校验通过的行
 *   errors: [{ row, sno, reason }] 必须修正后才能导入
 *   warnings: [{ row, sno, reason }] 可继续，但需提示老师
 */
export function matrixToRows(matrix) {
  const errors = [];
  const warnings = [];
  const rows = [];

  if (!Array.isArray(matrix) || matrix.length === 0) {
    return {
      rows,
      errors: [{ row: 0, sno: '', reason: '文件内容为空' }],
      warnings,
      header: null,
    };
  }

  const head = findHeaderRow(matrix);
  if (!head) {
    return {
      rows,
      errors: [
        {
          row: 0,
          sno: '',
          reason: '未找到表头：文件必须包含"学号"和"姓名"两列（专业列可选）',
        },
      ],
      warnings,
      header: null,
    };
  }

  const { index: headerIndex, map } = head;
  const seen = new Map(); // sno -> 首次出现的 Excel 行号
  let numericSnoRows = 0;

  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const raw = matrix[i] || [];
    const excelRow = i + 1;
    const snoCell = raw[map.sno];
    const nameCell = raw[map.name];
    const majorCell = map.major === undefined ? '' : raw[map.major];

    const sno = String(
      cellValue(snoCell) === null || cellValue(snoCell) === undefined ? '' : cellValue(snoCell)
    ).trim();
    const name = String(
      cellValue(nameCell) === null || cellValue(nameCell) === undefined ? '' : cellValue(nameCell)
    ).trim();
    const major = String(
      cellValue(majorCell) === null || cellValue(majorCell) === undefined
        ? ''
        : cellValue(majorCell)
    ).trim();

    // 整行皆空视为空行，直接跳过（Excel 末尾常有）
    if (sno === '' && name === '' && major === '') continue;

    if (sno === '') {
      errors.push({ row: excelRow, sno: '', reason: '学号为空' });
      continue;
    }
    if (sno.length > LIMITS.sno) {
      errors.push({ row: excelRow, sno, reason: '学号超过 ' + LIMITS.sno + ' 个字符' });
      continue;
    }
    if (name === '') {
      errors.push({ row: excelRow, sno, reason: '姓名为空' });
      continue;
    }
    if (name.length > LIMITS.name) {
      errors.push({ row: excelRow, sno, reason: '姓名超过 ' + LIMITS.name + ' 个字符' });
      continue;
    }
    if (major.length > LIMITS.major) {
      errors.push({ row: excelRow, sno, reason: '专业超过 ' + LIMITS.major + ' 个字符' });
      continue;
    }
    if (seen.has(sno)) {
      errors.push({ row: excelRow, sno, reason: '与第 ' + seen.get(sno) + ' 行学号重复' });
      continue;
    }
    seen.set(sno, excelRow);

    if (cellType(snoCell) === 'n') {
      numericSnoRows += 1;
      warnings.push({
        row: excelRow,
        sno,
        reason: '学号在源文件里是数字格式，前导零可能已丢失，建议把学号列设为文本后重新导出',
      });
    }

    rows.push({ row: excelRow, sno, name, major });
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ row: headerIndex + 1, sno: '', reason: '表头之下没有任何数据行' });
  }
  if (numericSnoRows > 0) {
    warnings.unshift({
      row: 0,
      sno: '',
      reason: '共有 ' + numericSnoRows + ' 行学号为数字格式，前导零可能已丢失',
    });
  }

  return { rows, errors, warnings, header: { row: headerIndex + 1, map } };
}

/**
 * 读取用户选择的 Excel 文件。
 *
 * @param {File|Blob|ArrayBuffer} file 浏览器里是 File；测试里可直接传 ArrayBuffer
 * @param {object} XLSX SheetJS 对象（从 lib/ 本地副本引入后传入，便于测试替换）
 * @returns {Promise<{rows, errors, warnings, header}>}
 */
export async function parseFile(file, XLSX) {
  if (!XLSX || typeof XLSX.read !== 'function') {
    throw new Error('缺少 SheetJS：请确认 lib/xlsx.full.min.js 已加载');
  }
  const name = (file && file.name) || '';
  if (name && !/\.(xlsx|xls|csv)$/i.test(name)) {
    return {
      rows: [],
      errors: [{ row: 0, sno: '', reason: '只支持 .xlsx / .xls / .csv 文件，当前为 ' + name }],
      warnings: [],
      header: null,
    };
  }

  const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const firstSheetName = wb.SheetNames && wb.SheetNames[0];
  if (!firstSheetName) {
    return {
      rows: [],
      errors: [{ row: 0, sno: '', reason: '文件里没有任何工作表' }],
      warnings: [],
      header: null,
    };
  }
  const sheet = wb.Sheets[firstSheetName];
  // header:1 → 每行是数组；raw:true → 保留原始类型，便于识别数字型学号
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  return matrixToRows(matrix);
}

/**
 * 提交已校验的行到服务端落库。
 * @param {Array} rows matrixToRows 返回的 rows
 * @param {string} dupPolicy 'update-info'（默认）| 'skip' | 'reject'
 * @param {string} apiBase 接口基址
 */
export async function commit(rows, dupPolicy = 'update-info', apiBase = '/api') {
  const res = await fetch(apiBase + '/import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, dupPolicy }),
  });
  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) {
    const err = new Error((body && body.error && body.error.message) || '导入提交失败');
    err.code = (body && body.error && body.error.code) || 'NETWORK_ERROR';
    throw err;
  }
  return body.data;
}
