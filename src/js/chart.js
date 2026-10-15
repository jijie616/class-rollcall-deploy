// 排行榜只展示服务端返回的数据，不在这里重排或补造积分。
export function buildRankingConfig(rows) {
  return {
    type: 'bar',
    data: {
      labels: rows.map((student) => student.name),
      datasets: [
        {
          label: '总积分',
          data: rows.map((s) => s.score),
          yAxisID: 'score',
          backgroundColor: rows.map((s) => (s.score < 0 ? '#d9798b' : '#3867f4')),
          borderRadius: 5,
          maxBarThickness: 42,
        },
        {
          type: 'line',
          label: '随机点名次数',
          data: rows.map((s) => s.onCallCount),
          yAxisID: 'count',
          borderColor: '#e8a448',
          backgroundColor: '#e8a448',
          tension: 0.2,
          pointRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title(items) {
              const s = rows[items[0]?.dataIndex];
              return s ? `${s.name} · ${s.sno} · ${s.major || '专业未填'}` : '';
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        // 不设 min: 0，负积分才能显示在零线下方。
        score: { beginAtZero: true, title: { display: true, text: '总积分' } },
        count: {
          beginAtZero: true,
          position: 'right',
          title: { display: true, text: '随机点名次数' },
          ticks: { precision: 0 },
          grid: { drawOnChartArea: false },
        },
      },
    },
  };
}

export function createRankingChart(ChartClass) {
  let instance = null;
  return {
    renderRanking(canvas, rows) {
      // Chart.js 不能在同一个 canvas 上重复创建实例，先释放旧图。
      this.destroy();
      if (!rows.length) return null;
      if (typeof ChartClass !== 'function') throw new Error('图表库未加载，请刷新后重试');
      instance = new ChartClass(canvas, buildRankingConfig(rows));
      return instance;
    },
    destroy() {
      instance?.destroy();
      instance = null;
    },
  };
}
