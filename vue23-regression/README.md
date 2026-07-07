# vue23-regression（vmr）

Vue2 → Vue3 升级回归自动比对工具：对同一后端的两套前端页面，在相同筛选条件下自动比对**数字指标、下钻、弹窗、悬停**是否一致，并验证 **Vue3 性能不低于 Vue2**，输出自包含中文 HTML 报告、results.json 与 JUnit。

## 功能特性

四层比对：网络层（API 配对 diff）→ 数据层（指标归一化比对，千分位/单位/百分号自动等价）→ 视觉层（pixelmatch + 可选 Qwen2.5-VL 语义复核压误报）→ 交互层（下钻/弹窗/悬停逐步对齐回放）。两种运行模式：`replay`（录制 Vue2 API 后双端回放同一数据，**权威判定**）与 `live`(双端同刻请求，检测到源数据漂移自动降级为黄色 data-drift）。五种筛选组合策略（default/single/pairwise/full/sample）+ 约束 + 可复现 seed + dry-run 预估。性能采用 ABAB 交替采样取中位数，双条件判退化（倍率 >1.10 且差值 >100ms，可配）。红色缺陷自动二次确认复跑防抖动；支持断点续跑、页面级并行。报告零外链、截图 base64 内嵌，可直接归档转发。

## 环境要求

Node.js ≥ 20。浏览器三选一（按优先级自动探测）：

1. `VMR_EXECUTABLE_PATH=/path/to/chrome`——指向机器上已有的 Chrome/Chromium；
2. `@sparticuz/chromium`——Chromium 二进制内嵌在 npm 包里（本仓库已带此依赖，**只要能访问 npm 私服/镜像即可，无需访问 Playwright CDN**，适合内网）；
3. `npx playwright install chromium`——官方渠道（需要外网）。

## 安装

```bash
npm install        # 或指向内网 npm 镜像
npm run build      # 编译到 dist/，CLI 入口 dist/cli.js（bin 名：vmr）
```

以下命令中 `vmr` 等价于 `node dist/cli.js`。

## 60 秒演示（自带 fixtures 模拟站）

仓库内置一个 Vue2/Vue3 双版本模拟站，Vue3 侧**故意注入 6 处差异**（清单见 `fixtures/EXPECTED.md`）：

```bash
npm run fixtures &                                    # 启动模拟站 :4173
node dist/cli.js -c config/fixtures.yaml estimate     # 各策略用例数预估
node dist/cli.js -c config/fixtures.yaml run --mode replay --perf --auto-record
```

期望结果：恰好检出 5 条红色缺陷（orders 少 1、下钻 ×1.01、弹窗文案、悬停第 3 点、readyTime 退化）+ 1 条黄色视觉待复核；千分位差异被归一化通过；退出码 1；报告在 `runs/<runId>/report.html`。再试 `VMR_FIXTURE_VOLATILE=1 npm run fixtures` + `--mode live`，可看到数据漂移被归因为黄色而非误报缺陷。

## 接入真实项目

1. `cp config/pages.example.yaml config/pages.yaml`，填 `global.baseUrl.vue2/vue3`；
2. 登录态三选一：`auth.strategy: storage`（从本机浏览器导出 storageState 文件，`vmr login --strategy storage` 会打印导出步骤）/ `scripted`（配置登录页选择器 + 环境变量 `VMR_USER/VMR_PASS` 后执行 `vmr login`）/ `none`；
3. 从 1 个页面开始配置：`path`、`readyWhen`（就绪选择器 + 关键接口）、`apiCapture`（要捕获的接口 glob）、`filters`、`metrics`、`interactions`（模板与逐字段注释见 pages.example.yaml）；
4. `vmr estimate` 预估规模 → `vmr record`（默认组合）→ `vmr run --mode replay --perf`；
5. 逐页扩展到全部 20 个页面；组合验证用 `--combo pairwise` 或 `full`。

## CLI 速查

| 命令 | 说明 | 常用参数 |
|---|---|---|
| `vmr estimate` | 各策略用例数 dry-run | `--max-cases --seed` |
| `vmr record` | 录制 Vue2 侧 API（replay 前置） | `--combo --pages --seed` |
| `vmr run` | 执行双端比对 | `--mode replay\|live` `--combo` `--pages` `--perf` `--perf-only` `--workers` `--resume <runId>` `--auto-record` `--no-confirm` `--junit` `--max-cases --seed` |
| `vmr report <runId>` | 由 results.json 重新出报告 | |
| `vmr login` | 获取登录态 | `--strategy scripted\|storage` |

全局：`-c/--config` 指定配置（默认 `config/pages.yaml`）。日志级别：`VMR_LOG=debug|info|warn`。

## 模式怎么选

日常回归与 CI 用 **replay**：数据完全冻结，任何数值差都是前端问题，性能也在固定延迟回放下测，最稳。**live** 用于快速体检或无法录制的场景：同一时刻双端请求，若响应本身有差（实时数据），相关数值差异自动记 `data-drift`（黄色、不计缺陷）并提示改用 replay 权威复核。

## 报告解读

用例状态：绿=通过、黄=告警（可带病发布但需人工看一眼）、红=缺陷（阻塞）、灰=工具错误（脚本/环境问题，不代表页面有差异）。发现分类：`render-bug`（数据同渲染不同）、`interaction-fail`（交互行为不一致）、`perf-regression`（性能退化）为红；`visual-minor`（VL 判语义等价的像素微差）、`visual-pending`（VL 未启用待人工）、`data-drift`、`flaky`（二次确认不一致）为黄；`tool-error` 为灰。退出码：0 通过（可含黄）/ 1 有红色缺陷 / 2 工具或环境错误。`已二次确认` 徽章表示红色结论复跑重现。

## 启用 Qwen2.5-VL（可选，压视觉误报 + 兜底读数）

```bash
export VL_BASE_URL=http://<内网VL网关>/v1   # OpenAI 兼容
export VL_API_KEY=xxx
export VL_MODEL=qwen2.5-vl-72b-instruct
```

未设置时工具完全可用，超阈值像素差异统一记 `visual-pending` 由人工复核；设置后仅对差异聚集区裁剪送审（每处最多 4 区，可配），VL 判"语义等价"则降为 `visual-minor`。`vl-read` 型指标（图表读数兜底）需要 VL 才能使用。

## 目录结构

```
config/           pages.example.yaml（模板）、fixtures.yaml（演示）
src/              TypeScript 源码（core 四层引擎 / report / cli）
fixtures/         双版本模拟站 + EXPECTED.md 金标准
recordings/       vmr record 产物（按 页面/组合 存放）
runs/<runId>/     report.html、results.json、junit.xml、state.json、cases/、logs/
```

## 常见问题

`ready-timeout`：确认 `readyWhen.selector` 在目标页存在、`apiCapture` 覆盖了页面真实接口路径（水位计数依赖捕获）。`echarts-locate`：目标站未暴露 `window.echarts` 时给 `echartsClick` 补 `relX/relY` 相对坐标兜底（0~1）。`no-recording`：先 `vmr record`，或加 `--auto-record`。组合爆炸：先 `estimate`，用 `pairwise` 或 `sample --max-cases N`。登录态过期：重新 `vmr login` 或重导 storageState。目标站 CSP 严格时若注入脚本被拦，就绪协议会退化为超时——请先在 1 个页面上验证再铺开。

## 已知限制（v0.1）

下钻仅支持**同页签**跳转（`target=_blank` 新开 tab 暂不支持，可先在测试环境去掉 target 或提需求扩展）；live 模式漂移归因为**用例级**粒度（检测到任一接口漂移即降级该用例全部数值差异，宁可漏报不误报）；`vmr login --strategy scripted` 未在 fixtures 上演练（模拟站无登录），首次在真实登录页使用时请先单独验证；`cascader` 筛选走 custom 步骤实现。
