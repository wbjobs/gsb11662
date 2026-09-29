// Canvas 性能曲线：分片耗时 + JS 堆内存。
// 数据存固定容量环形缓冲区，长时间运行内存不漂移；仅 dirty 时在 rAF 中重绘。

export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.head = 0;
    this.size = 0;
  }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }
  at(i) {
    return this.buf[(this.head - this.size + i + this.capacity) % this.capacity];
  }
  get last() {
    return this.size ? this.at(this.size - 1) : null;
  }
  clear() {
    this.head = 0;
    this.size = 0;
  }
}

export class PerfChart {
  constructor(canvas, capacity = 1200) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sliceMs = new RingBuffer(capacity);
    this.heap = new RingBuffer(capacity);
    this.dirty = true;
    this._resize();
    new ResizeObserver(() => { this._resize(); this.dirty = true; }).observe(canvas);
    const loop = () => {
      if (this.dirty) { this._draw(); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  pushSlice(ms) { this.sliceMs.push(ms); this.dirty = true; }
  pushHeap(mb) { if (mb !== null && mb !== undefined) { this.heap.push(mb); this.dirty = true; } }

  clear() {
    this.sliceMs.clear();
    this.heap.clear();
    this.dirty = true;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth || 600;
    this.h = this.canvas.clientHeight || 240;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _draw() {
    const { ctx, w, h } = this;
    const padL = 46, padR = 52, padT = 14, padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0d1322';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#1c2740';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    let maxSlice = 1;
    for (let i = 0; i < this.sliceMs.size; i++) {
      maxSlice = Math.max(maxSlice, this.sliceMs.at(i));
    }
    let maxHeap = 0, minHeap = Infinity;
    for (let i = 0; i < this.heap.size; i++) {
      const v = this.heap.at(i);
      if (v > maxHeap) maxHeap = v;
      if (v < minHeap) minHeap = v;
    }

    // 分片耗时折线（左轴，线性 0..maxSlice）
    if (this.sliceMs.size >= 2) {
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < this.sliceMs.size; i++) {
        const x = padL + (plotW * i) / (this.sliceMs.capacity - 1);
        const y = padT + plotH - (plotH * this.sliceMs.at(i)) / (maxSlice * 1.15);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 堆内存折线（右轴，按 min..max 归一化，波动可见）
    if (this.heap.size >= 2) {
      const span = Math.max(maxHeap - minHeap, 1);
      ctx.strokeStyle = '#ffb454';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < this.heap.size; i++) {
        const x = padL + (plotW * i) / (this.heap.capacity - 1);
        const y = padT + plotH - (plotH * (this.heap.at(i) - minHeap)) / span;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = '#4cc2ff';
    ctx.textAlign = 'left';
    ctx.fillText(maxSlice.toFixed(0) + ' ms', 4, padT + 8);
    ctx.fillText('0', 10, padT + plotH);
    if (this.heap.size) {
      ctx.fillStyle = '#ffb454';
      ctx.textAlign = 'right';
      ctx.fillText(maxHeap.toFixed(0) + ' MB', w - 4, padT + 8);
      ctx.fillText(minHeap.toFixed(0) + ' MB', w - 4, padT + plotH);
    }

    const lastSlice = this.sliceMs.last;
    const lastHeap = this.heap.last;
    const info = [
      lastSlice !== null ? `最近分片 ${lastSlice.toFixed(1)} ms` : null,
      lastHeap !== null ? `堆 ${lastHeap.toFixed(1)} MB` : null,
      `样本 ${Math.max(this.sliceMs.size, this.heap.size)}/${this.sliceMs.capacity}`,
    ].filter(Boolean).join('    ');
    ctx.fillStyle = '#8a97b5';
    ctx.textAlign = 'left';
    ctx.fillText(info, padL, h - 8);
  }
}
