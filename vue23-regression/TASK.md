# TASK.md — Vue2/Vue3 升级回归比对工具 · 开发任务书

> 阅读对象：本仓库的 Claude Code 智能体。行为守则见 `CLAUDE.md`（冲突时以 CLAUDE.md 为准）。
> 配置文件的权威示例：`config/pages.example.yaml`（其结构即配置 schema 的事实标准，zod 校验须与之完全一致）。

---

## 1. 背景与目标

业务方将约 20 个数据看板类页面从 Vue2 迁移到 Vue3。两套页面**共用同一后端，数据实时变化**。图表以 **ECharts（Canvas 渲染）为主**。需要一个可反复执行的回归工具，回答两个问题：

1. **一致性**：在相同筛选条件下，Vue3 页面的数字指标、下钻、弹窗、悬停提示等是否与 Vue2 完全一致？
2. **性能**：Vue3 页面（加载与关键交互）是否不劣于 Vue2？

工具须支持"仅默认条件"与"筛选组合遍历"（策略由使用者选择），自动产出：差异报告、性能退化报告、三联截图（Vue2/Vue3/diff）、完整日志。

## 2. 核心设计决策（已拍板，不得更改）

**D1 · 双运行模式，应对实时数据**
- `replay`（默认，权威判定模式）：先 `record` 录制 Vue2 侧真实 API 响应，之后回放阶段对 **Vue2 与 Vue3 两端同时**做路由拦截，用同一份录制数据喂给双方。输入数据严格一致 ⇒ 任何渲染差异都是真实前端问题，数值断言用严格相等（归一化后）。
- `live`（冒烟/巡检模式）：双浏览器上下文**同刻并行**执行同一步骤序列（每步 Promise.all 对齐）。若两端对应 API 响应不一致，则将由此导致的数值差异自动归因为 `data-drift`（数据漂移，黄色告警，不判缺陷）；若两端 API 响应一致而渲染值不同，判 `render-bug`。
- 性能采样默认在 `replay` 模式下进行（消除后端波动，纯比前端），并将录制时记录的每接口耗时以固定值（取录制中位数）模拟回放延迟，保证两端网络条件完全一致。

**D2 · 四层比对**
① 网络层：捕获两端 API 请求/响应，归一化后结构化 diff；② 数据层：按配置提取页面数字指标，归一化后比对；③ 视觉层：遮罩动态区域 → pixelmatch 像素 diff → 超阈值区域交 Qwen2.5-VL 语义复核以压制误报；④ 交互层：回放下钻/弹窗/悬停等操作序列，对操作后的状态重复 ①~③。

**D3 · 组合策略由使用者选择**
`--combo default | single | pairwise | full | sample`，含约束规则与 `--dry-run` 用例数预估。

**D4 · ECharts 三级适配**
优先实例 API（getOption / convertToPixel / dispatchAction）→ 坐标扫描 + 原生鼠标事件 + tooltip DOM 抓取 → Qwen2.5-VL 视觉读数/定位兜底。

**D5 · 性能判定**
ABAB 交替采样（默认预热 1 次 + 有效 5 次），取中位数；判退化条件：`v3中位数 > v2中位数 × maxRatio` **且** `差值 > minAbsMs`（双条件同时满足才判退化，避免小基数误报）。指标逐项独立判定。

**D6 · 产物**
自包含中文 HTML 报告 + `results.json`（机器可读）+ 可选 JUnit XML + 三联截图 + 分级日志；CLI 退出码：`0` 全通过（可含黄色告警）/ `1` 存在缺陷或性能退化 / `2` 工具或环境错误。

**D7 · 失败分类体系（所有结论必须归类）**
`render-bug`（数据同而渲染不同）· `interaction-fail`（交互行为不一致：弹窗未出、下钻目标不同等）· `perf-regression` · `visual-minor`（像素有差但 VL 判语义等价，黄色）· `data-drift`（仅 live 模式，黄色）· `tool-error`（选择器失效、超时、VL 不可用等，计入工具问题不计缺陷）。

## 3. CLI 规格

命令名 `vmr`（package.json bin）。

| 命令 | 说明 |
|---|---|
| `vmr record [--pages a,b] [--combo …]` | 以 Vue2 侧为源录制 API 响应到 `recordings/<页面>/<用例签名>/` |
| `vmr run` | 执行比对。关键参数见下 |
| `vmr login` | 辅助获取登录态：`--strategy storage` 引导在有头环境导出 storageState；`--strategy scripted` 按配置账号密码脚本化登录并保存 `.auth/state.json` |
| `vmr estimate` | 等价于 `run --dry-run`：仅输出各页面用例数与预估耗时 |
| `vmr report <runId>` | 由 `runs/<runId>/results.json` 重新生成 HTML 报告 |

