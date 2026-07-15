# 常见问题

## 地址可以填写路径吗？

不可以。`base` 只填写域名或 `IP:端口`，协议通过 `scheme` 选择。

## 登录成功但看不到实例或表怎么办？

确认账号在 Archery 中拥有 `can_read` 实例权限，接口返回 JSON 而非登录 HTML，并检查实例 `db_type` 和服务端日志。不要在公开 Issue 中粘贴真实响应。

## 出现 403 CSRF 怎么办？

确认环境协议、域名和端口正确，服务端 Cookie 域与访问地址一致，并检查 Archery 的 CSRF 配置和 Windows 系统时间。Rust 宿主会先获取 CSRF Cookie，再使用同一环境的 Cookie Jar 提交登录请求。

## Windows 提示缺少 WebView2 怎么办？

从 Microsoft 安装 WebView2 Runtime 后重新启动程序。

## Windows 桌面端白屏或关闭按钮无响应怎么办？

桌面端每次启动都会覆盖写入 `%TEMP%\sql-studio-startup.log`。复现后等待至少 15 秒再复制日志，启动看门狗会在 5、15、30、60、120 秒写入最后完成的阶段；从 15 秒起还会记录 `msedgewebview2.exe` 进程列表和 WebView2 Crashpad 崩溃报告。日志同时记录 Windows 版本、显卡与驱动、WebView2 Runtime、WebView2 策略和环境变量、WebView2 用户数据目录状态、窗口状态文件、Tauri 插件、窗口/WebView 创建、页面导航、前端模块及全局错误。

启动阶段按顺序为：`native-entered` → `environment-logged` → `plugins-registered` → `context-created` → `building-application` → `application-built` → `event-loop-starting` → `setup-entered` → `creating-main-window` → `main-window-created` → `setup-completed` → `event-loop-ready` → `frontend-loaded`。根据最后一条阶段日志判断范围：

- 停在 `event-loop-starting` 之前：Tauri Builder/Runtime 构造阶段，与 WebView2 无关；
- 停在 `setup-entered` 之前后：检查配置目录、被重定向的 `%APPDATA%` 和窗口状态文件日志；
- 停在 `creating-main-window`：WebView2 环境/控制器创建挂死，结合看门狗的健康信息判断——
  - 没有任何 `msedgewebview2.exe` 进程：浏览器进程从未启动或启动即退出，优先怀疑安全软件/EDR 拦截、WebView2 Runtime 损坏；
  - 进程存在但多次看门狗输出中 PID 不断变化：子进程崩溃循环，查看紧随其后的 `webview2 crash report` 行；
  - 进程稳定存在但始终无 `main window created`：GPU/合成初始化挂死，尝试 `--disable-gpu`；
- 有 `main window created`，没有 `page load ... Finished`：内嵌前端资源加载失败；
- 有 `page load ... Finished`，没有 `frontend app module evaluated`：JavaScript 模块导入失败；
- 有前端模块日志但初始化未完成：根据紧随其后的 JavaScript 错误定位业务初始化。

两项内置缓解措施：

- **启动自愈（逐级降级）**：每次启动会在 `%LOCALAPPDATA%\com.fanxiaofan.sql-studio\startup-pending.flag` 写入未完成标记（内容为连续失败次数），前端加载成功后删除。若启动时发现标记残留（上次启动卡死）：
  - 连续失败 ≥1 次：把 WebView2 用户数据目录 `EBWebView` 改名为 `EBWebView.broken` 后全新重建——用户数据损坏是控制器创建挂死的常见原因；
  - 连续失败 ≥2 次：额外追加 `--disable-gpu --disable-gpu-compositing`，绕过老显卡驱动/老系统上 GPU 与 DirectComposition 合成初始化挂死。

  因此**卡死后连续再启动两次**即可依次触发全部自动修复；环境配置、历史等业务数据存于 `store.json`，不受影响。
