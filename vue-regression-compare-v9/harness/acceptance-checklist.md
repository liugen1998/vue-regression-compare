# Harness 验收清单

后续 Agent 可按任务类型勾选。不是所有任务都需要完整执行，但跳过项需要说明原因。

## 通用

- [ ] 已阅读外层 `AGENTS.md` 和本 Harness 说明。
- [ ] 已确认变更范围，不改无关文件。
- [ ] 未写入密码、Cookie、真实登录态或敏感业务数据。
- [ ] 未把 `reports/`、`workspace/auth/`、日志文件作为功能代码提交。
- [ ] 已说明使用的 Harness 级别。

## TypeScript 与逻辑

- [ ] `corepack pnpm run typecheck` 通过。
- [ ] 复用了现有模块和类型，避免重复解析 YAML、Excel 或 Playwright 数据。
- [ ] 错误信息能帮助用户定位配置、浏览器或页面问题。
- [ ] 异步任务失败时会写入 job log 或 CLI 输出。

## 页面配置

- [ ] `pageKey` 稳定且可作为文件名。
- [ ] `vue2Url`、`vue3Url` 是合法 HTTP/HTTPS URL。
- [ ] `waitForSelector` 使用稳定可见区域。
- [ ] 指标、筛选器、页签、交互使用稳定选择器。
- [ ] 新增配置通过 `validate-config`。

## Web UI/API

- [ ] UI 启动后 `/api/health` 返回 `{ "ok": true }`。
- [ ] 页面列表、策略预览、任务日志、报告列表至少检查一项核心路径。
- [ ] 前端提示不会阻断主要流程。
- [ ] API 返回结构与前端读取字段一致。

## Playwright 执行链

- [ ] 本地可检测到 Chromium/Chrome/Edge 路径，或已记录缺失原因。
- [ ] 需要登录态的场景不会要求 Agent 暴露密码。
- [ ] `--headed` 用于调试，稳定后可无头运行。
- [ ] 对比失败能产出可定位的 `result.json` 或日志。

## 报告

- [ ] HTML、Excel、JSON、coverage、plan-preview 产物语义一致。
- [ ] 失败截图缺失时，不应吞掉指标结果。
- [ ] 覆盖率缺口能被报告或日志看到。