`vmr run` 参数：`--mode replay|live`(默认 replay，无录制时若加 `--auto-record` 则先自动录制) · `--combo default|single|pairwise|full|sample`(默认 default) · `--max-cases N`(sample 模式抽样上限，其他模式为安全熔断上限) · `--seed N` · `--pages id1,id2` · `--perf`(附带性能采样) · `--perf-only` · `--workers N`(页面级并行，默认 2) · `--resume <runId>`(断点续跑) · `--retry N`(默认 2) · `--headed`(调试) · `--junit` · `--dry-run`。

## 4. 配置规格

- 用户维护 `config/pages.yaml`；`config/pages.example.yaml` 为权威模板（随仓库提供，注释齐全），zod schema 必须与模板一一对应，校验失败时输出中文的字段级错误与修复建议。
- 三层结构：`global`（两端 baseUrl、auth、viewport/locale/timezone、等待与容差默认值、VL 配置、性能默认值）→ `pages[]`（路径映射、就绪条件、API 捕获与映射、遮罩、筛选、指标、交互、性能覆盖）→ 页面内各项可覆盖 global 默认。
- 所有选择器/URL 支持 Playwright 语法；API 匹配用 glob；`apiMap` 提供 Vue2→Vue3 接口路径正则映射（两端接口路径可能不同，配对与回放都要用它）。

## 5. 模块规格（按 CLAUDE.md 目录结构）

### 5.1 session — 双端会话
- 单浏览器进程，两个 `browserContext`（v2/v3），统一 viewport（默认 1600×900）、`deviceScaleFactor:1`、locale/timezone（默认 zh-CN / Asia/Shanghai，可配）、`reducedMotion:'reduce'`。
- 登录：`storage` 策略加载 `.auth/state.json` 并在启动时探测有效性（访问探针 URL，失效则中文提示重新 `vmr login`）；`scripted` 策略按配置步骤填账号密码（凭据取自环境变量）。两端各自独立的 auth 配置须支持（可能域名不同）。
- 环境冻结注入（`addInitScript`）：注入 CSS 关闭 animation/transition/caret；`freezeClock: true` 时用 Playwright clock API 固定时间（默认关闭，注明可能影响业务逻辑）；暴露 `window.__vmr_hook__` 供 ECharts 适配器探测。
- 就绪协议（全工具统一，禁止裸 sleep 为主策略）：**请求水位法**——动作前记录 in-flight 请求集合，动作后等待"新增请求全部完成 → 连续 `quietMs`(默认 800ms) 无新请求 → 连续两帧 rAF 无 DOM 变更（MutationObserver 计数）"，再叠加页面配置的 `readyWhen.selector / apiDone`。超时走失败分类 `tool-error`。
- 全页截图前执行自动滚动到底再回顶（触发懒加载），滚动行为两端一致。

### 5.2 net — 网络层与录制回放
- 用 `context.route('**/*')` + response 监听捕获匹配 `apiCapture` 的请求。请求签名 = method + 映射归一化后的 path + 排序后的 query + 归一化 body（剔除 `apiIgnoreFields` 指定的 JSONPath 字段，如 timestamp/traceId/sign）。
- 录制存储：`recordings/<pageId>/<comboHash>/<签名hash>.json`，含 status/headers 子集/body/耗时；同签名多次命中存序列，回放按序供给。
- 回放：两端 route 拦截，命中签名 → fulfill 录制体 + 固定延迟；未命中 → 按 `replayMissPolicy`（`passthrough-warn` 默认 / `abort-fail`）处理并记日志。静态资源（js/css/img）一律放行。
- diff：JSON 深度对比（数组默认按序，可配 `unorderedPaths`），输出路径级差异；分类为 请求缺失/多余/参数不一致/响应不一致。live 模式下响应不一致仅作 `data-drift` 依据，不直接判缺陷。

