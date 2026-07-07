# LOOP 工程说明

LOOP 是后续 Agent 在本项目中工作的迭代闭环。这里的 LOOP 定义为：

- L：Load context，读取上下文。
- O：Observe system，观察现有系统行为。
- O：Operate changes，做小而明确的变更。
- P：Prove and pass off，验证并交接。

## 每轮工作流程

1. Load：读取外层 `AGENTS.md`、项目 `README.md`、相关 Harness 文件和直接相关源码。
2. Observe：确认当前问题、现有命令、端口、配置和运行状态。
3. Operate：按现有代码风格做最小可行变更。
4. Prove：选择 `harness/README.md` 中的验证级别并执行。
5. Pass off：用 `iteration-template.md` 记录结果、风险和下一步。

## 适用任务

- 新增页面配置导入能力。
- 修复对比、截图、报告、覆盖率、交互扫描问题。
- 改进 Web UI、任务日志、历史报告查看。
- 扩展策略预览、筛选器抽样、页签覆盖。
- 帮助其他 Agent 接手未完成工作。

## 不做的事

- 不在文档中保存密码、登录态、Cookie 或真实敏感 URL。
- 不为了跑通测试而删除用户已有配置。
- 不把 `reports/` 作为源码改动的一部分。
- 不把不稳定 class 或 DOM 位置当成长期选择器方案。
- 不在未说明风险的情况下扩大对比场景数量，导致执行时间失控。

## 交接位置

需要跨轮交接时，在最终回复中引用 `LOOP/iteration-template.md` 的结构。若需要落盘记录，可在 `LOOP/runs/` 下新建一份以日期命名的 Markdown 文件。

示例文件名：

```text
LOOP/runs/20260707-2030-fix-report-links.md
```

默认不创建 runs 记录，除非任务明确需要长期追踪。
