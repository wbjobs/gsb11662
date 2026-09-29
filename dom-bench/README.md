# DOM 批量增删性能对比实验台

纯原生技术（无框架）对比四种批量操作 10 万级 DOM 节点的方案：

| 方案 | 插入方式 | 删除方式 |
|---|---|---|
| 直接 DOM | 逐节点 `createElement` + `appendChild` | 逐节点 `removeChild` |
| DocumentFragment | 片内构建片段，每片一次挂载 | 逐节点 `removeChild` |
| innerHTML | 片内拼接 HTML 字符串，`insertAdjacentHTML` | 一次性 `innerHTML = ''` |
| 模板克隆 | `<template>` 克隆 + 片段挂载 | 逐节点 `removeChild` |

## 运行

需要通过 HTTP 访问（Web Worker 不支持 file:// 协议）：

```bash
cd dom-bench
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

推荐 Chrome / Edge：内存指标依赖 `performance.memory`（仅 Chromium 提供），
其他浏览器内存列显示 N/A，其余功能正常。

## 功能

- **批量增删**：可选 1 万 / 5 万 / 10 万 / 20 万节点，分片执行（每片 500–5000 可调）。
- **不阻塞主线程**：分片间通过 `requestIdleCallback`（可切换 `setTimeout` / `rAF`）让出主线程，渲染与交互不卡顿。
- **可中断**：「中断」按钮在片间生效；「清空节点」分片回收残留节点；「重置」清空结果与曲线。
- **性能曲线**：Canvas 实时绘制每片耗时（蓝）与 JS 堆内存（绿），采样频率可调。
- **内存可观测**：每片采样 `usedJSHeapSize`，报告峰值与相对基线增量。
- **长任务监控**：`PerformanceObserver('longtask')` 统计 >50ms 任务次数与总时长。
- **漂移检测**：Web Worker 后台对片耗时做最小二乘回归，输出斜率（ms/片），长时间运行是否劣化一目了然。
- **一致性校验**：每次运行后校验插入数 == 目标数且删除后容器为空。
- **结果对比表**：插入/删除/总耗时、峰值内存、内存增量、片均与 P95 片耗时、长任务、漂移，★ 标记最优方案。

## 文件

- `index.html` — 页面结构与控制面板
- `styles.css` — 深色主题样式
- `app.js` — 四种方案实现、分片调度器、曲线绘制、结果汇总
- `worker.js` — 后台统计（均值 / P95 / 漂移斜率），不占用主线程

## 指标解读建议

- **总耗时**：innerHTML 通常插入最快（浏览器 HTML 解析器高度优化）；逐节点直接 DOM 最慢。
- **删除**：innerHTML 一次性清空最快但可能产生一个长任务；逐节点删除耗时长但平滑。
- **漂移斜率**：接近 0 表示长时间运行稳定；持续为正说明存在泄漏或退化。
- **内存增量**：方案间对比时先点「重置」并留间隔让 GC 回收，减少相互干扰。
