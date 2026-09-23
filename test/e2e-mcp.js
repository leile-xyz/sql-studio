/**
 * MCP 服务 E2E — 通过 WebView2 远程调试端口（CDP）驱动真实应用，验证：
 *   1. MCP 弹窗展示 /sql 接口与 token；
 *   2. 本地 HTTP `POST /sql` 的鉴权、请求体、参数边界与结果字段；
 *   3. 跨环境免登录：界面停在线上、目标环境没有会话时，用已保存凭据自动登录后查询；
 *   4. MCP `tools/list` 与 `tools/call execute_sql` 链路。
 *
 * 用法：
 *   终端一：node test/mock-archery.js
 *   终端二：node test/e2e-mcp.js .\src-tauri\target\release\sql-studio.exe
 * 前置：按 docs/testing.md 用 test/tauri.e2e.conf.json 构建带 CDP 参数的测试程序。
 *
 * 安全：本脚本会替换 %APPDATA%\com.fanxiaofan.sql-studio\store.json，
 * 结束（含异常与 Ctrl+C）时从备份还原并做哈希校验；同时清理测试环境在凭据管理器中的条目。
 */
const { chromium } = require('playwright-core');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXE = process.argv[2];
const CDP_PORT = 9333;
// CDP 走本地回环，必须绕过系统代理（否则 connectOverCDP 被代理劫持返回 502）
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1,localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

const APPDATA_DIR = path.join(process.env.APPDATA, 'com.fanxiaofan.sql-studio');
const STORE_PATH = path.join(APPDATA_DIR, 'store.json');
const BACKUP_PATH = path.join(process.env.TEMP, 'sql-studio-e2e-mcp-store-backup.json');
const MCP_PORT = 37625;
const ENVS = [
  { id: 'mock-prod', name: '线上', color: '#d9534f', base: '127.0.0.1:9123', scheme: 'http' },
  { id: 'mock-pre', name: '预发', color: '#5fad65', base: '127.0.0.1:9123', scheme: 'http' },
];
const CREDENTIAL_TARGETS = ENVS.map(env => `${env.id}.sql-studio`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hashOf = file => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing');

function restoreStore() {
  if (fs.existsSync(BACKUP_PATH)) fs.copyFileSync(BACKUP_PATH, STORE_PATH);
}
function cleanupCredentials() {
  for (const target of CREDENTIAL_TARGETS) {
    spawnSync('cmdkey', ['/delete:' + target], { stdio: 'ignore' });
  }
}
function killStale() {
  spawnSync('taskkill', ['/IM', 'sql-studio.exe', '/F'], { stdio: 'ignore' });
  spawnSync('powershell', ['-c',
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match 'fanxiaofan' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ], { stdio: 'ignore' });
}
function seedStore(activeEnvId, extra = {}) {
  fs.mkdirSync(APPDATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify({ sqls_envs: ENVS, sqls_active_env: activeEnvId, ...extra }));
}
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { return {}; }
}

let child = null;
let browser = null;

/** 启动应用并在登录弹窗里登录（勾选记住密码） */
async function launchAndLogin(user, password) {
  child = spawn(EXE, [], { stdio: 'ignore', detached: false });
  browser = null;
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(500);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); } catch (e) { }
  }
  if (!browser) throw new Error('无法连接 WebView2 CDP');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('#topbar', { timeout: 20000 });
  await page.waitForSelector('#loginMask.show', { timeout: 20000 });
  await page.fill('#loginUser', user);
  await page.fill('#loginPwd', password);
  await page.check('#loginRemember');
  await page.click('#loginSubmit');
  await page.waitForFunction(() => document.getElementById('connText').textContent.includes('已连接'), null, { timeout: 20000 });
  return page;
}

async function stopApp() {
  try { await browser?.close(); } catch (e) { }
  if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  browser = null;
  child = null;
  await sleep(1500);
}