### 5.3 combos + filters — 组合引擎与筛选执行
- 筛选控件类型：`select / multiselect / daterange / radio / input / cascader / custom(steps)`。每个 filter 声明 `values`（显式枚举，元素含 label 与操作参数）或 `discover: true`（运行时展开下拉读取全部选项，仅 DOM 下拉可用，报告中标注"自动发现"）。`default` 指定默认值；`apply` 后须按就绪协议等待刷新完成；页面可配统一"查询按钮" `submitSelector`。
- 策略：`default` 仅默认组合；`single` 逐维遍历（其余取默认）；`pairwise` 自实现贪心两两覆盖（单测验证覆盖所有 pair）；`full` 笛卡尔积；`sample` 全组合固定 seed 均匀抽样至 `--max-cases`。
- `constraints`：支持 `exclude`（匹配即剔除）与 `when/then`（依赖联动）两种规则。
- dry-run 输出：每页面各策略用例数、总用例数、按历史或默认 40s/用例的预估时长。

### 5.4 extract — 指标提取与归一化
提取器类型：
- `dom-text`：selector（+可选 `all: true` 取列表）→ 文本；
- `echarts`：经 5.5 适配器取 `getOption()` 指定路径（如 `series[0].data`）；
- `tooltip-sweep`：经 5.5 悬停扫描聚合 tooltip 数值；
- `api-field`：从捕获响应按 JSONPath 取值（数据真值，用于 live 模式自洽校验：各端"渲染值 vs 本端 API 值"）；
- `vl-read`：截图指定区域交 VL 读数（最后手段，结果标注置信度）。
归一化流水线（可按指标配置）：去千分位与空白 → 单位剥离（元/万/%/次等，`万` 等倍率单位换算为数值）→ 百分号转小数或保留原语义（配置项）→ 占位符等价表（`-`,`--`,`—`,`暂无数据`,`null` 视为同一空值）→ 数值比较容差 `abs` / `relPct`（replay 模式默认 0，live 模式可放宽）。非数值文本走 trim + 空白折叠后全等比较。

### 5.5 echarts — 三级适配器
- L1 实例：页面世界内探测 `document.querySelectorAll('[_echarts_instance_]')`；若 `window.echarts` 存在用 `getInstanceByDom` 取实例 → `getOption()` 精确取数、`convertToPixel` 求数据点像素坐标、真实 `page.mouse` 移动/点击该坐标触发原生 hover/click（不用 dispatchAction 模拟点击，保证走业务事件绑定）。
- L2 坐标扫描：拿不到实例时，对 canvas 包围盒做横向 N 等分（默认 6 点，纵向取绘图区中部）`mouse.move` 悬停，抓取 tooltip DOM（默认匹配 ECharts tooltip 容器样式特征，可配 `tooltipSelector`）文本；点击类交互要求配置提供 `relX/relY`（0~1 相对坐标）。
- L3 VL 定位/读数：把图表截图 + 问题发给 Qwen2.5-VL，要求返回目标元素 bbox 像素坐标（用于点击）或读出的数值 JSON。仅在 L1/L2 均不可用或配置显式指定时启用，结果带 `confidence`。
- 悬停比对：两端在**相同策略与相同采样点**下取 tooltip，文本走 5.4 归一化后比对；同时保留 tooltip 截图供报告展示。

### 5.6 interact — 交互 DSL
步骤类型（数组顺序执行，两端各自执行同一序列；live 模式逐步 barrier 对齐）：
`click / fill / select / hover / echartsClick / echartsHoverSweep / waitReady / expectModal(selector) / closeModal / expectNav(urlPattern，含新标签页处理) / expectTooltip / goBack / screenshot(label) / compare(现场比对：metrics 子集 + visual + api)`。
- 下钻：`echartsClick`/`click` → `expectNav` 或 `expectModal` → `compare` → `goBack`/`closeModal`，须校验"两端到达的目标一致"（URL 归一化比对或弹窗标题比对），不一致即 `interaction-fail`。
- 弹窗：出现后对弹窗元素单独截图 + 弹窗内指标提取比对。
- 每个交互后恢复到交互前状态再执行下一个（回退失败则整页重载重做剩余交互，记 warn）。

### 5.7 visual — 视觉层
- 截图：整页 + 配置的关键区域元素截图；`masks` 选择器区域涂色遮罩（时间戳、版本号、头像等）。
- pixelmatch：两图先对齐到相同尺寸（右/下补白并在报告注明尺寸差），`threshold` 默认 0.1；`diffRatio ≤ passRatio(默认 0.2%)` 直接通过；超过则裁剪差异聚集区域（连通域包围盒，最多 4 块）送 VL 复核。
- VL 复核客户端：OpenAI 兼容 `/v1/chat/completions`，图片 base64；并发/超时/重试/降级按 CLAUDE.md 第 6 节。判定 `equivalent:true` → 记 `visual-minor`（黄色），`false` → `render-bug` 并附 VL 理由。
- 三联图产物：v2 / v3 / diff 高亮图，报告内支持滑块对比。

