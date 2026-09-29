// 数据生成 Worker：把节点数据 / HTML 字符串的构建移出主线程

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'chunk') {
    const items = new Array(d.size);
    for (let i = 0; i < d.size; i++) {
      const id = d.start + i;
      items[i] = { id, text: `性能对比演示数据 · 行 ${id}` };
    }
    self.postMessage({ reqId: d.reqId, type: 'chunk', items });
  } else if (d.type === 'html') {
    // 分段拼接，避免一次性超大字符串分配抖动
    const parts = [];
    const SEG = 5000;
    for (let s = 0; s < d.count; s += SEG) {
      const end = Math.min(s + SEG, d.count);
      let seg = '';
      for (let i = s; i < end; i++) {
        seg += `<div class="node"><b>#${i}</b><span>性能对比演示数据 · 行 ${i}</span></div>`;
      }
      parts.push(seg);
    }
    self.postMessage({ reqId: d.reqId, type: 'html', html: parts.join('') });
  }
};
