# Vue3 升级页面对比工具 Agent 指南

本目录用于维护 `vue-regression-compare-v9`，这是一个用于 Vue2/Vue3 页面升级验收的回归对比工具。后续 Agent 进入本目录时，先读本文件，再按任务类型读取 `harness/` 或 `LOOP/` 下的配套文件。

## 工程边界

- 核心工程：`vue-regression-compare-v9/`
- Harness 配套：`vue-regression-compare-v9/harness/`
- LOOP 配套：`vue-regression-compare-v9/LOOP/`
- 业务配置：`vue-regression-compare-v9/workspace/pages/`
- 登录态：`vue-regression-compare-v9/workspace/auth/`
- 报告产物：`vue-regression-compare-v9/reports/`

不要把真实账号、密码、Cookie、storageState、内部业务 URL 或报告里的敏感截图写入文档、提交记录或最终回复。

## 首读顺序

1. `AGENTS.md`
2. `vue-regression-compare-v9/README.md`
3. `vue-regression-compare-v9/harness/README.md`
4. `vue-regression-compare-v9/LOOP/README.md`
5. 与当前任务直接相关的源码或配置文件

## 常用命令

在 `vue-regression-compare-v9/` 目录下执行：

```powershell
corepack pnpm install
corepack pnpm run ui
corepack pnpm run typecheck
corepack pnpm run validate-config
corepack pnpm run validate-config -- --page sample-page
corepack pnpm run check-selectors -- --page sample-page --headed
corepack pnpm run compare -- --page sample-page --mode standard --headed --concurrency 1 --runs 1
```

Web UI 默认地址：

```text
http://localhost:3666
```

健康检查：

```powershell
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3666/api/health"
```

## 开发原则

- 优先保持现有 Node/TypeScript 结构，不引入新框架。
- 配置解析、YAML、Excel、Playwright 相关逻辑优先复用现有模块。
- 页面配置优先使用稳定选择器：`data-testid`、`data-test`、`data-cy`、`aria-label`、`title`、`name`、`placeholder`。
- 不依赖 class、DOM 位置、视觉顺序或图标坐标来判断业务一致性，除非任务明确要求并写明风险。
- 修改 UI 时同时检查 API 返回和页面显示，避免只让前端看起来可用。
- 修改执行链路时至少跑 `typecheck`，并按 `harness/README.md` 选择合适验证级别。
- 文档或模板变更不需要跑完整对比，但要检查路径、命令和术语是否仍准确。

## Agent 完成标准

每次任务结束前，Agent 应在最终回复中说明：

- 改了哪些文件。
- 选择了哪个 Harness 验证级别。
- 实际运行了哪些命令。
- 未运行的验证项及原因。
- 后续 Agent 需要知道的风险或交接点。

如果任务涉及持续迭代、跨轮协作或需要后续 Agent 接手，请使用 `vue-regression-compare-v9/LOOP/iteration-template.md` 记录交接信息。
