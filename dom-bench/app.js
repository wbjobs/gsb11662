'use strict';

/* ================= DOM 引用 ================= */
const $ = (id) => document.getElementById(id);
const sandbox = $('sandbox');
const tpl = $('node-tpl');
const statusEl = $('status');
const progressBar = $('progress-bar');
const resultBody = document.querySelector('#result-table tbody');
const chartCanvas = $('chart');
const ctx = chartCanvas.getContext('2d');

const ui = {
  strategy: $('m-strategy'), phase: $('m-phase'), progress: $('m-progress'),
  elapsed: $('m-elapsed'), memory: $('m-memory'), longtask: $('m-longtask'),
  drift: $('m-drift'), nodes: $('m-nodes'),
};

const STRATEGY_NAMES = {
  direct: '直接 DOM',
  fragment: 'DocumentFragment',
  innerHTML: 'innerHTML',
  template: '模板克隆',
};

/* ================= 全局状态 ================= */
const state = {
  running: false,
  abort: false,
  longtaskCount: 0,
  longtaskTime: 0,
  chunkTimes: [],   // 曲线：每片耗时
  memSeries: [],    // 曲线：内存 MB
  results: {},      // strategy -> 结果行
};

/* ================= 统计 Worker ================= */
const worker = new Worker('worker.js');
let latestStats = null;
worker.onmessage = (e) => {
  if (e.data.type === 'stats') {
    latestStats = e.data;
    ui.drift.textContent = `${e.data.drift >= 0 ? '+' : ''}${e.data.drift.toFixed(3)} ms/片`;
  }
};

/* ================= 长任务观测 ================= */
if ('PerformanceObserver' in window) {
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longtaskCount++;
        state.longtaskTime += entry.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) { /* 某些环境不支持 longtask */ }
}

/* ================= 工具函数 ================= */
const getMemoryMB = () =>
  (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null);

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#ff8a8a' : '#9fe6a0';
}

function updateMetrics(extra = {}) {
  ui.strategy.textContent = extra.strategy ?? ui.strategy.textContent;
  ui.phase.textContent = extra.phase ?? ui.phase.textContent;
  ui.progress.textContent = extra.progress ?? ui.progress.textContent;
  ui.elapsed.textContent = extra.elapsed ?? ui.elapsed.textContent;
  const mem = getMemoryMB();
  ui.memory.textContent = mem === null ? 'N/A(仅Chrome)' : `${mem.toFixed(1)} MB`;
  ui.longtask.textContent = `${state.longtaskCount} 次 / ${state.longtaskTime.toFixed(0)} ms`;
  ui.nodes.textContent = String(sandbox.childElementCount);
}

/* 分片调度器：让出主线程，保证渲染与交互不被阻塞 */
function makeScheduler(kind) {
  if (kind === 'idle' && 'requestIdleCallback' in window) {
    return () => new Promise((r) => requestIdleCallback(r, { timeout: 50 }));
  }
  if (kind === 'rAF') {
    return () => new Promise((r) => requestAnimationFrame(r));
  }
  return () => new Promise((r) => setTimeout(r, 0));
}

/* ================= 四种方案 ================= */
function buildNodeDirect(i) {
  const node = document.createElement('div');
  node.className = 'bench-node';
  const idx = document.createElement('span');
  idx.className = 'idx';
  idx.textContent = `#${i}`;
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = 'benchmark-node';
  node.append(idx, txt);
  return node;
}

