'use strict';

// 使用真实 SheetJS 写出并回读，重点检查文本学号、完整名单和公式风险。
const assert = require('node:assert/strict');
const XLSX = require('../lib/xlsx.full.min.js');

(async () => {
  const { buildDetailWorkbook, createExporter, detailFileName, DETAIL_HEADERS } = await import(
    '../src/js/exporter.js'
  );
  const rows = Array.from({ length: 15 }, (_, i) => ({
    sno: String(i).padStart(5, '0'),
    name: i === 0 ? '=1+1' : `学生${i}`,
    major: '软件工程',
    onCallCount: i,
    score: i === 0 ? -1 : i / 2,
  }));
  const before = structuredClone(rows);
  const book = buildDetailWorkbook(rows, XLSX);
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const restored = XLSX.read(bytes, { type: 'buffer' });
  const sheet = restored.Sheets['积分详单'];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(matrix[0], DETAIL_HEADERS);
  assert.equal(matrix.length, 16, '应包含全部 15 人，而不是仅前 10 人');
  assert.equal(sheet.A2.v, '00000');
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.B2.v, '=1+1');
  assert.equal(sheet.B2.f, undefined, '姓名不能成为 Excel 公式');
  assert.equal(sheet.E2.v, -1);
  assert.deepEqual(rows, before, '导出不能修改主控的名单');
  assert.equal(restored.Sheets['汇总'].A2.v, rows.length);
  assert.equal(
    restored.Sheets['汇总'].B2.v,
    rows.reduce((sum, s) => sum + s.score, 0)
  );
  assert.equal(
    XLSX.utils.sheet_to_json(buildDetailWorkbook([], XLSX).Sheets['积分详单'], { header: 1 })
      .length,
    1
  );
  assert.equal(detailFileName(new Date(2026, 9, 15, 2, 3)), '点名积分详单_20261015_0203.xlsx');
  let written = false;
  let notified = 0;
  createExporter(
    {
      ...XLSX,
      writeFile(wb, name) {
        assert.ok(wb.Sheets['积分详单']);
        assert.ok(name.endsWith('.xlsx'));
        written = true;
      },
    },
    (count) => {
      notified = count;
    }
  ).exportDetail(rows);
  assert.ok(written);
  assert.equal(notified, 15);
  assert.throws(
    () =>
      createExporter(
        {
          ...XLSX,
          writeFile() {
            throw new Error('download failed');
          },
        },
        () => assert.fail('失败不能显示下载成功')
      ).exportDetail(rows),
    /download failed/
  );
  console.log(
    '导出验证通过：真实 xlsx 回读、15 人全量、前导零、负分、文本公式防护、空表、汇总及下载回调。'
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
