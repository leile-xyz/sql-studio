# 发布指南

## 版本同步

发布前同步以下版本：

- `extension/manifest.json`；
- `desktop/package.json` 与 `package-lock.json`；
- `desktop/src-tauri/Cargo.toml`；
- `desktop/src-tauri/tauri.conf.json`。

## 发布前检查

1. 更新 [CHANGELOG.md](../CHANGELOG.md)，把 Unreleased 内容归入新版本。
2. 运行 [测试指南](testing.md) 中的单测、Rust 检查、生产构建和 Windows E2E。
3. 确认生产构建未合并 `test/tauri.e2e.conf.json` 的 CDP 参数。
4. 检查仓库中没有 exe、安装包、日志、真实环境配置、凭据或内部截图。
5. 检查 Git 历史的作者姓名/邮箱、旧域名和敏感文件；首次公开前如需重写历史，应在建立公共协作前完成并通知所有已有协作者。
6. 确认公开仓库 URL 后，再补 package/Cargo 的 repository/homepage、扩展 `homepage_url` 和安全报告入口。
7. 生成或更新随二进制分发的第三方许可证清单。

## 构建产物

```powershell
Set-Location desktop
npm ci
npm run build
```

当前产物为未签名便携 exe：

```text
desktop/src-tauri/target/release/sql-studio.exe
```

不要把二进制直接提交到 Git；应使用代码托管平台的 Release Assets。发布页应包含版本、提交 SHA、校验值、变更摘要、支持的 Windows 版本和未签名说明。

## Git 标签

版本文件和变更记录提交后，再创建与应用版本一致的标签，例如 `v1.1.0`。仓库当前未配置远程地址或自动发布流程，不要在文档中写入占位 URL。
