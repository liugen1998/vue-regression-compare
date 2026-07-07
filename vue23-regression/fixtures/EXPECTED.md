# fixtures 已知注入差异清单（工具验收金标准）

在 `config/fixtures.yaml` 上执行 `vmr record` + `vmr run --mode replay --perf --auto-record` 后，报告应**恰好**给出以下结论，且无其他红色误报：

| # | 注入位置（v3 侧） | 期望分类 |
|---|---|---|
| ① | 成交额 KPI 去掉千分位（1,234,567 → 1234567，数值相同） | 指标比对**通过**（stripComma 归一化）；整页像素差异记 visual-minor / visual-pending（黄） |
| ② | 订单数 KPI 渲染值少 1 | render-bug（metric 层，orders） |
| ③ | 弹窗文案「明细合计」→「合计明细」 | render-bug（metric 层，modal-total，交互 detail-modal 现场） |
| ④ | 下钻明细页合计 ×1.01 | render-bug（metric 层，detail-total，交互 drill-region 现场） |
| ⑤ | 折线图第 3 个数据点 tooltip 值 +5 | render-bug（interaction 层，hover-trend，命中含第 3 点的采样点） |
| ⑥ | 首屏 setTimeout 300ms 后才加载数据 | perf-regression（readyTime 等指标，中位数 ×>1.10 且 >100ms） |

附加验证点：
- Vue2 侧走 ECharts L1（实例 convertToPixel 定位点击），Vue3 侧因 `window.echarts` 被置空走 L2 相对坐标兜底——日志中可见两条不同路径。
- 服务端响应含 `traceId` / `timestamp` 随机字段，`apiIgnoreFields` 归一化后网络层比对不应误报。
- `.stamp` 渲染时间戳被截图遮罩，不产生视觉误报。
- `VMR_FIXTURE_VOLATILE=1 node fixtures/server.mjs` 后以 `--mode live` 运行，gmv 差异应被归因为 data-drift（黄色）而非 render-bug。
