# DOM 批量增删性能对比

纯原生 Web 技术（无框架）对比四种批量增删 10 万 DOM 节点方案的性能：

| 方案 | 新增 | 删除 |
| --- | --- | --- |
| 直接操作 DOM | `createElement` + 逐节点 `appendChild` | 分片 `removeChild` |
| DocumentFragment | 全部节点挂到 Fragment，最后一次 append（仅一次回流） | `replaceChildren()` 一次摘除 |
| innerHTML | HTML 字符串在 Web Worker 中构建，主线程一次赋值 | `innerHTML = ''` |
| 模板克隆 | `<template>` 克隆 + 节点池复用，分片 Fragment 挂载 | 分片删除并回收进节点池（上限 2 万） |

## 运行

需要通过 HTTP 访问（ES Module 与 Worker 的限制）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

推荐使用 Chromium 系浏览器（`performance.memory` 与 `longtask` 仅在此类浏览器可用）。
如需更精确的堆内存数据，可带参数启动 Chrome：
`chrome --enable-precise-memory-info`

## 使用

1. 选择方案、节点数量（默认 100,000）、数据块大小、单帧预算、采样频率。
2. 点击「批量新增」/「批量删除」运行单个方案，或点击「对比全部方案」依次跑完四种方案并自动校验结果一致性。
3. 运行中可随时「中断」（AbortController）；「清空」分片清空舞台；「重置」清空舞台、统计、曲线与节点池。

## 关键约束的实现方式

- **不阻塞主线程**：所有批量操作按时间片执行（`requestIdleCallback`，降级 `setTimeout`），每片受单帧预算约束后让出主线程。
- **节点回收及时**：模板克隆方案删除时把节点重置后回收进对象池（上限 2 万，防止内存膨胀）；数据块消费完立即释放引用。
- **内存可控**：节点池有上限；数据由 Worker 分块按需生成；日志与曲线均用固定容量结构。
- **操作可中断**：`AbortController` + 每个时间片边界检查 `signal.aborted`。
- **渲染不阻塞**：舞台容器 `contain: content`，节点 `content-visibility: auto`，屏幕外节点跳过渲染；图表仅在数据变化时于 `requestAnimationFrame` 中重绘。
- **长时间运行不漂移**：曲线数据使用固定容量环形缓冲区（1200 样本），日志封顶 150 条，无随时间增长的数组或监听器。

## 可观测性

- 每方案统计：新增/删除耗时、堆内存变化（`performance.memory`）、长任务次数与总时长（`PerformanceObserver` longtask）。
- Canvas 实时曲线：每个时间片的耗时 + JS 堆内存采样（采样频率可调）。
- 结果校验：对比模式自动检查四种方案新增节点数一致且删除后归零。