const strategies = {
  direct: {
    insertChunk(start, count) {
      for (let i = start; i < start + count; i++) {
        sandbox.appendChild(buildNodeDirect(i));
      }
    },
    removeChunk(count) {
      for (let i = 0; i < count && sandbox.firstChild; i++) {
        sandbox.removeChild(sandbox.firstChild);
      }
    },
  },
  fragment: {
    insertChunk(start, count) {
      const frag = document.createDocumentFragment();
      for (let i = start; i < start + count; i++) {
        frag.appendChild(buildNodeDirect(i));
      }
      sandbox.appendChild(frag); // 片段出界即被回收
    },
    removeChunk(count) {
      for (let i = 0; i < count && sandbox.firstChild; i++) {
        sandbox.removeChild(sandbox.firstChild);
      }
    },
  },
  innerHTML: {
    insertChunk(start, count) {
      let html = '';
      for (let i = start; i < start + count; i++) {
        html += `<div class="bench-node"><span class="idx">#${i}</span><span class="txt">benchmark-node</span></div>`;
      }
      sandbox.insertAdjacentHTML('beforeend', html);
    },
    // innerHTML 的惯用清空方式：一次性回收，由浏览器内部优化
    removeAllAtOnce: true,
    removeChunk() {},
  },
  template: {
    insertChunk(start, count) {
      const frag = document.createDocumentFragment();
      for (let i = start; i < start + count; i++) {
        const clone = tpl.content.cloneNode(true);
        clone.querySelector('.idx').textContent = `#${i}`;
        frag.appendChild(clone);
      }
      sandbox.appendChild(frag);
    },
    removeChunk(count) {
      for (let i = 0; i < count && sandbox.firstChild; i++) {
        sandbox.removeChild(sandbox.firstChild);
      }
    },
  },
};

