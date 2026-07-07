# Vue Regression Compare v9

用于核对两个独立 URL 的 Vue2 / Vue3 页面升级后一致性。v9 聚焦结果完整性、性能稳定性、交互匹配准确性、覆盖率落地和 Web UI 验证闭环。

## v9 关键修复

1. **指标丢失修复**：截图异常不会吞掉指标结果。`attachMetricEvidence` 仅把截图降级为“无截图”，指标行仍写入 `result.json`、HTML 和 Excel。
2. **性能多次采样**：新增 `--runs N`。当 `N > 1` 时，同一场景执行 N 次，性能项取 Vue2/Vue3 中位数，避免单次网络波动误报。
3. **交互文本空格归一化**：自动交互匹配默认去除半角/全角空格，避免“查 询”与“查询”被误判。
4. **覆盖率报告落地**：CLI 输出提示 `coverage.json`；HTML/Excel 均包含覆盖情况。
5. **Web UI 增强**：UI 支持查看历史报告、按当前策略重跑、记录人工确认项。

## 安装

```bash
npm install
```

如 Playwright 浏览器版本不匹配，可在 UI 中检测并保存 Edge / Chrome 路径，或手动设置：

```bash
set CHROMIUM_EXECUTABLE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

## Web UI

```bash
npm run ui
```

打开：

```text
http://localhost:3666
```

UI 支持：

- 三列页面清单导入：`页面 | VUE2链接 | VUE3链接`
- 页面配置查看/编辑
- 策略预览
- 启动配置校验、选择器检查、页面对比
- 历史报告查看
- 按当前页面和策略重跑
- 人工确认项登记

## 命令行

单页标准模式：

```bash
npm run compare -- --page sample-page --mode standard --headed --concurrency 1
```

性能严谨模式，执行 3 次取中位数：

```bash
npm run compare -- --page sample-page --mode standard --headed --concurrency 1 --runs 3
```

批量导入三列表：

```bash
npm run import-pages -- --file pages.md --strategy standard
```

配置校验：

```bash
npm run validate-config -- --page sample-page
```

## 报告产物

每次执行生成：

```text
reports/YYYYMMDD_HHMMSS/
├── report.html
├── report.xlsx
├── result.json
├── coverage.json
└── plan-preview.json
```

Excel 包含：

- 明细
- 覆盖情况
- 策略预览
- 总览

## 性能判定

以 Vue2 耗时为基线：

- Vue3 <= Vue2：通过，显示“提升 xx%”或“持平 0.00%”
- Vue3 > Vue2：性能下降，显示“下降 xx%”

`--runs N` 会分别计算 Vue2/Vue3 的耗时中位数后再判定。

## 交互匹配策略

默认保守模式，只做确定性匹配：

- data-testid / data-test / data-cy
- aria-label
- title
- href
- 表单 label / placeholder / name
- 两端唯一文本，且默认去掉全半角空格后匹配

不靠 class、DOM 位置、相似文本或图标位置猜测。

## 已知边界

- 真正的下钻、弹窗、tooltip 深度验证仍建议显式配置 `interactions`。
- 自动交互扫描只负责确定性入口存在性和状态一致性。
- 指标完整性优先于截图证据，截图失败不会影响指标行输出。
