# 第三方软件与许可证

SQL Studio 自有代码按 [MIT License](../LICENSE) 分发。依赖项、开发工具和兼容服务由各自许可证或使用条款约束，MIT License 不会替代这些条款。

主要直接依赖包括：

- [Tauri](https://tauri.app/) 及其 dialog/window-state 插件；
- [reqwest](https://github.com/seanmonstar/reqwest)；
- [serde](https://serde.rs/) 与 `serde_json`；
- [Tokio](https://tokio.rs/)；
- [keyring-rs](https://github.com/hwchen/keyring-rs)；
- [Playwright](https://playwright.dev/)；
- Chrome/Edge Manifest V3 与 WebView2 平台 API。

精确版本由 `desktop/package-lock.json` 与 `desktop/src-tauri/Cargo.lock` 固定。分发编译后的桌面程序前，应根据锁文件和上游包元数据生成完整的第三方许可证清单，并随 Release Assets 一起提供。

Archery 是独立的服务端项目，SQL Studio 仅调用其 HTTP 接口，不包含或重新分发 Archery 源码。Archery 名称和项目内容受其自身许可证及项目规则约束。