async function callSql(token, body, options = {}) {
  const url = `http://127.0.0.1:${MCP_PORT}/sql${token && !options.useHeader ? '?token=' + token : ''}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token && options.useHeader) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { }
  return { status: response.status, json, text };
}

async function rpcMcp(token, message) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  return response.json();
}

const query = (envId, extra = {}) => Object.assign({
  envId,
  instanceName: 'mock-inst',
  databaseName: 'demo_db',
  schemaName: '',
  sql: 'SELECT * FROM t_user',
  limit: 5,
}, extra);

async function main() {
  if (!EXE || !fs.existsSync(EXE)) throw new Error('exe 不存在: ' + EXE);
  if (fs.existsSync(STORE_PATH)) fs.copyFileSync(STORE_PATH, BACKUP_PATH);

  killStale();
  await sleep(1500);
  cleanupCredentials();

  // 阶段一：只登录预发，留下「已保存凭据」，不留会话
  seedStore('mock-pre');
  await launchAndLogin('tester', 'pass123');
  check('登录预发成功', true);
  await stopApp();
  const saved = readStore().sqls_creds || {};
  check('预发用户名与记住标记已落盘（密码不入 store.json）',
    saved['mock-pre']?.user === 'tester' && saved['mock-pre']?.remember === true
    && !JSON.stringify(saved).includes('pass123'), JSON.stringify(saved['mock-pre'] ?? null));

  // 阶段二：活动环境改为线上，只登录线上；预发没有会话，只有已保存凭据
  seedStore('mock-prod', { sqls_creds: saved });
  const page = await launchAndLogin('tester', 'pass123');
  check('登录线上成功，界面停在线上', (await page.textContent('#envName')).includes('线上'));

  await page.click('#btnMcp');
  await page.waitForSelector('#mcpMask.show', { timeout: 10000 });
  const token = (await page.textContent('#mcpToken')).trim();
  const sqlEndpoint = (await page.textContent('#mcpSqlEndpoint')).trim();
  check('MCP 弹窗展示 SQL 接口与 40 位 token',
    sqlEndpoint.startsWith(`http://127.0.0.1:${MCP_PORT}/sql?token=`) && token.length === 40,
    sqlEndpoint.replace(/token=.*/, 'token=***'));

  // 「?」打开的接口文档：地址与 curl 示例必须带当前 Token
  await page.click('#mcpSqlHelp');
  await page.waitForSelector('#sqlApiMask.show', { timeout: 8000 });
  const docEndpoint = (await page.textContent('#sqlApiEndpoint')).trim();
  const docCurl = (await page.textContent('#sqlApiCurl')).trim();
  const docText = await page.textContent('#sqlApiMask');
  check('接口文档弹窗带当前 Token 的地址与 curl 示例',
    docEndpoint === sqlEndpoint && docCurl.startsWith('curl.exe -X POST "') && docCurl.includes(`"${sqlEndpoint}"`),
    docCurl.slice(0, 96) + '…');
  check('接口文档含参数、状态码与错误说明',
    ['schemaName', 'limit', '401', 'truncated', '环境不存在'].every(keyword => docText.includes(keyword)));
  await page.click('#sqlApiClose');
  await page.waitForFunction(() => !document.getElementById('sqlApiMask').classList.contains('show'), null, { timeout: 8000 });
  check('接口文档弹窗可关闭且 MCP 弹窗仍在', await page.locator('#mcpMask.show').isVisible());
  await page.click('#mcpClose');

  // 核心场景：界面在线上，预发无会话，靠已保存凭据免登录查询
  const crossEnv = await callSql(token, query('mock-pre'));
  check('跨环境免登录：界面在线上、预发无会话仍查询成功',
    crossEnv.json?.ok === true && crossEnv.json.result.rows.length > 0,
    JSON.stringify(crossEnv.json).slice(0, 140));
  check('结果含列定义、行数、耗时与脱敏标记',
    crossEnv.json?.result?.columns?.length > 0
    && typeof crossEnv.json?.result?.elapsedSeconds === 'number'
    && typeof crossEnv.json?.result?.isMasked === 'boolean'
    && crossEnv.json?.result?.rowCount === crossEnv.json.result.rows.length
    && crossEnv.json?.result?.rowLimit === 5
    && typeof crossEnv.json?.result?.fullSql === 'string',
    JSON.stringify(crossEnv.json?.result ?? {}).slice(0, 120));

  const ownEnv = await callSql(token, query('mock-prod'));
  check('界面所在环境同样可查询', ownEnv.json?.ok === true, JSON.stringify(ownEnv.json).slice(0, 100));
  const uiEnv = await page.textContent('#envName');
  const uiConn = await page.textContent('#connText');
  check('跨环境调用不影响界面当前环境', uiEnv.includes('线上') && uiConn.includes('已连接'), uiEnv + ' / ' + uiConn);

  // 鉴权与请求体
  check('无 token 返回 401', (await callSql(null, query('mock-prod'))).status === 401);
  check('错误 token 返回 401', (await callSql('wrong-token', query('mock-prod'))).status === 401);
  check('请求体不是 JSON 对象返回 400', (await callSql(token, '[]')).status === 400);
  check('Authorization: Bearer 同样可用', (await callSql(token, query('mock-pre'), { useHeader: true })).json?.ok === true);

  // 参数边界
  check('limit 超出上限夹紧到 1000',
    (await callSql(token, query('mock-prod', { limit: 99999 }))).json?.result?.rowLimit === 1000);
  check('空 SQL 被拒绝',
    (await callSql(token, query('mock-prod', { sql: '   ' }))).json?.error === 'SQL 不能为空');
  check('未知环境返回明确错误',
    /环境不存在/.test(String((await callSql(token, query('nope'))).json?.error)),
    String((await callSql(token, query('nope'))).json?.error));

  // MCP 侧链路
  const tools = await rpcMcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = (tools.result?.tools ?? []).map(tool => tool.name);
  check('MCP 暴露 6 个工具且含 execute_sql',
    names.length === 6 && names.includes('execute_sql'), names.join(','));
  const call = await rpcMcp(token, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'execute_sql', arguments: query('mock-pre') },
  });
  const payload = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
  check('MCP tools/call execute_sql 跨环境返回数据', payload.rows?.length > 0, JSON.stringify(payload).slice(0, 120));
}

process.on('exit', () => {
  try {
    if (fs.existsSync(BACKUP_PATH) && hashOf(STORE_PATH) !== hashOf(BACKUP_PATH)) restoreStore();
  } catch (e) { }
});

main()
  .catch(error => {
    console.error('E2E 异常:', error.message);
    results.push({ name: 'E2E 执行', ok: false });
  })
  .finally(async () => {
    await stopApp();
    // 备份文件保留在 TEMP 里同名覆盖，万一需要人工核对也能找到
    const backupHash = hashOf(BACKUP_PATH);
    restoreStore();
    cleanupCredentials();
    check('真实 store.json 已还原且与备份一致', hashOf(STORE_PATH) === backupHash, String(backupHash).slice(0, 12));

    const fail = results.filter(item => !item.ok).length;
    console.log(`\n${results.length - fail}/${results.length} 项通过`);
    process.exit(fail ? 1 : 0);
  });
