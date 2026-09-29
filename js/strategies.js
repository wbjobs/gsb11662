// 四种批量增删方案。所有方案都按时间片让出主线程，支持 AbortSignal 中断。
import { nextSlice, throwIfAborted } from './scheduler.js';

// ---------- 数据源（Web Worker 桥接） ----------
export function createDataSource(worker) {
  let seq = 0;
  const pending = new Map();
  worker.addEventListener('message', (e) => {
    const d = e.data;
    const resolve = pending.get(d.reqId);
    if (resolve) {
      pending.delete(d.reqId);
      resolve(d);
    }
  });
  const call = (msg) =>
    new Promise((resolve) => {
      const reqId = ++seq;
      pending.set(reqId, resolve);
      worker.postMessage({ ...msg, reqId });
    });
  return {
    getChunk: (start, size) => call({ type: 'chunk', start, size }).then((d) => d.items),
    getHtml: (count) => call({ type: 'html', count }).then((d) => d.html),
  };
}

// ---------- 节点池（模板克隆方案的回收复用） ----------
const POOL_CAP = 20000; // 上限防止内存无限占用
const pool = [];
export const getPoolSize = () => pool.length;
export const clearPool = () => { pool.length = 0; };

// ---------- 节点构造 ----------
function makeNodeDirect(item) {
  const div = document.createElement('div');
  div.className = 'node';
  const b = document.createElement('b');
  b.textContent = '#' + item.id;
  const span = document.createElement('span');
  span.textContent = item.text;
  div.append(b, span);
  return div;
}

let templateEl = null;
function makeNodeFromTemplate(item) {
  if (!templateEl) templateEl = document.getElementById('node-template');
  // 优先复用池中的节点，否则克隆模板
  const node = pool.pop() || templateEl.content.firstElementChild.cloneNode(true);
  node.firstElementChild.textContent = '#' + item.id;
  node.lastElementChild.textContent = item.text;
  return node;
}

// ---------- 通用分片数据消费骨架 ----------
// produce(item) -> Node；flush 由调用方决定（直接挂 / fragment 批量挂）
async function consumeChunks(ctx, produce, flushPerSlice) {
  const { data, count, chunkSize, budgetMs, signal, onSlice, onProgress } = ctx;
  let items = [];
  let idx = 0;
  let fetched = 0;
  let done = 0;
  while (done < count) {
    throwIfAborted(signal);
    if (idx >= items.length) {
      items = await data.getChunk(fetched, Math.min(chunkSize, count - fetched));
      fetched += items.length;
      idx = 0;
    }
    const remaining = await nextSlice(budgetMs);
    const t0 = performance.now();
    const frag = flushPerSlice ? document.createDocumentFragment() : null;
    while (idx < items.length && remaining() > 1) {
      const node = produce(items[idx++]);
      (frag || ctx.container).appendChild(node);
    }
    if (frag) ctx.container.appendChild(frag);
    done = fetched - (items.length - idx);
    if (idx >= items.length) items = []; // 及时释放已消费数据
    onSlice(performance.now() - t0);
    onProgress(done, count);
  }
}

// ---------- 新增 ----------
export async function addNodes(strategy, ctx) {
  switch (strategy) {
    case 'direct':
      // 每个节点 createElement 并直接 appendChild 到容器
      return consumeChunks(ctx, makeNodeDirect, false);
    case 'template':
      // 模板克隆（含节点池复用），每片用 fragment 批量挂载
      return consumeChunks(ctx, makeNodeFromTemplate, true);
    case 'fragment': {
      // 全部节点先挂到一个 DocumentFragment，最后一次 append（仅一次回流）
      const frag = document.createDocumentFragment();
      const sub = { ...ctx, container: frag };
      await consumeChunks(sub, makeNodeDirect, false);
      throwIfAborted(ctx.signal);
      const remaining = await nextSlice(ctx.budgetMs);
      void remaining;
      const t0 = performance.now();
      ctx.container.appendChild(frag);
      ctx.onSlice(performance.now() - t0);
      return;
    }
    case 'innerhtml': {
      // HTML 字符串在 Worker 中构建，主线程仅一次 innerHTML 赋值
      ctx.onProgress(0, ctx.count, 'Worker 构建 HTML 字符串…');
      const html = await ctx.data.getHtml(ctx.count);
      throwIfAborted(ctx.signal);
      const t0 = performance.now();
      ctx.container.innerHTML = html;
      ctx.onSlice(performance.now() - t0);
      ctx.onProgress(ctx.count, ctx.count);
      return;
    }
    default:
      throw new Error('未知方案: ' + strategy);
  }
}

// ---------- 删除 ----------
export async function removeNodes(strategy, ctx) {
  const { container, budgetMs, signal, onSlice, onProgress } = ctx;
  const total = container.childElementCount;

  const chunkedRemove = (recycle) => async () => {
    let removed = 0;
    while (container.firstChild) {
      throwIfAborted(signal);
      const remaining = await nextSlice(budgetMs);
      const t0 = performance.now();
      while (container.firstChild && remaining() > 1) {
        const node = container.firstChild;
        container.removeChild(node);
        if (recycle && pool.length < POOL_CAP) {
          node.firstElementChild.textContent = '';
          node.lastElementChild.textContent = '';
          pool.push(node); // 回收进池，供下次复用
        }
        removed++;
      }
      onSlice(performance.now() - t0);
      onProgress(removed, total);
    }
  };

  switch (strategy) {
    case 'direct':
      return chunkedRemove(false)();
    case 'template':
      return chunkedRemove(true)();
    case 'fragment': {
      // replaceChildren() 一次性摘除全部子节点
      throwIfAborted(signal);
      const t0 = performance.now();
      container.replaceChildren();
      onSlice(performance.now() - t0);
      onProgress(total, total);
      return;
    }
    case 'innerhtml': {
      throwIfAborted(signal);
      const t0 = performance.now();
      container.innerHTML = '';
      onSlice(performance.now() - t0);
      onProgress(total, total);
      return;
    }
    default:
      throw new Error('未知方案: ' + strategy);
  }
}
