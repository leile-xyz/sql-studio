# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用语义化版本号。

## [Unreleased]

### Added

- 自动联想支持字段、表、关键词和 SQL 函数的包含及跨词匹配。
- MySQL 与 PostgreSQL 方言函数候选隔离。
- 开源许可证、贡献指南、安全策略、隐私说明、社区行为准则和协作模板。

### Changed

- 完善多 SQL、PostgreSQL schema、自动联想和 Windows 桌面端文档。
- 扩展端凭据加解密失败会显式报错，不再降级为明文存储或原样返回。

## [1.0.0] - 2026-07-10

### Added

- Chrome/Edge Manifest V3 浏览器扩展。
- Windows Tauri 2 便携桌面端。
- MySQL 与 PostgreSQL schema 资源浏览、表数据、结构查看和 SQL 查询。
- 多环境登录、查询历史、控制台草稿、CSV 导出和 Windows 凭据管理器集成。
- 多 SQL 拆分执行、结果页签、失败继续及上下文自动联想。