**内嵌 VL 提示词模板 A（视觉等价判定，实现为可维护的模板文件）：**
系统：『你是前端升级回归的视觉审查员。给你同一页面区域的两张截图（图1=Vue2 基准，图2=Vue3）及像素差异率。判断二者是否"语义等价"。应忽略：抗锯齿/亚像素/字体渲染微差、±2px 内的位移、不改变数据含义的图例顺序、滚动条样式。必须报告：任何数字/文本内容差异、元素缺失或多出、颜色映射含义改变、图形形状或数据点差异、布局明显错位。只输出 JSON：{"equivalent": true|false, "confidence": 0~1, "differences": [{"type":"text|number|element|color|layout|shape","desc":"中文描述","area":"大致位置"}], "readings": {"可选：读出的关键数字，键为语义名"}}。不要输出 JSON 以外的任何字符。』

**内嵌 VL 提示词模板 B（读数/定位）：**
『给你一张图表截图（宽W高H像素）和一个问题。若问数值：读出并按 {"values":[{"label":"...","value":...}],"confidence":0~1} 输出；若问位置：返回目标元素中心与包围盒 {"cx":..,"cy":..,"bbox":[x1,y1,x2,y2],"confidence":..}，坐标为该图绝对像素。只输出 JSON。』

### 5.8 perf — 性能
- 采集（`addInitScript` 预埋 PerformanceObserver）：FCP、LCP、DOMContentLoaded、load、LongTask 总时长；接口耗时来自 net 层；交互耗时 = 动作触发 → 就绪协议达成。
- 采样：每用例 v2/v3 交替（ABAB…），全新 context、禁缓存（或统一预热 1 次策略，二者取其一并全局一致），默认 warmup 1 + 有效 5；可配 CDP `Emulation.setCPUThrottlingRate`。
- 统计与判定按决策 D5；报告输出每指标 v2/v3 的 中位数/p75/全部样本，退化项红色标注并给出倍率。
- 性能采样默认仅在 `default` 组合上跑；`--perf` 与组合遍历同时开启时，性能只跑每页默认组合（避免时长爆炸），在报告中说明。

### 5.9 runner + report
- 用例 = 页面 × 组合 ×（页面级比对 + 各交互比对）。页面级并行 `--workers`，页内串行。失败重试：`tool-error` 类重试至 `--retry` 次；断言失败重试 1 次仅用于确认非抖动（两次一致才定论）。
- 断点续跑：`runs/<runId>/state.json` 记录每用例状态，`--resume` 跳过已完成。
- 每用例落盘：`runs/<runId>/<pageId>/<comboHash>/`（截图、diff 图、api-diff.json、metrics.json、log）。
- `results.json`：结构化全量结果（schema 写入 `src/report/schema.ts` 并导出 TS 类型）。
- HTML 报告（中文、自包含）：顶部总览（用例数/通过率/各分类计数/性能退化数/运行参数）→ 页面列表（状态色块）→ 用例详情（筛选组合、指标表逐行 diff 高亮、API 差异折叠 JSON、三联图滑块、交互时间线、VL 判定理由、日志链接）→ 性能对比表。黄色分类（visual-minor/data-drift）单独聚合区。
- 退出码按决策 D6；`--junit` 输出 `runs/<runId>/junit.xml`。

## 6. fixtures — 本地双版本模拟站（自测金标准）

`fixtures/` 内构建可 `npm run fixtures` 一键启动的本地站：
- 用 npm 下载 `vue@2.7`、`vue@3`、`echarts` 的 dist 文件落盘引用（不走 CDN），实现同一个"迷你销售看板"的 v2/v3 两版：含 3 个数字卡片、1 个 ECharts 柱状图（可点击下钻到详情页）、1 个折线图（悬停 tooltip）、1 个"明细"弹窗、2 个筛选（下拉 + 日期快捷段），共用同一 mock API server（Node http，支持 `?volatile=1` 开启数据随机抖动以自测 live 模式漂移归因）。
- **故意注入 6 个已知差异**（v3 侧）：① 某数字卡片千分位格式不同但数值相同（应判等价/通过）；② 某卡片真实数值不同（应判 render-bug）；③ 弹窗内一处文案不同（render-bug）；④ 下钻后目标页一处数值不同（render-bug）；⑤ 折线图第 3 点 tooltip 数值不同（render-bug）；⑥ v3 首屏人为延迟 300ms（perf-regression）。
- 差异清单写入 `fixtures/EXPECTED.md`。端到端验收标准：工具在 fixtures 上运行 `replay + full + --perf`，报告**恰好**检出 ②③④⑤⑥、将 ① 判为通过或 visual-minor，且无其他误报。

