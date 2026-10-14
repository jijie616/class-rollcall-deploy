'use strict';

// 名单导入模块测试（A3）
//
// 数据构造思路：
//   1. 核心校验逻辑做成纯函数（matrixToRows），因此用二维数组当测试数据即可，
//      不需要真实 xlsx 文件——测试跑得快、不依赖 SheetJS；
//   2. 重点是"学号必须是字符串"这条：构造数字型单元格，验证既被转成字符串、
//      又会因为前导零风险给出警告；
//   3. 表头识别要覆盖列顺序打乱与列名别名（老师名单的列名很随意）。

const assert = require('assert');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log('  ✗ ' + name + ' → ' + err.message);
  }
}

(async function main() {
  // src/ 下有 package.json {"type":"module"}，因此这里是 ESM 动态导入
  const I = await import('../src/js/importer.js');

  console.log('\n[importer] 表头识别');

  await test('标准表头（学号/姓名/专业）', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名', '专业'],
      [{ v: '102401306', t: 's' }, { v: '顾思齐', t: 's' }, { v: '软件工程', t: 's' }],
    ]);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].sno, '102401306');
    assert.strictEqual(r.rows[0].name, '顾思齐');
    assert.strictEqual(r.rows[0].major, '软件工程');
  });

  await test('列顺序打乱仍能按表头名正确对应', async () => {
    const r = I.matrixToRows([
      ['专业', '姓名', '学号'],
      ['软件工程', '顾思齐', '102401306'],
    ]);
    assert.strictEqual(r.rows[0].sno, '102401306');
    assert.strictEqual(r.rows[0].name, '顾思齐');
    assert.strictEqual(r.rows[0].major, '软件工程');
  });

  await test('容忍列名别名与前后空白', async () => {
    const r = I.matrixToRows([
      [' 学生学号 ', '学生姓名', '专业名称'],
      ['102401306', '顾思齐', '软件工程'],
    ]);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].name, '顾思齐');
  });

  await test('缺"姓名"列 → 报错并说明原因', async () => {
    const r = I.matrixToRows([['学号', '专业'], ['102401306', '软件工程']]);
    assert.strictEqual(r.rows.length, 0);
    assert.ok(r.errors[0].reason.includes('表头'));
  });

  await test('没有"专业"列也能导入（专业可选）', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名'],
      ['102401306', '顾思齐'],
    ]);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.rows[0].major, '');
  });

  console.log('\n[importer] 行校验');

  await test('学号为空 → 报错并带 Excel 行号', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名', '专业'],
      ['102401306', '顾思齐', '软件工程'],
      ['', '无学号同学', '软件工程'],
    ]);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].row, 3);
    assert.ok(r.errors[0].reason.includes('学号为空'));
  });

  await test('姓名为空 → 报错', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名', '专业'],
      ['102401307', '', '软件工程'],
    ]);
    assert.strictEqual(r.errors[0].reason, '姓名为空');
    assert.strictEqual(r.errors[0].row, 2);
  });

  await test('文件内重复学号 → 报出重复行号', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名', '专业'],
      ['102401306', '顾思齐', '软件工程'],
      ['102401307', '唐可心', '软件工程'],
      ['102401306', '顾思齐重复', '软件工程'],
    ]);
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].row, 4);
    assert.ok(r.errors[0].reason.includes('第 2 行'), '应指出首次出现的行号');
  });

  await test('空行被跳过，不报错', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名', '专业'],
      ['102401306', '顾思齐', '软件工程'],
      ['', '', ''],
      ['102401307', '唐可心', '软件工程'],
    ]);
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.errors.length, 0);
  });

  await test('超长学号被拒绝', async () => {
    const r = I.matrixToRows([['学号', '姓名'], ['1'.repeat(21), '超长']]);
    assert.ok(r.errors[0].reason.includes('超过'));
  });

  await test('表头之下没有任何数据行 → 报错', async () => {
    const r = I.matrixToRows([['学号', '姓名', '专业']]);
    assert.strictEqual(r.rows.length, 0);
    assert.ok(r.errors.length >= 1);
  });

  await test('空文件 → 报错', async () => {
    assert.ok(I.matrixToRows([]).errors.length >= 1);
  });

  console.log('\n[importer] 学号类型（本模块最关键的约束）');

  await test('数字型学号被转成字符串，不是 number', async () => {
    const r = I.matrixToRows([['学号', '姓名'], [{ v: 102401306, t: 'n' }, '顾思齐']]);
    assert.strictEqual(typeof r.rows[0].sno, 'string');
    assert.strictEqual(r.rows[0].sno, '102401306');
  });

  await test('数字型学号会触发"前导零可能已丢失"警告', async () => {
    const r = I.matrixToRows([['学号', '姓名'], [{ v: 12345, t: 'n' }, '张三']]);
    assert.strictEqual(r.rows[0].sno, '12345');
    assert.ok(r.warnings.length >= 1, '应给出警告');
    assert.ok(
      r.warnings.some((w) => w.reason.includes('前导零')),
      '警告内容应说明前导零风险'
    );
  });

  await test('文本型学号不产生警告', async () => {
    const r = I.matrixToRows([['学号', '姓名'], [{ v: '0012345', t: 's' }, '张三']]);
    assert.strictEqual(r.rows[0].sno, '0012345');
    assert.strictEqual(r.warnings.length, 0);
  });

  await test('混合类型：数字型行单独告警，文本型行照常通过', async () => {
    const r = I.matrixToRows([
      ['学号', '姓名'],
      [{ v: '0012345', t: 's' }, '文本学号'],
      [{ v: 23456, t: 'n' }, '数字学号'],
    ]);
    assert.strictEqual(r.rows.length, 2);
    assert.strictEqual(r.warnings.length, 2); // 1 条汇总 + 1 条明细
  });

  console.log('\n[importer] parseFile 适配层');

  await test('非 Excel 扩展名被拒绝', async () => {
    const fake = { name: '名单.txt', arrayBuffer: async () => new ArrayBuffer(0) };
    const r = await I.parseFile(fake, { read: () => {}, utils: {} });
    assert.ok(r.errors[0].reason.includes('.xlsx'));
  });

  await test('未注入 SheetJS 时抛出明确错误', async () => {
    const fake = { name: '名单.xlsx', arrayBuffer: async () => new ArrayBuffer(0) };
    await assert.rejects(() => I.parseFile(fake, null), /SheetJS/);
  });

  await test('通过注入的 SheetJS 走完整解析链路', async () => {
    const MatrixFake = {
      read: () => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }),
      utils: {
        sheet_to_json: () => [
          ['学号', '姓名', '专业'],
          [{ v: '102401306', t: 's' }, { v: '顾思齐', t: 's' }, { v: '软件工程', t: 's' }],
        ],
      },
    };
    const fake = { name: '名单.xlsx', arrayBuffer: async () => new ArrayBuffer(8) };
    const r = await I.parseFile(fake, MatrixFake);
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].name, '顾思齐');
    assert.strictEqual(r.header.row, 1);
  });

  await test('文件中没有任何工作表', async () => {
    const EmptyFake = {
      read: () => ({ SheetNames: [], Sheets: {} }),
      utils: { sheet_to_json: () => [] },
    };
    const fake = { name: '名单.xlsx', arrayBuffer: async () => new ArrayBuffer(8) };
    const r = await I.parseFile(fake, EmptyFake);
    assert.ok(r.errors[0].reason.includes('工作表'));
  });

  console.log('\n[importer] commit 提交');

  await test('成功提交返回服务端结果', async () => {
    const original = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { json: async () => ({ ok: true, data: { imported: 2, updated: 0, rejected: [] } }) };
    };
    try {
      const r = await I.commit(
        [{ row: 2, sno: '1', name: 'a', major: '' }],
        'update-info',
        'http://x/api'
      );
      assert.strictEqual(r.imported, 2);
      assert.strictEqual(captured.url, 'http://x/api/import/commit');
      assert.strictEqual(captured.body.dupPolicy, 'update-info');
    } finally {
      global.fetch = original;
    }
  });

  await test('服务端返回失败时抛出带错误码的异常', async () => {
    const original = global.fetch;
    global.fetch = async () => ({
      json: async () => ({ ok: false, error: { code: 'DUPLICATE_SNO_IN_FILE', message: '重复' } }),
    });
    try {
      await assert.rejects(
        () => I.commit([]),
        (e) => e.code === 'DUPLICATE_SNO_IN_FILE'
      );
    } finally {
      global.fetch = original;
    }
  });

  await test('响应不是 JSON 时抛出 NETWORK_ERROR，不静默吞掉', async () => {
    const original = global.fetch;
    global.fetch = async () => ({
      json: async () => {
        throw new Error('bad json');
      },
    });
    try {
      await assert.rejects(
        () => I.commit([]),
        (e) => e.code === 'NETWORK_ERROR'
      );
    } finally {
      global.fetch = original;
    }
  });

  console.log('\n──────────────────────────────');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length > 0) {
    failures.forEach((f) => console.log('  ✗ ' + f.name + ' → ' + f.message));
    process.exit(1);
  }
})();
