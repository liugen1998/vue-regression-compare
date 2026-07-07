# 批量导入样例

可复制到 Web UI 的“批量导入页面”区域。真实使用时替换页面名和 URL。

```markdown
| 页面 | VUE2链接 | VUE3链接 |
|---|---|---|
| 服务满意度 | http://vue2.example.internal/service-satisfaction | http://vue3.example.internal/service-satisfaction |
| 客户分析 | http://vue2.example.internal/customer-analysis | http://vue3.example.internal/customer-analysis |
```

导入后建议执行：

```powershell
corepack pnpm run validate-config
```

如果页面需要登录：

```powershell
corepack pnpm run auth
```

登录态默认写入：

```text
workspace/auth/storageState.json
```

不要把真实登录态提交或写入文档。
