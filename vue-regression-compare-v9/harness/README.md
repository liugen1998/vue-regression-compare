# Harness 工程说明

Harness 用来定义“怎么证明这次开发是可信的”。后续 Agent 做功能、修复、配置或 UI 变更时，应先选择验证级别，再执行对应命令。

## 验证级别

| 级别 | 适用场景 | 必跑项 |
| --- | --- | --- |
| H0 Docs | 只改文档、模板、说明 | 检查链接、路径、命令是否存在 |
| H1 Static | 类型、工具函数、纯逻辑变更 | `corepack pnpm run typecheck` |
| H2 Config | 页面配置、策略、导入、校验逻辑变更 | H1 + `corepack pnpm run validate-config` |
| H3 UI | Web UI、API、任务日志、报告列表变更 | H2 + 启动 UI + `/api/health` + 关键页面手动/浏览器检查 |
| H4 Real Compare | Playwright 执行链、截图、交互、性能、报告生成变更 | H3 + 至少一个真实或可访问测试页面的 compare/check-selectors |

如果环境缺少真实业务地址、登录态或浏览器路径，不能硬跑 H4。此时记录阻塞原因，并尽量完成 H3。

## 基础命令

在工程根目录 `vue-regression-compare-v9/` 执行：

```powershell
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run validate-config
corepack pnpm run ui
```

UI 健康检查：

```powershell
Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3666/api/health"
```

样例配置校验：

```powershell
corepack pnpm run validate-config -- --page sample-page
```

选择器检查：

```powershell
corepack pnpm run check-selectors -- --page sample-page --headed
```

标准对比：

```powershell
corepack pnpm run compare -- --page sample-page --mode standard --headed --concurrency 1 --runs 1
```

性能更严谨的对比：

```powershell
corepack pnpm run compare -- --page sample-page --mode standard --headed --concurrency 1 --runs 3
```

## 输入与输出

主要输入：

- `workspace/pages/*.yaml`：页面验收配置。
- `workspace/auth/storageState.json`：登录态文件。不要提交真实登录态。
- `.env`：可包含 `CHROMIUM_EXECUTABLE_PATH`。

主要输出：

- `reports/<stamp>/report.html`
- `reports/<stamp>/report.xlsx`
- `reports/<stamp>/result.json`
- `reports/<stamp>/coverage.json`
- `reports/<stamp>/plan-preview.json`

报告产物默认视为运行输出，不要为了文档或小修复改动报告目录。

## Agent 验证记录格式

最终回复或 LOOP 交接中记录：

```text
Harness level: H2 Config
Commands:
- corepack pnpm run typecheck
- corepack pnpm run validate-config
Result:
- passed
Skipped:
- H4 Real Compare, because sample-page URLs are placeholders.
```
