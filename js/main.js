import { isAbort } from './scheduler.js';
import { LongtaskMonitor, heapMB, fmtMB } from './metrics.js';
import { PerfChart } from './chart.js';
import { createDataSource, addNodes, removeNodes, getPoolSize, clearPool } from './strategies.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const statusEl = $('status');
const progressFill = $('progress-fill');
const stageCount = $('stage-count');
const poolSize = $('pool-size');
const logEl = $('log');

const STRATEGY_NAMES = {
  direct: '直接操作 DOM',
  fragment: 'DocumentFragment',
  innerhtml: 'innerHTML',
  template: '模板克隆',
};

const worker = new Worker('js/data-worker.js');
worker.addEventListener('error', (e) => log('Worker 错误：' + e.message, 'err'));
const data = createDataSource(worker);
const monitor = new LongtaskMonitor();
const chart = new PerfChart($('perf-chart'));

const stats = {}; // strategy -> {addMs, removeMs, addMem, removeMem, longtasks, addCount, removeCount}

let abortCtrl = null;
let busy = false;
let sampler = null;

// ---------- 日志（条数封顶，长时间运行不漂移） ----------
const LOG_CAP = 150;
function log(msg, cls = '') {
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.innerHTML = `<span class="t">${time}</span><span class="${cls}"></span>`;
  line.lastElementChild.textContent = msg;
  logEl.prepend(line);
  while (logEl.childElementCount > LOG_CAP) logEl.lastElementChild.remove();
}

// ---------- UI 状态 ----------
function setBusy(v) {
  busy = v;
  for (const id of ['btn-add', 'btn-remove', 'btn-compare', 'btn-clear', 'btn-reset']) {
    $(id).disabled = v;
  }
  $('btn-abort').disabled = !v;
}

function setStatus(text) { statusEl.textContent = text; }