## 7. 分阶段开发计划（阶段闸门制）

每阶段固定动作：写 `docs/plan/phase-N.md`（≤30 行计划）→ 实现 → 单测/自测 → 输出验收清单打勾+证据 → git commit。

- **阶段 0 · 骨架**：仓库初始化、tsconfig/vitest、CLI 骨架、配置加载+zod 校验+中文错误、日志器、`pages.example.yaml` 落库。验收：`vmr estimate` 能读示例配置输出各策略用例数；配置错误示例给出字段级中文提示。
- **阶段 1 · fixtures + 会话**：按第 6 节建 fixtures（先不注入差异，仅 ①⑥ 延后到阶段 7 前注入齐）；session 模块 + 登录两策略 + 就绪协议 + 双端并排截图。验收：一条命令对 fixtures 双版本出双截图，日志展示就绪协议各阶段耗时。
- **阶段 2 · 网络层**：捕获/归一化/配对/diff + record/replay。验收：fixtures 上 record 后 replay 命中率 100%（日志证明零 passthrough），`volatile=1` 时 live 双开能标出 data-drift。
- **阶段 3 · 组合与筛选**：5 策略 + constraints + discover + dry-run；筛选执行器在 fixtures 两个筛选上跑通。验收：pairwise 单测证明全 pair 覆盖；`--combo full` 在 fixtures 上逐组合执行且每次刷新等待正确。
- **阶段 4 · 指标提取**：五种提取器（vl-read 可留接口打桩至阶段 6 接通）+ 归一化流水线 + 比对与容差。验收：fixtures 差异 ① 判通过、② 判 render-bug 的单测与实跑证据。
- **阶段 5 · ECharts 与交互 DSL**：三级适配器（L3 打桩）+ 全部步骤类型 + 下钻/弹窗/悬停闭环。验收：fixtures 上下钻、弹窗、tooltip 扫描双端跑通并产出比对结果；L1 与 L2 路径均被 fixtures 覆盖（一图暴露 window.echarts，一图不暴露）。
- **阶段 6 · 视觉层 + VL 客户端**：遮罩/pixelmatch/差异区裁剪/VL 复核与降级/模板 A、B 落地（fixtures 自测时若无真实 VL 端点，用本地 stub server 返回可配 JSON，stub 明确标注）。验收：像素差超阈用例走完"裁剪→VL→分类"链路；VL 不可用时降级不阻塞。
- **阶段 7 · 性能**：注入 fixtures 差异⑥；采集/ABAB/统计/判定。验收：fixtures 上稳定检出 ⑥（连续 3 轮运行结论一致），无 ⑥ 的对照版不误报。
- **阶段 8 · runner + 报告**：编排、重试、断点续跑、失败分类、results.json、HTML 报告、junit、退出码。验收：故意 kill 进程后 `--resume` 从断点续跑；报告零外链（grep 证明无 http 外链）；退出码符合 D6。
- **阶段 9 · 端到端与交付**：注齐 6 个差异跑金标准验收（第 6 节）；写 README（安装/首次配置/常用命令/报告解读）、SETUP.md（用户须填清单）、故障排查文档（选择器失效、登录过期、VL 超时、录制未命中等的现象与处置）。验收：金标准全过；新人视角按 README 可完成一次 fixtures 全流程。

## 8. 已知坑位清单（实现时主动规避）

canvas 与 `deviceScaleFactor` 不一致导致像素对比失真（统一为 1）；ECharts 动画未结束就截图（就绪协议后再加图表静默判定：连续两次 canvas toDataURL 一致，或实例侧 animation=false）；懒加载区域截图为空（自动滚动预热）；tooltip 跟随鼠标残留（比对后 mouse.move 到空白区）；下钻开新标签页（监听 context 'page' 事件）；登录态中途过期（探针检测 + 明确中文报错）；长跑内存（每 N 用例重建 context）；两端接口路径不同（一律经 apiMap 归一）；抽样与 pairwise 的可复现性（seed 落盘到 results.json）。

## 9. 完成定义（DoD）

阶段 0–9 全部验收通过；`npx tsc --noEmit` 零错误；vitest 全绿；fixtures 金标准验收报告存档于 `runs/`；QUESTIONS.md 与 SETUP.md 完整；README 使真实用户可在内网完成：填写 pages.yaml → `vmr login` → `vmr record` → `vmr run --perf` → 阅读报告。
