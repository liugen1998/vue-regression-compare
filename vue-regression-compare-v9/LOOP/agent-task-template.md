# Agent 任务模板

把用户需求拆成下面字段，有助于后续 Agent 快速接手。

```text
Task:
  一句话目标。

Scope:
  允许改的目录/文件。

Out of scope:
  明确不处理的内容。

Inputs:
  页面配置、URL、报告、日志或用户给定资料。

Expected output:
  代码、配置、文档、报告或运行中的服务。

Harness:
  H0/H1/H2/H3/H4，说明选择原因。

Acceptance:
  可观察的完成标准。

Risks:
  登录态、真实业务地址、浏览器环境、执行时间、敏感数据。
```

## 示例

```text
Task:
  修复报告列表中 coverage.json 链接不可打开的问题。

Scope:
  src/uiServer.ts
  src/ui/index.html

Out of scope:
  不改报告生成逻辑。

Expected output:
  Web UI 报告 tab 能打开 coverage.json。

Harness:
  H3 UI，因为涉及 UI 与 API。

Acceptance:
  启动 UI，/api/health 正常，报告列表显示 coverage 链接。
```
