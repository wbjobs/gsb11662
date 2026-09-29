// 分片调度：优先 requestIdleCallback，降级 setTimeout。
// 每个切片返回一个 remaining() 函数，工作循环据此让出主线程。

export function nextSlice(budgetMs) {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(
        (deadline) => {
          const start = performance.now();
          resolve(() =>
            Math.max(0, Math.min(deadline.timeRemaining(), budgetMs - (performance.now() - start)))
          );
        },
        { timeout: 50 }
      );
    } else {
      setTimeout(() => {
        const start = performance.now();
        resolve(() => Math.max(0, budgetMs - (performance.now() - start)));
      }, 0);
    }
  });
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('操作已被中断', 'AbortError');
  }
}

export function isAbort(err) {
  return err && err.name === 'AbortError';
}
