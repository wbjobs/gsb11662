// 长任务监控 + 堆内存采样

export class LongtaskMonitor {
  constructor() {
    this.count = 0;
    this.total = 0;
    this.supported = false;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.count += 1;
          this.total += entry.duration;
        }
      });
      this.observer.observe({ entryTypes: ['longtask'] });
      this.supported = true;
    } catch {
      this.observer = null;
    }
  }

  reset() {
    this.count = 0;
    this.total = 0;
  }

  summary() {
    if (!this.supported) return '—';
    return `${this.count} / ${this.total.toFixed(0)}`;
  }
}

export function heapMB() {
  if (performance.memory && typeof performance.memory.usedJSHeapSize === 'number') {
    return performance.memory.usedJSHeapSize / 1048576;
  }
  return null;
}

export function fmtMB(v) {
  return v === null || v === undefined ? '—' : v.toFixed(1);
}