/* ================= 性能曲线 ================= */
function drawChart() {
  const W = chartCanvas.width, H = chartCanvas.height;
  const pad = { l: 46, r: 46, t: 14, b: 20 };
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#101826';
  ctx.fillRect(0, 0, W, H);

  const times = state.chunkTimes.slice(-400);
  const mems = state.memSeries.slice(-400);
  if (!times.length && !mems.length) {
    ctx.fillStyle = '#8b94a8';
    ctx.font = '13px sans-serif';
    ctx.fillText('暂无数据 —— 运行测试后此处显示每片耗时与内存曲线', pad.l, H / 2);
    return;
  }

  const maxT = Math.max(1, ...times);
  const maxM = Math.max(1, ...mems);
  const n = Math.max(times.length, mems.length);
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const yT = (v) => H - pad.b - (v / maxT) * (H - pad.t - pad.b);
  const yM = (v) => H - pad.b - (v / maxM) * (H - pad.t - pad.b);

  // 网格与坐标
  ctx.strokeStyle = '#232c42';
  ctx.fillStyle = '#8b94a8';
  ctx.font = '10px monospace';
  for (let g = 0; g <= 4; g++) {
    const gy = pad.t + (g / 4) * (H - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    ctx.fillText(`${(maxT * (1 - g / 4)).toFixed(1)}ms`, 4, gy + 3);
    ctx.fillText(`${(maxM * (1 - g / 4)).toFixed(0)}MB`, W - pad.r + 6, gy + 3);
  }

  const plot = (arr, yFn, color) => {
    if (arr.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    arr.forEach((v, i) => (i ? ctx.lineTo(x(i), yFn(v)) : ctx.moveTo(x(i), yFn(v))));
    ctx.stroke();
  };
  plot(times, yT, '#5b8def');
  plot(mems, yM, '#5fd68a');
  ctx.lineWidth = 1;
}

/* ================= 核心执行器 ================= */
async function runPhase(name, total, chunkSize, schedule, doChunk) {
  let done = 0;
  const times = [];
  const t0 = performance.now();
  while (done < total) {
    if (state.abort) return { aborted: true, times, elapsed: performance.now() - t0 };
    const n = Math.min(chunkSize, total - done);
    const c0 = performance.now();
    doChunk(done, n);
    const cost = performance.now() - c0;
    times.push(cost);
    state.chunkTimes.push(cost);

    // 可调采样频率的内存采样
    const sampleEvery = Number($('opt-sample').value);
    let mem = null;
    if (times.length % sampleEvery === 0) {
      mem = getMemoryMB();
      if (mem !== null) state.memSeries.push(mem);
    }
    worker.postMessage({ type: 'sample', duration: cost, memory: mem });

    done += n;
    updateMetrics({
      phase: name,
      progress: `${done} / ${total}`,
      elapsed: `${(performance.now() - t0).toFixed(0)} ms`,
    });
    progressBar.value = (done / total) * 100;
    drawChart();
    await schedule(); // 让出主线程：渲染、输入、长任务观测均不被阻塞
  }
  return { aborted: false, times, elapsed: performance.now() - t0 };
}

async function runStrategy(key) {
  const total = Number($('opt-count').value);
  const chunkSize = Number($('opt-chunk').value);
  const schedule = makeScheduler($('opt-scheduler').value);
  const st = strategies[key];

  worker.postMessage({ type: 'reset' });
  latestStats = null;
  state.chunkTimes = [];
  state.memSeries = [];
  state.longtaskCount = 0;
  state.longtaskTime = 0;
  sandbox.textContent = '';
  updateMetrics({ strategy: STRATEGY_NAMES[key], phase: '准备', progress: `0 / ${total}` });

  const baselineMem = getMemoryMB();

  // ---- 插入阶段 ----
  const ins = await runPhase('插入', total, chunkSize, schedule,
    (start, n) => st.insertChunk(start, n));
  if (ins.aborted) return null;

  const insertedCount = sandbox.childElementCount;

  // ---- 删除阶段 ----
  let rem;
  if (st.removeAllAtOnce) {
    const t0 = performance.now();
    sandbox.innerHTML = '';
    const cost = performance.now() - t0;
    state.chunkTimes.push(cost);
    worker.postMessage({ type: 'sample', duration: cost, memory: getMemoryMB() });
    rem = { aborted: false, times: [cost], elapsed: cost };
    updateMetrics({ phase: '删除', progress: `0 / ${total}` });
    progressBar.value = 100;
    drawChart();
  } else {
    rem = await runPhase('删除', total, chunkSize, schedule,
      (_s, n) => st.removeChunk(n));
    if (rem.aborted) return null;
  }

  worker.postMessage({ type: 'flush' });
  await new Promise((r) => setTimeout(r, 30)); // 等 Worker 回传最终统计

  const peakMem = latestStats ? latestStats.peakMemory : 0;
  const consistent = insertedCount === total && sandbox.childElementCount === 0;

  const result = {
    strategy: STRATEGY_NAMES[key],
    insertMs: ins.elapsed,
    removeMs: rem.elapsed,
    totalMs: ins.elapsed + rem.elapsed,
    peakMemMB: peakMem,
    memDeltaMB: (baselineMem !== null && peakMem) ? peakMem - baselineMem : null,
    avgChunk: latestStats ? latestStats.meanDuration : 0,
    p95Chunk: latestStats ? latestStats.p95Duration : 0,
    longtasks: `${state.longtaskCount} 次`,
    drift: latestStats ? latestStats.drift : 0,
    consistent,
  };
  state.results[key] = result;
  renderResults();
  return result;
}

/* ================= 结果表 ================= */
function renderResults() {
  const keys = Object.keys(state.results);
  const best = keys.length
    ? keys.reduce((a, b) => (state.results[a].totalMs <= state.results[b].totalMs ? a : b))
    : null;
  resultBody.innerHTML = '';
  for (const k of ['direct', 'fragment', 'innerHTML', 'template']) {
    const r = state.results[k];
    if (!r) continue;
    const tr = document.createElement('tr');
    if (k === best) tr.className = 'best';
    const fmt = (v, d = 1) => (v === null || v === undefined ? 'N/A' : v.toFixed(d));
    tr.innerHTML =
      `<td>${r.strategy}${k === best ? ' ★' : ''}</td>` +
      `<td>${fmt(r.insertMs, 0)} ms</td><td>${fmt(r.removeMs, 0)} ms</td>` +
      `<td>${fmt(r.totalMs, 0)} ms</td>` +
      `<td>${r.peakMemMB ? fmt(r.peakMemMB) + ' MB' : 'N/A'}</td>` +
      `<td>${r.memDeltaMB === null ? 'N/A' : '+' + fmt(r.memDeltaMB) + ' MB'}</td>` +
      `<td>${fmt(r.avgChunk, 2)} ms</td><td>${fmt(r.p95Chunk, 2)} ms</td>` +
      `<td>${r.longtasks}</td>` +
      `<td>${r.drift >= 0 ? '+' : ''}${fmt(r.drift, 3)} ms/片</td>` +
      `<td class="${r.consistent ? 'ok' : 'bad'}">${r.consistent ? '✓ 一致' : '✗ 不一致'}</td>`;
    resultBody.appendChild(tr);
  }
}

/* ================= 控制逻辑 ================= */
function setRunning(running) {
  state.running = running;
  $('btn-stop').disabled = !running;
  document.querySelectorAll('[data-strategy], #btn-run-all, #btn-clear, #btn-reset')
    .forEach((b) => (b.disabled = running));
}

async function guardedRun(fn) {
  if (state.running) return;
  state.abort = false;
  setRunning(true);
  try {
    await fn();
    if (state.abort) setStatus('⚠ 操作已被中断。可点击「清空节点」回收剩余节点。');
  } catch (err) {
    setStatus(`出错：${err.message}`, true);
  } finally {
    setRunning(false);
    updateMetrics({ phase: state.abort ? '已中断' : '完成' });
  }
}

document.querySelectorAll('[data-strategy]').forEach((btn) => {
  btn.addEventListener('click', () => guardedRun(async () => {
    const key = btn.dataset.strategy;
    setStatus(`正在运行：${STRATEGY_NAMES[key]} …`);
    const r = await runStrategy(key);
    if (r) setStatus(`✔ ${STRATEGY_NAMES[key]} 完成：插入 ${r.insertMs.toFixed(0)} ms，删除 ${r.removeMs.toFixed(0)} ms，一致性 ${r.consistent ? '通过' : '未通过'}`);
  }));
});

$('btn-run-all').addEventListener('click', () => guardedRun(async () => {
  for (const key of ['direct', 'fragment', 'innerHTML', 'template']) {
    if (state.abort) break;
    setStatus(`正在运行：${STRATEGY_NAMES[key]} …`);
    await runStrategy(key);
    await new Promise((r) => setTimeout(r, 300)); // 让浏览器有机会 GC，避免方案间内存干扰
  }
  if (!state.abort) setStatus('✔ 全部方案运行完成，结果见对比表（★ 为总耗时最优）。');
}));

$('btn-stop').addEventListener('click', () => { state.abort = true; });

$('btn-clear').addEventListener('click', () => guardedRun(async () => {
  setStatus('正在分片清空节点 …');
  const schedule = makeScheduler($('opt-scheduler').value);
  const total = sandbox.childElementCount;
  await runPhase('清空', total, Number($('opt-chunk').value), schedule, (_s, n) => {
    for (let i = 0; i < n && sandbox.firstChild; i++) sandbox.removeChild(sandbox.firstChild);
  });
  setStatus('✔ 节点已清空，引用已释放，等待浏览器 GC 回收。');
}));

$('btn-reset').addEventListener('click', () => {
  state.results = {};
  state.chunkTimes = [];
  state.memSeries = [];
  state.longtaskCount = 0;
  state.longtaskTime = 0;
  worker.postMessage({ type: 'reset' });
  latestStats = null;
  resultBody.innerHTML = '';
  progressBar.value = 0;
  ui.drift.textContent = '—';
  updateMetrics({ strategy: '—', phase: '—', progress: '0 / 0', elapsed: '0 ms' });
  drawChart();
  setStatus('已重置。结果、曲线与统计均已清空。');
});

/* ================= 初始化 ================= */
updateMetrics({ strategy: '—', phase: '—', progress: '0 / 0', elapsed: '0 ms' });
drawChart();
setInterval(() => { if (!state.running) updateMetrics(); }, 2000);
