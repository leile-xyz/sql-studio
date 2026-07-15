# 开发指南

## 工具链

- Node.js 20+；
- Rust stable MSVC；
- Microsoft C++ Build Tools；
- WebView2 Runtime。

```powershell
Set-Location desktop
npm ci
npm test
npm run dev
```

## 修改位置

| 变更类型 | 主要位置 |
|----------|----------|
| 页面状态和通用 UI 编排 | `desktop/src/app.js` |
| SQL 编辑、自动联想、表/网格 UI | `desktop/src/lib/` 对应职责模块 |
| 前端到宿主的接口封装 | `desktop/src/lib/api.js` |
| 本地配置 | `desktop/src/lib/store.js` |
| 网络、Cookie、凭据和文件对话框 | `desktop/src-tauri/src/main.rs` |
| 单元、项目和 E2E 测试 | `desktop/test/` |

模块清单和请求链路见 [架构说明](architecture.md)。业务规则优先写成可独立测试的模块；系统能力保留在 Rust 宿主，通过明确的 Tauri command 边界调用。

## 工程约定

- UTF-8 无 BOM、LF 行尾；
- 函数不超过 100 行，源文件不超过 1000 行；
- 避免深层嵌套和隐式全局状态；
- 不吞掉异常，不伪造成功，不将安全失败降级为明文或默认成功；
- 外部 API 响应在边界校验；
- SQL 标识符使用 `db-context.mjs` 中的方言引用函数；
- 新功能考虑 MySQL 与 PostgreSQL schema；
- 用户可见行为同步更新测试和文档。

## Windows 调试

`npm run dev` 启动 Tauri 开发模式。Rust command 错误应通过 rejected invoke 显式传递到前端，不要返回模拟结果或空对象掩盖失败。

前端页面在 WebView2 中运行；需要检查 DOM、事件或网络调用时使用开发构建的开发者工具。生产构建不得合并 E2E 专用的 CDP 参数。

## 敏感数据

只使用 `desktop/src/default-envs.json` 中的 example.com、`desktop/test/mock-archery.js` 或其他虚构数据。公开前还应检查 Git 历史的作者邮箱、旧域名和大文件；详见 [发布指南](releasing.md)。
