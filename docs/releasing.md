# 发布指南

## 版本同步

发布前同步以下版本：

- `package.json` 与 `package-lock.json`；
- `src-tauri/Cargo.toml`；
- `src-tauri/tauri.conf.json`。

关于弹窗的版本从 Tauri 包信息动态读取，不维护独立版本常量。

## 发布前检查

1. 更新 [CHANGELOG.md](../CHANGELOG.md)，把 Unreleased 内容归入新版本。
2. 运行 [测试指南](testing.md) 中的单测、Rust 检查、生产构建和 Windows E2E。
3. 确认生产构建未合并 `test/tauri.e2e.conf.json` 的 CDP 参数。
4. 检查仓库中没有 exe、安装包、日志、真实环境配置、凭据或内部截图。
5. 检查 Git 历史的作者姓名/邮箱、旧域名和敏感文件；首次公开前如需重写历史，应在建立公共协作前完成并通知所有已有协作者。
6. 打开关于弹窗，确认版本、客户端类型和许可证正确。
7. 生成或更新随二进制分发的第三方许可证清单。

## 构建产物

```powershell
npm ci
npm run build
```

当前产物为未签名便携 exe：

```text
src-tauri/target/release/sql-studio.exe
```

不要把二进制直接提交到 Git；应使用代码托管平台的 Release Assets。发布页应包含版本、提交 SHA、校验值、变更摘要、支持的 Windows 版本和未签名说明。

## Git 标签

版本文件和变更记录提交后，再创建与应用版本一致的标签，例如 `v1.1.0`。项目主页为 [github.com/leile-xyz/sql-studio](https://github.com/leile-xyz/sql-studio)。
