# 快速入门

## 前置条件

SQL Studio 不包含数据库驱动，也不直连 MySQL/PostgreSQL。它连接用户已有的 Archery 服务，该服务至少需要提供登录、实例资源、表结构和 SQL 查询接口。

PostgreSQL schema 浏览依赖实例数据中的 `db_type` 为 `pgsql`、`postgres` 或 `postgresql`。

## 浏览器扩展

1. 下载或克隆仓库。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启开发者模式。
4. 点击“加载已解压的扩展程序”，选择 `extension/`。
5. 点击工具栏中的 SQL Studio 图标。
6. 在环境管理中新增环境并登录。

扩展使用浏览器 Cookie 维持 Django 会话，并通过 service worker 和动态请求规则处理跨域、Origin、Referer 与 CSRF。

## Windows 桌面端

### 开发环境

- Windows 10/11；
- Node.js 20 或更高版本；
- Rust stable MSVC 工具链；
- Microsoft C++ Build Tools；
- WebView2 Runtime（多数 Windows 10/11 已安装，缺失时需从 Microsoft 安装）。

### 构建

```powershell
Set-Location desktop
npm ci
npm test
npm run build
```

生成的便携程序位于：

```text
desktop/src-tauri/target/release/sql-studio.exe
```

程序未配置代码签名，首次运行可能触发 SmartScreen。请只运行自己构建或来自可信发布渠道的产物。

## 首次配置

环境字段：

| 字段 | 说明 |
|------|------|
| `id` | 本地唯一且稳定的环境标识，修改后会被视为新环境 |
| `name` | UI 展示名称 |
| `color` | 环境标识色，建议使用十六进制颜色 |
| `scheme` | `http` 或 `https` |
| `base` | 主机名或 `IP:端口`，不含协议、路径和查询参数 |

例如：

```json
{
  "id": "dev",
  "name": "开发环境",
  "color": "#5fad65",
  "scheme": "https",
  "base": "archery-dev.example.com"
}
```

点击登录后，客户端会先获取 Django CSRF Cookie，再提交 `/authenticate/`。登录成功后会加载当前账号可读的实例列表。

## 默认环境

`extension/default-envs.json` 与 `desktop/src/default-envs.json` 是首次初始化使用的示例。它们不会覆盖已经存在的本地配置，也不应写入真实内网地址或账号信息。

浏览器扩展与桌面端的数据存储彼此独立，不会自动同步。详细位置和清理方式见 [配置与本地数据](configuration.md)。

顶栏右侧的“关于 SQL Studio”按钮可查看当前版本、客户端类型和 MIT 许可证。
