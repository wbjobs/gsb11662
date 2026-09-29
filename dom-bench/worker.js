// 统计 Worker：在后台线程计算均值 / P95 / 漂移斜率，避免占用主线程。
let durations = [];
let memories = [];

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// 最小二乘线性回归斜率（ms/片），用于检测长时间运行漂移
function driftSlope(arr) {
  const n = arr.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += arr[i]; sxy += i * arr[i]; sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function report() {
  self.postMessage({
    type: 'stats',
    count: durations.length,
    meanDuration: mean(durations),
    p95Duration: percentile(durations, 95),
    drift: driftSlope(durations),
    meanMemory: mean(memories),
    peakMemory: memories.length ? Math.max(...memories) : 0,
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'reset') {
    durations = [];
    memories = [];
  } else if (msg.type === 'sample') {
    durations.push(msg.duration);
    if (typeof msg.memory === 'number') memories.push(msg.memory);
    // 每 10 片回传一次统计，降低通信开销
    if (durations.length % 10 === 0) report();
  } else if (msg.type === 'flush') {
    report();
  }
};