- **Win10 浏览器参数**：Windows 10（build < 22000）上自动追加 `--disable-features=RendererCodeIntegrity`，规避安全软件注入 DLL 触发渲染进程崩溃循环导致的白屏；Windows 11 保持默认参数。

需要验证 GPU 初始化问题时，可显式运行一次诊断启动：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-gpu"
.\sql-studio.exe
```

仍卡死时可追加禁用 GPU 合成再试一次：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-gpu --disable-gpu-compositing"
.\sql-studio.exe
```

该变量只对当前 PowerShell 会话生效，日志会明确记录它是否启用。日志每次启动会被清空，不包含 SQL 查询结果或密码。

## 老系统上常青运行时不兼容怎么办（Fixed Version）？

机器上的 WebView2 常青运行时会自动升级到最新 Chromium；在多年未打补丁的老系统（如 Windows 10 1809 早期补丁级别）上，新内核可能整体不兼容而卡死。此时可改用固定版本运行时：

1. 下载 Fixed Version 运行时 cab（官方页面只保留最近两个大版本，更老版本可从社区存档 [WebView2RuntimeArchive](https://github.com/westinyang/WebView2RuntimeArchive) 获取；推荐先试 120.0.2210.144，仍不行再降到 109.0.1518.78）；
2. 解包并放到 exe 同目录、命名为 `WebView2Runtime`：

   ```powershell
   expand.exe -F:* .\Microsoft.WebView2.FixedVersionRuntime.120.0.2210.144.x64.cab .
   Rename-Item ".\Microsoft.WebView2.FixedVersionRuntime.120.0.2210.144.x64" "WebView2Runtime"
   # 校验确为微软签名（社区存档必须做这步）
   Get-AuthenticodeSignature .\WebView2Runtime\msedgewebview2.exe
   ```

3. 启动程序。日志出现 `fixed webview2 runtime enabled: ...` 即生效；exe 旁无 `WebView2Runtime` 目录时行为不变（继续用常青运行时）。已手动设置 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 时程序不会覆盖。

注意：固定版本不再接收安全更新，仅建议在受控内网中用于常青运行时无法工作的机器。

## SmartScreen 为什么提示未知发布者？

当前构建未配置代码签名。请自行从源码构建，或只运行可信发布渠道提供且校验值一致的产物。

## 桌面端为什么不走系统代理？

当前定位是受控内网客户端，Rust HTTP 客户端强制直连，避免内网地址被系统代理劫持。需要代理的环境当前不受支持。

## 自签 HTTPS 能连接吗？

当前客户端接受无效/自签证书，但这会降低 TLS 安全性，仅适合受控内网。

## PostgreSQL 为什么没有 DDL 页签？

当前兼容的 Archery `describetable` 响应只提供列元数据，不提供完整建表 DDL，因此客户端不展示无数据来源的 DDL 页签。

## 为什么表数据查询会多一次 COUNT 查询？

分页栏需要精确总条数和总页数。打开表、翻页、排序、刷新或修改 WHERE 时，客户端都会额外执行一条使用相同表与 WHERE 条件的 `COUNT(*)`，并据此限制首页、上一页、下一页和末页按钮。`/query/` 返回的 `affected_rows` 不是 SELECT 的全表总数，不能替代该查询。

大表、复杂 WHERE 或缺少合适索引时，COUNT 可能增加数据库负载和等待时间；执行计划、超时、审核及权限仍由数据库和 Archery 控制。

## 如何清理保存密码、历史和控制台工作区？

见 [配置与本地数据](configuration.md)。仅删除桌面 exe 不会清除 Windows 凭据管理器和 AppData 配置。

## 多 SQL 中一条失败后为什么继续？

控制台按拆分后的语句顺序执行并为每条创建结果页签。单条失败会保留错误并继续后续语句，方便查看完整批次结果。

## 客户端会绕过 Archery 权限或脱敏吗？

不会。实例权限、SQL 审核、脱敏、查询限制和数据库权限仍由服务端决定。
