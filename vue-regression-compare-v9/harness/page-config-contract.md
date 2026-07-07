# 页面配置契约

本文件用于指导 Agent 生成或修改 `workspace/pages/*.yaml`。

## 必填字段

- `pageKey`：稳定 ID，只使用适合文件名的字符。
- `pageName`：业务可读名称。
- `vue2Url`：Vue2 页面地址。
- `vue3Url`：Vue3 页面地址。
- `testStrategy`：建议默认 `standard`。
- `waitForSelector`：页面稳定区域，默认 `body` 只适合简单页面。

## 推荐字段

- `storageState`：默认 `workspace/auth/storageState.json`。
- `waitForHiddenSelectors`：加载遮罩、骨架屏等隐藏后再采集。
- `waitForNetworkIdle`：网络稳定后采集。
- `waitAfterMs`：页面业务渲染额外等待时间。
- `timeoutMs`：页面打开或交互超时。

## 页面就绪 readiness

v9 默认启用更严格的页面稳定协议，避免页面仍处在 Loading、接口未完成、DOM 还在渲染时就开始比较。

```yaml
readiness:
  waitForRequestIdle: true          # 等 fetch/XHR pending 归零
  waitForDomStable: true            # 等 DOM mutation 静默
  stableQuietMs: 800                # 静默窗口
  waitForCommonLoading: true        # 自动识别常见 loading/spin/skeleton
  loadingSelectors:
    - ".el-loading-mask"
    - ".ant-spin-spinning"
  loadingText:
    - "加载中"
    - "正在加载"
  waitForCanvasStable: true         # 等 canvas/ECharts 连续稳定
  canvasSettleMs: 1200
  autoScrollBeforeScreenshot: true  # 截图前滚动预热懒加载
  disableAnimations: true           # 关闭动画/过渡/光标闪烁
```

- 长轮询或 SSE 页面如果一直有请求，可把 `readiness.waitForRequestIdle` 设为 `false`，但仍建议保留 `waitForDomStable` 和 Loading 检测。
- 业务 Loading 不在常见选择器内时，优先补 `readiness.loadingSelectors` 或 `waitForHiddenSelectors`。
- `waitForSelector: body` 只是兜底；正式页面应配置主容器、核心卡片或表格容器。

## 指标 metrics

指标用于回答“Vue3 是否展示了同样的业务结果”。

优先级：

1. 关键数字，如总数、金额、转化率。
2. 关键表格或列表。
3. 页面标题、状态标签、空态文案。

示例：

```yaml
metrics:
  - name: 客户数
    selector: "[data-testid='customer-count']"
    critical: true
  - name: 明细表格
    selector: "[data-testid='main-table']"
    type: table
    all: true
```

## 筛选器 filters

筛选器用于覆盖主要业务分支。

- 时间类优先使用 `previous-and-current`。
- 地区类优先使用 `region-representative`。
- 状态类可使用 `all`，但要注意组合爆炸。
- 每个筛选器应尽量配置 `submitSelector`。

## 页签 tabs

页签用于覆盖同一页面内的重要视图。

```yaml
tabs:
  strategy: all
  items:
    - name: 总览
      selector: "[data-testid='tab-overview']"
```

## 交互 interactions

交互用于覆盖钻取、弹窗、跳转、下载入口等。

```yaml
interactions:
  - name: 明细弹窗
    type: click
    selector: "[data-testid='detail-button']"
    waitForSelector: "[data-testid='detail-modal']"
    compareSelectors:
      - "[data-testid='detail-modal']"
    closeSelector: "[data-testid='modal-close']"
    screenshot: true
```

Agent 不应猜测复杂交互。无法稳定判断时，先记录为人工确认项或在最终回复中说明需要业务方补 selector。
