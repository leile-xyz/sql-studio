# 开发指南

## 工具链

- Node.js 20+；
- Rust stable MSVC；
- Microsoft C++ Build Tools；
- WebView2 Runtime；
- Chrome 或 Edge。

```powershell
Set-Location desktop
npm ci
npm test
npm run dev
```

## 修改位置

| 变更类型 | 主要位置 |
|----------|----------|
| SQL 编辑、自动联想、表/网格 UI | 双端 `lib/` 共享模块 |
| 浏览器跨域、Cookie、CSRF | `extension/background.js` |
| 浏览器本地配置和密码 | `extension/lib/store.js`、`crypto.js` |
| 桌面网络、Cookie、凭据、文件对话框 | `desktop/src-tauri/src/main.rs` |
| 桌面本地配置 | `desktop/src/lib/store.js` |
| 通用 UI 编排 | 双端 `app.js`，需保持行为一致 |

共享模块清单见 [架构说明](architecture.md)。修改共享模块时应先在一端完成小范围变更，再同步另一端，并通过 parity 测试验证。

## 工程约定

- UTF-8 无 BOM、LF 行尾；
- 函数不超过 100 行，源文件不超过 1000 行；
- 避免深层嵌套和隐式全局状态；
- 不吞掉异常，不伪造成功，不将安全失败降级为明文或默认成功；
- 外部 API 响应在边界校验；
- SQL 标识符使用 `db-context.mjs` 中的方言引用函数；
- 新功能考虑 MySQL 与 PostgreSQL schema；
- 用户可见行为同步更新测试和文档。

## 浏览器扩展调试

加载 `extension/` 后，在扩展管理页打开 service worker 开发者工具调试网络层；主页面使用普通页面开发者工具。修改源文件后点击扩展“重新加载”，再刷新 SQL Studio 页面。

## Windows 调试

`npm run dev` 启动 Tauri 开发模式。Rust command 错误应通过 rejected invoke 显式传递到前端，不要返回模拟结果或空对象掩盖失败。

## 敏感数据

只使用 `default-envs.json` 中的 example.com、`desktop/test/mock-dbadmin.js` 或其他虚构数据。公开前还应检查 Git 历史的作者邮箱、旧域名和大文件；详见 [发布指南](releasing.md)。
