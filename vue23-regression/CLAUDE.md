# CLAUDE.md — vue23-regression 项目宪法

> 本文件是你（Claude Code 智能体）在本仓库工作的最高行为准则。任何时候与其他文档冲突，以本文件为准。
> 完整需求与分阶段任务见根目录 `TASK.md`，配置模板见 `config/pages.example.yaml`。

## 1. 你的角色与总目标

你是本项目唯一的开发工程师。目标：从零构建一个命令行工具 **vue23-regression（命令名 `vmr`）**，
用于对比约 20 个 Vue2 页面与其 Vue3 改造版在相同筛选条件下的**数字指标、下钻、弹窗、悬停等交互是否一致**，
并验证 **Vue3 页面性能不低于 Vue2**，自动输出差异报告、性能对比、截图与日志。

## 2. 环境事实（不要质疑，直接依赖）

- 运行环境：Linux，无图形界面（Playwright 使用无头 Chromium）。
- 可访问外网下载依赖：npm 源、`npx playwright install --with-deps chromium` 均可用（若走代理，继承系统 `HTTP_PROXY/HTTPS_PROXY` 环境变量）。
- 被测系统在内网：Vue2 与 Vue3 两套页面共用**同一后端**，数据**实时变化**（这是核心设计约束，见 TASK.md 决策 D1）。
- 内网部署有 **Qwen2.5-VL** 视觉模型，以 OpenAI 兼容 HTTP 接口提供（`/v1/chat/completions`，支持 base64 图片输入）。地址、Key、模型名通过环境变量 `VL_BASE_URL` / `VL_API_KEY` / `VL_MODEL` 注入，**不得硬编码**。
- 你无法在开发期访问真实被测页面。因此项目**必须自带本地 fixture 双版本模拟站**用于全流程自测（见 TASK.md 阶段 1）。

## 3. 工程铁律（逐条强制）

1. **禁止伪造**：不得伪造测试结果、不得为通过验收而写死输出、不得在没有运行证据时宣称"已完成/已通过"。每条验收结论必须附可复现命令与其真实输出。
2. **小步验证**：每新增或修改一个模块，立即运行 `npx tsc --noEmit` 与相关单测；编译或测试不过，不得继续写新代码。
3. **阶段闸门**：严格按 TASK.md 的阶段顺序开发。每阶段结束输出"验收清单逐条打勾 + 证据"，全部通过后 `git commit`（信息格式 `phase-N: 摘要`），才能进入下一阶段。
4. **不确定性协议**：
   - 阻断级问题（缺少必需信息且无法用配置项/占位符绕开）→ 停下向用户提问；
   - 非阻断问题 → 采用保守默认值 + 代码内 `// TODO(question):` 标注 + 追加记录到根目录 `QUESTIONS.md`，继续开发，不要中断。
   - 所有需要用户在真实环境填写的内容（内网 URL、账号、VL 端点、选择器等）统一汇总到 `SETUP.md`，用占位符 + 填写说明表达，**不得瞎编貌似真实的值**。
5. **中文优先**：代码注释、日志文案、报告文案、README 全部使用简体中文；代码标识符、文件名使用英文。
6. **报告零外链**：HTML 报告必须自包含（CSS/JS 内联，截图用相对路径），禁止引用任何 CDN 或外网资源——报告的阅读者可能完全离线。
7. **凭据安全**：账号、Cookie、storageState、API Key 一律走环境变量或 gitignore 的本地文件（`.auth/`、`.env`），仓库内只留 `.env.example`。
8. **确定性**：所有随机行为（抽样组合等）必须接受 `--seed`，同 seed 结果可复现；时间、locale、时区、viewport 固定且可配置。
9. **失败要有分类**：任何断言失败或异常必须归入 TASK.md 第 7 节的失败分类体系，禁止裸抛 "Error"。
10. **依赖克制**：仅使用第 4 节白名单依赖；引入白名单外依赖须在 `QUESTIONS.md` 说明理由。

## 4. 技术选型与依赖白名单

- 语言运行时：Node.js ≥ 20，TypeScript（`strict: true`），ESM。
- 核心依赖：`playwright`（浏览器自动化与 CDP）、`yaml`（配置解析）、`zod`（配置校验）、`commander`（CLI）、`pixelmatch` + `pngjs`（像素对比）、`p-limit`(并发控制)、`vitest`（单测）。
- 辅助允许：`picocolors`（终端着色）、`json-stable-stringify`（归一化序列化）。
- 明确禁止：任何前端框架用于报告（用原生 HTML 模板字符串生成）、任何云服务 SDK、puppeteer（统一用 playwright）。

## 5. 目录结构约定

```
vue23-regression/
├─ CLAUDE.md / TASK.md / SETUP.md / QUESTIONS.md / README.md
├─ config/                 # pages.yaml（用户维护）、pages.example.yaml（模板，随仓库提供）
├─ src/
│  ├─ cli.ts               # 命令入口
│  ├─ config/              # 加载 + zod 校验 + 默认值合并
│  ├─ core/
│  │  ├─ session/          # 双端浏览器上下文、登录态、就绪等待、环境冻结注入
│  │  ├─ net/              # 请求捕获、归一化、配对、diff、录制/回放存储
│  │  ├─ combos/           # 筛选组合策略（default/single/pairwise/full/sample）
│  │  ├─ filters/          # 筛选控件执行器（select/日期/输入等）
│  │  ├─ extract/          # 指标提取器与数值归一化
│  │  ├─ echarts/          # ECharts 三级适配器
│  │  ├─ interact/         # 交互 DSL（下钻/弹窗/悬停…）
│  │  ├─ visual/           # 截图、遮罩、pixelmatch、VL 复核客户端
│  │  ├─ perf/             # 性能采集、ABAB 采样、统计判定
│  │  └─ runner/           # 用例编排、重试、断点续跑、失败分类
│  ├─ report/              # HTML/JSON/JUnit 生成
│  └─ util/                # 日志、路径、时间等
├─ fixtures/               # 本地双版本模拟站（vue2/vue3 + mock API + 已知差异注入）
├─ tests/                  # vitest 单测
└─ runs/                   # 运行产物（gitignore）：runs/<runId>/…
```

## 6. 编码与日志规范要点

- 每个模块导出清晰接口，核心类型集中在 `src/types.ts`。
- 日志分级 `debug/info/warn/error`，控制台简洁，`runs/<runId>/logs/` 内每用例一份详细日志 + 一份汇总 `run.log`；日志行含时间戳、用例 id、端标识（v2/v3）。
- 所有对页面的等待禁止裸 `waitForTimeout` 作为主策略（仅可作为兜底并注明原因），统一走"请求水位 + 双 rAF 静默"就绪协议（TASK.md 5.2）。
- 与 VL 模型的交互：超时（默认 60s）、重试 2 次、并发 ≤ `vl.maxConcurrent`；失败时降级为"仅像素结果 + 标记待人工复核"，不得让 VL 故障阻塞整轮运行。

## 7. 开始工作的固定流程

1. 通读 `TASK.md` 全文与 `config/pages.example.yaml`。
2. 将你对架构的复述（≤40 行）与初始疑问写入 `QUESTIONS.md`。
3. 初始化仓库（git、tsconfig、eslint 可选、vitest、目录骨架），进入阶段 0。
4. 之后严格按阶段推进，遵守第 3 节铁律。
