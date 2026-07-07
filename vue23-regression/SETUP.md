# SETUP —— 使用方必填清单

按顺序勾完即可开跑。除第 1、2 项外都在 `config/pages.yaml` 中填写（模板：`config/pages.example.yaml`，含逐字段注释）。

## 1. 运行环境
- [ ] Node ≥ 20，`npm install && npm run build` 成功
- [ ] 浏览器可用（三选一）：`VMR_EXECUTABLE_PATH` 指向已有 Chrome / 依赖内置 @sparticuz/chromium（默认）/ `npx playwright install chromium`
- [ ] （可选）VL：`VL_BASE_URL`、`VL_API_KEY`、`VL_MODEL`

## 2. 登录态（global.auth）
- [ ] 策略选定：`storage`（推荐，导出 storageState 文件放到 `.auth/`）/ `scripted`（填登录页选择器 + 设 `VMR_USER`/`VMR_PASS`）/ `none`
- [ ] 双端各自的 storageState 路径已填（同一账号体系可指向同一文件）

## 3. 全局（global）
- [ ] `baseUrl.vue2` / `baseUrl.vue3`
- [ ] 视口分辨率（默认 1600×900，建议与业务方常用一致）
- [ ] 容差：数值绝对/相对容差（默认 0/0）、像素阈值（默认差异率 0.2% 放行）
- [ ] 性能阈值：`maxRatio`(默认 1.10)、`minAbsMs`(默认 100)、采样数

## 4. 每个页面（pages[]，共约 20 份）
- [ ] `id`/`name`、双端 `path`
- [ ] `readyWhen`：首屏关键元素选择器 + 必达接口 glob 列表
- [ ] `apiCapture`：本页所有业务接口的 glob（决定录制/回放/水位/比对范围）
- [ ] `apiMap`：双端接口路径不一致时的映射规则（正则 from→to）
- [ ] `apiIgnoreFields`：traceId/timestamp/耗时等注定不同的字段（JSONPath，如 `$..traceId`）
- [ ] `unorderedPaths`：顺序不保证的数组路径
- [ ] `masks`：截图需遮罩的选择器（时间戳、头像、跑马灯…）
- [ ] `filters`：每个筛选的 key/type/selector/default/values（或 `discover: true` 自动发现）；组件库自定义下拉用 `custom` 步骤
- [ ] `constraints`：非法组合排除（exclude / when-then）
- [ ] `metrics`：要比对的数字指标（dom-text/echarts/api-field/tooltip-sweep/vl-read + normalize + 容差）
- [ ] `interactions`：下钻/弹窗/悬停的步骤脚本 + 现场 compare + extraMetrics
- [ ] `perf.interactions`：需要计时的交互 id（可空）

## 5. 首跑验证
- [ ] `vmr -c config/pages.yaml estimate` 规模符合预期
- [ ] 单页试跑：`vmr run --pages <id> --mode replay --auto-record`，确认无 tool-error 再铺开
