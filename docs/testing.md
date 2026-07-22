# 测试指南

## 单元测试

```powershell
npm ci
npm test
```

测试覆盖 SQL 拆分、多语句格式化、自动联想、MySQL/PostgreSQL 方言、schema 上下文、多控制台会话迁移与恢复、CSV、关于弹窗元数据和桌面端项目结构。

## 静态检查

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

JavaScript/MJS 语法检查由项目测试和 CI 对 `src/` 全量执行。

## 生产构建

```powershell
npm run build
```

生产配置不开放 WebView2 CDP 调试端口。

## Windows E2E

E2E 仅支持 Windows，使用 mock Archery 和带本地 CDP 调试参数的测试构建。

桌面端流程同时检查关于弹窗的入口、版本、许可证和关闭交互。

构建测试程序：

```powershell
npm ci
npx tauri build --no-bundle --config test/tauri.e2e.conf.json
```

终端一启动 mock，默认监听 `127.0.0.1:9123`：

```powershell
node test/mock-archery.js
```

终端二运行 E2E：

```powershell
node test/e2e.js .\src-tauri\target\release\sql-studio.exe
```

注意：

- E2E 会终止已有的 `sql-studio.exe` 和匹配测试应用标识的 WebView2 进程；
- 测试会写入 `%APPDATA%\com.fanxiaofan.sql-studio\store.json`；
- 测试脚本为本地 CDP 设置 `NO_PROXY`；
- `test/tauri.e2e.conf.json` 生成的程序只用于测试，不能发布；
- 出现失败时保留真实错误和日志，不要改成 mock 成功路径。

## 轻量模式手动验收

1. 确认托盘右键菜单仅包含“打开主界面”“进入轻量模式”“退出”，且轻量模式不是勾选项；点击“进入轻量模式”后退出并冷启动应用。
2. 确认 `sql-studio.exe` 与托盘仍存在，同时该应用进程树中没有 `msedgewebview2.exe`。
3. 左键托盘，确认只创建一个主窗口；修改环境、活动控制台、SQL 和侧边栏状态。
4. 关闭主窗口，确认原生进程与托盘保留，并等待该应用的 WebView2 后代自然清零。
5. 再次左键托盘，确认环境、控制台和界面快照恢复；连续点击不能产生多个 `main` 窗口。
6. 关闭主窗口后使用托盘“退出”，确认原生进程结束。

进程检查必须按原生 PID、WebView2 根进程及其后代关系判断。启动前的环境清理可以终止旧进程，但关闭窗口后的验收阶段不能调用 `taskkill`、`Stop-Process` 或其他强杀命令制造成功结果。
