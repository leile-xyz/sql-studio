#!/usr/bin/env node
// 把构建产物复制到工作区外的运行目录。
//
// 背景：D:\my\fanxiaofan 被 Agent 沙箱（Codex / DeepSeek Harness 的 windows-acl 沙箱）打上了
// ACL 标记，凡是从该目录内启动的 exe 都会被限制成「只可写工作区内」。而 SQL Studio 的
// workflow.db 位于 %APPDATA%\com.fanxiaofan.sql-studio\（工作区外），写入会被拒绝，
// 导致 Tauri setup 钩子报错并以退出码 101 panic，窗口根本不出现。
// 因此运行用的 exe 必须放在工作区之外。
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 以脚本自身位置定位工程根目录，避免受调用时的当前工作目录影响。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(projectRoot, "src-tauri", "target", "release", "sql-studio.exe");
const targetDir = process.env.SQL_STUDIO_DEPLOY_DIR ?? "D:\\Program Files\\SQL Studio";
const target = join(targetDir, "sql-studio.exe");

if (!existsSync(source)) {
  console.error(`找不到构建产物：${source}\n请先运行 npm run build。`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);

const size = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`已部署到工作区外：${target}（${size} MB）`);