function onProgressFactory(label) {
  return (done, total, note) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    setStatus(note || `${label} ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
    stageCount.textContent = `${stage.childElementCount.toLocaleString()} 节点`;
    poolSize.textContent = `节点池 ${getPoolSize().toLocaleString()}`;
  };
}

function startSampler() {
  const interval = Number($('sample-interval').value);
  stopSampler();
  sampler = setInterval(() => chart.pushHeap(heapMB()), interval);
}
function stopSampler() {
  if (sampler) { clearInterval(sampler); sampler = null; }
}

function readConfig() {
  return {
    strategy: $('strategy').value,
    count: Math.max(1000, Math.min(300000, Number($('node-count').value) || 100000)),
    chunkSize: Number($('chunk-size').value),
    budgetMs: Number($('budget-ms').value),
  };
}

function recordStat(strategy, patch) {
  stats[strategy] = { ...(stats[strategy] || {}), ...patch };
  renderStats();
}

function renderStats() {
  for (const tr of document.querySelectorAll('#stats-table tbody tr')) {
    const s = stats[tr.dataset.strategy];
    const tds = tr.children;
    if (!s) continue;
    tds[1].textContent = s.addMs !== undefined ? s.addMs.toFixed(0) : '—';
    tds[2].textContent = s.removeMs !== undefined ? s.removeMs.toFixed(0) : '—';
    tds[3].textContent = s.addMem !== undefined ? fmtMB(s.addMem) : '—';
    tds[4].textContent = s.removeMem !== undefined ? fmtMB(s.removeMem) : '—';
    tds[5].textContent = s.longtasks || '—';
    tds[6].className = '';
    if (s.addCount !== undefined && s.removeCount !== undefined) {
      const ok = s.addCount === s.expected && s.removeCount === 0;
      tds[6].textContent = ok ? `✓ ${s.addCount.toLocaleString()}` : '✗ 不一致';
      tds[6].className = ok ? 'ok' : 'bad';
    } else if (s.addCount !== undefined) {
      tds[6].textContent = `新增 ${s.addCount.toLocaleString()}`;
    }
  }
}

// ---------- 执行一个阶段（新增/删除），统一采集指标 ----------
async function runPhase(kind, strategy, count, chunkSize, budgetMs) {
  const label = kind === 'add' ? '新增' : '删除';
  const name = STRATEGY_NAMES[strategy];
  monitor.reset();
  const before = heapMB();
  const t0 = performance.now();
  const ctx = {
    container: stage,
    data,
    count,
    chunkSize,
    budgetMs,
    signal: abortCtrl.signal,
    onSlice: (ms) => chart.pushSlice(ms),
    onProgress: onProgressFactory(`${name} ${label}`),
  };
  if (kind === 'add') await addNodes(strategy, ctx);
  else await removeNodes(strategy, ctx);
  const elapsed = performance.now() - t0;
  // longtask 条目异步投递，让出事件循环后再汇总
  await new Promise((r) => setTimeout(r, 60));
  const after = heapMB();
  const memDelta = before !== null && after !== null ? after - before : undefined;

  const patch = { longtasks: monitor.summary() };
  if (kind === 'add') {
    patch.addMs = elapsed;
    if (memDelta !== undefined) patch.addMem = memDelta;
    patch.addCount = stage.childElementCount;
    patch.expected = count;
  } else {
    patch.removeMs = elapsed;
    if (memDelta !== undefined) patch.removeMem = memDelta;
    patch.removeCount = stage.childElementCount;
  }
  recordStat(strategy, patch);

  const memText = memDelta !== undefined ? `，堆Δ ${memDelta >= 0 ? '+' : ''}${memDelta.toFixed(1)} MB` : '';
  log(`${name} ${label}完成：${elapsed.toFixed(0)} ms${memText}，长任务 ${monitor.summary()}`, 'ok');
  return elapsed;
}

// ---------- 操作 ----------
async function guarded(fn) {
  if (busy) return;
  busy = true;
  setBusy(true);
  abortCtrl = new AbortController();
  startSampler();
  try {
    await fn();
  } catch (err) {
    if (isAbort(err)) log('操作已中断', 'warn');
    else { console.error(err); log('错误：' + err.message, 'err'); }
  } finally {
    stopSampler();
    setBusy(false);
    busy = false;
    progressFill.style.width = '0%';
    stageCount.textContent = `${stage.childElementCount.toLocaleString()} 节点`;
    poolSize.textContent = `节点池 ${getPoolSize().toLocaleString()}`;
  }
}

$('btn-add').addEventListener('click', () => {
  const c = readConfig();
  guarded(async () => {
    await runPhase('add', c.strategy, c.count, c.chunkSize, c.budgetMs);
    setStatus('新增完成');
  });
});

$('btn-remove').addEventListener('click', () => {
  const c = readConfig();
  guarded(async () => {
    await runPhase('remove', c.strategy, c.count, c.chunkSize, c.budgetMs);
    setStatus('删除完成');
  });
});

$('btn-compare').addEventListener('click', () => {
  const c = readConfig();
  guarded(async () => {
    const results = {};
    for (const strategy of Object.keys(STRATEGY_NAMES)) {
      setStatus(`对比运行中：${STRATEGY_NAMES[strategy]}`);
      await clearStageChunked(c.budgetMs, abortCtrl.signal);
      await runPhase('add', strategy, c.count, c.chunkSize, c.budgetMs);
      results[strategy] = stage.childElementCount;
      await runPhase('remove', strategy, c.count, c.chunkSize, c.budgetMs);
    }
    const counts = Object.values(results);
    const consistent = counts.every((n) => n === c.count) && stage.childElementCount === 0;
    log(
      consistent
        ? `四种方案结果一致：均新增 ${c.count.toLocaleString()} 节点并全部删除 ✓`
        : `结果不一致：${JSON.stringify(results)}`,
      consistent ? 'ok' : 'err'
    );
    setStatus('对比完成');
  });
});

$('btn-abort').addEventListener('click', () => {
  abortCtrl?.abort();
  setStatus('正在中断…');
});

async function clearStageChunked(budgetMs, signal) {
  if (!stage.firstChild) return;
  const onProgress = onProgressFactory('清空');
  const total = stage.childElementCount;
  let removed = 0;
  const { nextSlice, throwIfAborted } = await import('./scheduler.js');
  while (stage.firstChild) {
    throwIfAborted(signal);
    const remaining = await nextSlice(budgetMs);
    while (stage.firstChild && remaining() > 1) {
      stage.removeChild(stage.firstChild);
      removed++;
    }
    onProgress(removed, total);
  }
}

$('btn-clear').addEventListener('click', () => {
  const c = readConfig();
  guarded(async () => {
    await clearStageChunked(c.budgetMs, abortCtrl.signal);
    log('舞台已清空');
    setStatus('已清空');
  });
});

$('btn-reset').addEventListener('click', () => {
  guarded(async () => {
    const c = readConfig();
    await clearStageChunked(c.budgetMs, abortCtrl.signal);
    clearPool();
    for (const k of Object.keys(stats)) delete stats[k];
    renderStats();
    chart.clear();
    logEl.textContent = '';
    log('已重置：舞台、统计数据、曲线、节点池全部清空');
    setStatus('就绪');
  });
});

log('就绪。选择方案后点击「批量新增」，或点击「对比全部方案」一键跑完四种方案。');
if (!monitor.supported) log('当前浏览器不支持 longtask 观察，长任务列将显示 —', 'warn');
if (heapMB() === null) log('当前浏览器不支持 performance.memory，堆内存列将显示 —', 'warn');
