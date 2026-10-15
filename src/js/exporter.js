// 学号显式写成文本单元格；以 =、+ 等开头的文本也不会写为公式。
export const DETAIL_HEADERS = ['学号', '姓名', '专业', '随机点名次数', '总积分'];

export function buildDetailWorkbook(students, xlsx) {
  const matrix = [
    DETAIL_HEADERS,
    ...students.map((s) => [
      String(s.sno),
      String(s.name),
      String(s.major || ''),
      Number(s.onCallCount),
      Number(s.score),
    ]),
  ];
  const sheet = xlsx.utils.aoa_to_sheet(matrix);
  students.forEach((s, index) => {
    const cell = sheet[xlsx.utils.encode_cell({ r: index + 1, c: 0 })];
    cell.t = 's';
    cell.v = String(s.sno);
    cell.z = '@';
  });
  sheet['!cols'] = [22, 18, 28, 20, 16].map((wch) => ({ wch }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, sheet, '积分详单');
  // 汇总单独放一张表，便于把详单重新当作数据表读取。
  const total = students.reduce((sum, s) => sum + Math.round(Number(s.score) * 2), 0) / 2;
  xlsx.utils.book_append_sheet(
    book,
    xlsx.utils.aoa_to_sheet([
      ['总人数', '总积分'],
      [students.length, total],
    ]),
    '汇总'
  );
  return book;
}

export function detailFileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `点名积分详单_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.xlsx`;
}

export function createExporter(xlsx, onDownloaded = () => {}) {
  return {
    exportDetail(students) {
      if (!xlsx?.utils || typeof xlsx.writeFile !== 'function')
        throw new Error('Excel 导出库未加载');
      xlsx.writeFile(buildDetailWorkbook(students, xlsx), detailFileName());
      // 只能确认下载已发起，浏览器最终保存位置由用户决定。
      onDownloaded(students.length);
    },
  };
}
