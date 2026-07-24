/**
 * 桌面端 e2e 验证 — 通过 WebView2 远程调试端口（CDP）驱动真实应用，
 * 后端连 test/mock-archery.js，覆盖：登录(CSRF) → 树浏览 → 表数据 → 结构 → 控制台 SQL。
 * 用法：先启动 mock（node test/mock-archery.js），再 node test/e2e.js <exe路径>
 */
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = process.argv[2];
const CDP_PORT = 9333;
const MOCK_PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname, 'mock-environments.json'), 'utf8'));
const MOCK_ENVIRONMENTS = Object.freeze(MOCK_PROFILE.environments);
const ACTIVE_ENV_ID = MOCK_ENVIRONMENTS[0].id;
// CDP 走本地回环，必须绕过系统代理（否则 connectOverCDP 被代理劫持返回 502）
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1,localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;
const APPDATA_DIR = path.join(process.env.APPDATA, 'com.fanxiaofan.sql-studio');
const MULTI_SQL = 'SELECT 1;\nSELECT * FROM t_user;';
const SELECTED_SQL = 'SELECT * FROM t_user;';
// 验证「某条失败时继续其余条」：第 1 条成功、第 2 条失败、第 3 条成功
const MIXED_SQL = 'SELECT 1;\nSELECT FAIL;\nSELECT * FROM t_user;';
const STORE_PATH = path.join(APPDATA_DIR, 'store.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function restoreStore(backup) {
  if (backup == null) fs.rmSync(STORE_PATH, { force: true });
  else fs.writeFileSync(STORE_PATH, backup);
}
async function openNewConsole(page) {
  await page.click('[data-act="toggle-console-menu"]');
  await page.click('#consoleMenu [data-act="new-console"]');
  await page.waitForSelector('#edTa', { timeout: 8000 });
}

async function openConsoleFromAll(page, index) {
  await page.click('[data-act="toggle-console-menu"]');
  await page.click('#consoleMenu [data-act="show-all-consoles"]');
  const items = page.locator('#consoleAllMenu [data-act="open-console"]');
  await items.nth(index).click();
  await page.waitForSelector('#edTa', { timeout: 8000 });
}

async function testPostgresFlow(page) {
  const treeNode = text => page.locator('#tree .tnode').filter({ hasText: text }).first();
  const expandNode = async text => {
    const node = treeNode(text);
    await node.waitFor({ timeout: 8000 });
    const expanded = await node.locator('.twist').first().evaluate(element => element.classList.contains('open'));
    if (!expanded) await node.click();
  };
  await expandNode('mock-pg');
  await page.waitForSelector('#tree .tnode:has-text("dify")', { timeout: 8000 });
  check('PostgreSQL 数据库加载', true);

  await expandNode('dify');
  await page.waitForSelector('#tree .tnode:has-text("public")', { timeout: 8000 });
  check('PostgreSQL 模式层加载', (await page.locator('#tree').textContent()).includes('audit'));

  await expandNode('public');
  const pgTables = page.locator('#tree .tnode[data-table]').filter({ hasText: 'account_integrates' });
  try {
    await pgTables.first().waitFor({ timeout: 8000 });
  } catch (error) {
    const treeHtml = await page.locator('#tree').innerHTML();
    throw new Error(error.message + '\nPostgreSQL 树 DOM：' + treeHtml);
  }
  check('public 模式表加载', true);
  await pgTables.first().locator('span').nth(2).click();
  await page.waitForFunction(() => document.querySelector('#tabbody')?.textContent.includes('public-provider'), null, { timeout: 8000 });
  check('PostgreSQL public 表数据与 schema 查询', (await page.textContent('#sbSql')).includes('"public"."account_integrates"'));

  const pgDdlTabs = page.locator('#tabbody [data-act="subview"][data-v="ddl"]');
  check('PostgreSQL 不展示 DDL 页签', await pgDdlTabs.count() === 0, '');

  await page.click('#tabbody [data-act="subview"][data-v="struct"]');
  await page.waitForSelector('#tabbody .structwrap', { timeout: 8000 });
  const structure = await page.textContent('#tabbody');
  check('PostgreSQL 列结构解析', structure.includes('provider') && structure.includes('PostgreSQL'), '');

  await page.click('#tabbody [data-act="subview"][data-v="data"]');
  await page.click('#tabbody [data-act="to-console"]');
  await page.waitForSelector('[data-act="con-schema"]', { timeout: 8000 });
  check('控制台继承 PostgreSQL 模式', await page.inputValue('[data-act="con-schema"]') === 'public');
  check('控制台继承 schema 限定 SQL', (await page.inputValue('#edTa')).includes('"public"."account_integrates"'));

  await expandNode('audit');
  await page.waitForFunction(() => document.querySelectorAll('#tree .tnode[data-table]').length >= 3, null, { timeout: 8000 });
  const auditTable = page.locator('#tree .tnode[data-table]').filter({ hasText: 'account_integrates' }).last();
  await auditTable.locator('span').nth(2).click();
  await page.waitForFunction(() => document.querySelector('#tabbody')?.textContent.includes('audit-row'), null, { timeout: 8000 });
  check('同名表按 schema 隔离标签与数据', (await page.textContent('#sbSql')).includes('"audit"."account_integrates"'));
}

async function main() {
  if (!EXE || !fs.existsSync(EXE)) throw new Error('exe 不存在: ' + EXE);
  const storeBackup = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH) : null;

  // 清理残留进程：WebView2 会复用同 user-data-dir 的浏览器进程，旧进程不带调试参数
  const { spawnSync } = require('child_process');
  spawnSync('taskkill', ['/IM', 'sql-studio.exe', '/F'], { stdio: 'ignore' });
  spawnSync('powershell', ['-c',
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -match 'fanxiaofan' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ], { stdio: 'ignore' });
  await sleep(1500);

  // 预置多环境 mock 配置，供切环境与性能测试复用。
  fs.mkdirSync(APPDATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify({
    sqls_envs: MOCK_ENVIRONMENTS,
    sqls_active_env: ACTIVE_ENV_ID
  }));

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --remote-allow-origins=*` },
    stdio: 'ignore', detached: false
  });

  let browser;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`); break; } catch (e) { }
  }
  if (!browser) {
    child.kill();
    restoreStore(storeBackup);
    throw new Error('无法连接 WebView2 CDP');
  }

  try {
    const page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('#topbar', { timeout: 10000 });
    check('应用启动，主界面渲染', true);
    await page.click('#btnSidebarCollapse');
    check('数据库侧边栏可收起', await page.locator('#main').evaluate(element => element.classList.contains('sidebar-collapsed')));
    await page.click('#btnSidebarExpand');
    check('数据库侧边栏可重新展开', await page.locator('#sidebar').isVisible());

    // 登录弹窗自动弹出（无会话、无记住密码）
    await page.waitForSelector('#loginMask.show', { timeout: 10000 });
    check('无会话时自动弹出登录框', true);

    // 错误密码 → 报错
    await page.fill('#loginUser', 'tester');
    await page.fill('#loginPwd', 'wrong');
    await page.click('#loginSubmit');
    await page.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0, null, { timeout: 8000 });
    const err = await page.textContent('#loginErr');
    check('错误密码返回 Archery msg', err.includes('用户名或密码错误'), err);

    // 正确登录（勾选记住密码 → 走凭据管理器）
    await page.fill('#loginPwd', 'pass123');
    await page.check('#loginRemember');
    await page.click('#loginSubmit');
    await page.waitForSelector('#loginMask.show', { state: 'detached', timeout: 8000 }).catch(() => { });
    await page.waitForFunction(() => !document.getElementById('loginMask').classList.contains('show'), null, { timeout: 8000 });
    await page.waitForFunction(() => document.getElementById('connText').textContent.includes('已连接'), null, { timeout: 8000 });
    check('登录成功（CSRF/Cookie 链路通）', true);

    await page.click('#btnAbout');
    await page.waitForSelector('#aboutMask.show', { timeout: 8000 });
    await page.waitForFunction(() => document.getElementById('aboutVersion').textContent === 'v1.0.0', null, { timeout: 8000 });
    const about = await page.textContent('#aboutMask');
    check('关于弹窗内容', about.includes('SQL Studio') && about.includes('v1.0.0')
      && about.includes('Windows 桌面端') && about.includes('MIT License')
      && !about.includes('项目定位') && !about.includes('隐私') && !about.includes('GitHub 仓库'), about);
    await page.click('#aboutClose');
    await page.waitForSelector('#aboutMask.show', { state: 'detached', timeout: 8000 }).catch(() => {});
    check('关于弹窗关闭', !(await page.locator('#aboutMask').evaluate(element => element.classList.contains('show'))));

    // 环境管理弹窗布局
    await page.click('#btnEnvMgr');
    await page.waitForSelector('.env-manager-modal .env-row-actions', { timeout: 8000 });
    const envModal = await page.locator('.env-manager-modal').evaluate(element => ({
      width: element.getBoundingClientRect().width,
      actionWrap: getComputedStyle(element.querySelector('.env-row-actions')).whiteSpace,
    }));
    check('环境管理弹窗宽度与操作列布局', envModal.width >= 700 && envModal.actionWrap === 'nowrap', JSON.stringify(envModal));
    await page.click('#envMgrCancel');

    // 树：实例 → 库 → 表
    await page.waitForFunction(() => document.querySelector('#tree').textContent.includes('mock-inst'), null, { timeout: 8000 });
    check('实例列表加载', true);
    await page.click('#tree .tnode:has-text("mock-inst")');
    await page.waitForSelector('#tree .tnode:has-text("demo_db")', { timeout: 8000 });
    check('数据库懒加载', true);
    await page.click('#tree .tnode:has-text("demo_db")');
    await page.waitForSelector('#tree .tnode[data-table]', { timeout: 8000 });
    check('表列表懒加载', true);

    // 打开表 → 数据网格
    await page.click('#tree .tnode[data-table] > span:nth-child(3)');
    await page.waitForSelector('#tabbody table.grid', { timeout: 8000 });
    const gridText = await page.textContent('#tabbody');
    check('表数据查询与网格渲染', gridText.includes('张三') && gridText.includes('李四'), '');

    // 结构视图
    await page.click('#tabbody [data-act="subview"][data-v="struct"]');
    await page.waitForSelector('#tabbody .structwrap', { timeout: 8000 });
    const st = await page.textContent('#tabbody');
    check('结构视图（DDL 前端解析）', st.includes('用户表') && st.includes('InnoDB') && st.includes('idx_name'), '');
    const defaults = await page.locator('#tabbody table.meta').first().locator('tbody tr').evaluateAll(rows =>
      rows.map(row => row.cells[5] ? row.cells[5].textContent.trim() : ''));
    check('MySQL 默认值解析', defaults.includes('NULL') && defaults.includes("'active'"), defaults.join(', '));

    // DDL 视图
    await page.click('#tabbody [data-act="subview"][data-v="ddl"]');
    await page.waitForSelector('#tabbody .codebox', { timeout: 8000 });
    const ddlText = await page.textContent('#tabbody .codebox');
    check('DDL 视图', ddlText.includes('CREATE TABLE') && !ddlText.includes('tk-id'), ddlText);

    // 控制台：多 SQL 编辑，选中时只执行选中内容
    await openNewConsole(page);
    await page.waitForSelector('#edTa', { timeout: 8000 });
    await page.fill('#edTa', MULTI_SQL);
    await page.click('[data-act="toggle-console-menu"]');
    await page.click('#consoleMenu [data-act="rename-console"]');
    await page.fill('#renameConsoleInput', '业务查询控制台');
    await page.click('#renameConsoleSubmit');
    check('控制台重命名更新标签', (await page.locator('#tabbar .tab.active').textContent()).includes('业务查询控制台'));
    await page.locator('#edTa').evaluate((element, selectedSql) => {
      const start = element.value.indexOf(selectedSql);
      element.focus();
      element.setSelectionRange(start, start + selectedSql.length);
    }, SELECTED_SQL);
    const editorDragPrevented = await page.locator('#edTa').evaluate(element => {
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    check('控制台禁止拖动选中文本触发浏览器搜索', editorDragPrevented);
    await page.click('[data-act="run-console"]');
    const selectionDuringExecution = await page.locator('#edTa').evaluate(element => ({
      focused: document.activeElement === element,
      sql: element.value.slice(element.selectionStart, element.selectionEnd),
    }));
    check('控制台执行期间保留 SQL 选区高亮', selectionDuringExecution.focused
      && selectionDuringExecution.sql === SELECTED_SQL, JSON.stringify(selectionDuringExecution));
    await page.waitForSelector('#conResults table.grid', { timeout: 8000 });
    const con = await page.textContent('#conResults');
    check('控制台选中 SQL 执行', con.includes('张三') && con.includes('已执行选中内容'), '');
    const selectedStatusSql = (await page.textContent('#sbSql')).trim();
    check('状态栏回显实际执行的选中 SQL', selectedStatusSql === SELECTED_SQL.replace(/;$/, ''), selectedStatusSql);

    // 新建第二个控制台后，通过“所有”菜单切回第一个，确认各控制台 SQL 独立保留
    await sleep(500);
    await openNewConsole(page);
    check('新建控制台后保留原控制台标签', await page.locator('#tabbar .tab').count() >= 2);
    await page.fill('#edTa', 'SELECT * FROM second_console;');
    await sleep(500);
    const consoleCount = await page.locator('#tabbar .tab').count();
    await page.click('#tabbar .tab.active [data-act="close-tab"]');
    check('关闭控制台只关闭标签', await page.locator('#tabbar .tab').count() === consoleCount - 1);
    await openConsoleFromAll(page, 1);
    check('关闭控制台可从所有列表恢复 SQL', await page.inputValue('#edTa') === 'SELECT * FROM second_console;');
    await page.click('[data-act="toggle-console-menu"]');
    await page.click('#consoleMenu [data-act="show-all-consoles"]');
    await page.locator('#consoleAllMenu [data-act="delete-console"]').nth(1).click();
    const remainingConsoleCount = await page.locator('#tabbar .tab').count();
    check('控制台删除图标永久移除记录', remainingConsoleCount === consoleCount - 1);
    await page.click('[data-act="toggle-console-menu"]');
    await page.click('#consoleMenu [data-act="open-default-console"]');
    check('默认查询控制台不会重复创建', await page.locator('#tabbar .tab').count() === remainingConsoleCount);
    await openConsoleFromAll(page, 0);
    check('所有控制台菜单恢复原 SQL', await page.inputValue('#edTa') === MULTI_SQL);
    await page.click('[data-act="run-console"]');
    await page.waitForSelector('#conResults .res-tabs .res-tab:nth-child(2)', { timeout: 8000 });
    const tabCount = await page.locator('#conResults .res-tabs .res-tab').count();
    check('多条 SQL 拆分后生成多个结果 tab', tabCount === 2, 'tab 数=' + tabCount);
    // 执行完默认激活最后一个 tab（结果 2 = t_user）
    check('默认激活最后一条结果', (await page.textContent('#sbSql')).trim() === 'SELECT * FROM t_user');
    // 切换到结果 1（SELECT 1）→ 仅返回单值 1
    await page.click('#conResults .res-tabs .res-tab:nth-child(1)');
    await page.waitForFunction(() => document.querySelector('#conResults table.grid') && document.querySelector('#conResults table.grid').textContent.includes('1'), null, { timeout: 8000 });
    const res1 = await page.textContent('#conResults');
    check('切换结果 1 显示 SELECT 1 的数据', res1.includes('1') && (await page.textContent('#sbSql')).trim() === 'SELECT 1', '');
    // 切换回结果 2 → t_user 数据
    await page.click('#conResults .res-tabs .res-tab:nth-child(2)');
    await page.waitForFunction(() => document.querySelector('#conResults table.grid') && document.querySelector('#conResults table.grid').textContent.includes('张三'), null, { timeout: 8000 });
    check('切换结果 2 显示 t_user 数据', (await page.textContent('#conResults')).includes('张三'), '');

    // 某条失败也继续执行其余条：第 1 条成功、第 2 条失败、第 3 条成功
    await sleep(500);
    await openNewConsole(page);
    await page.fill('#edTa', MIXED_SQL);
    await page.click('[data-act="run-console"]');
    await page.waitForSelector('#conResults .res-tabs .res-tab:nth-child(3)', { timeout: 8000 });
    const mixedCount = await page.locator('#conResults .res-tabs .res-tab').count();
    check('失败继续：三条结果全部生成', mixedCount === 3, 'tab 数=' + mixedCount);
    // 第 2 条（失败）tab 含失败状态点
    const failTabOk = await page.locator('#conResults .res-tabs .res-tab:nth-child(2)').evaluate(el =>
      el.querySelector('.rt-dot.bad') !== null);
    check('失败条目标记失败状态点', failTabOk, '');
    await page.click('#conResults .res-tabs .res-tab:nth-child(2)');
    await page.waitForFunction(() => document.querySelector('#conResults') && document.querySelector('#conResults').textContent.includes('执行失败'), null, { timeout: 8000 });
    check('失败 tab 展示错误信息', (await page.textContent('#conResults')).includes('模拟失败'), '');
    // 第 3 条仍成功可切换查看
    await page.click('#conResults .res-tabs .res-tab:nth-child(3)');
    await page.waitForFunction(() => document.querySelector('#conResults table.grid') && document.querySelector('#conResults table.grid').textContent.includes('张三'), null, { timeout: 8000 });
    check('失败后仍继续执行后续成功条目', (await page.textContent('#conResults')).includes('张三'), '');

    // 历史按拆分粒度逐条落盘：最新在前（unshift）
    await sleep(500);
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    check('查询历史写入 KV', !!(store.sqls_history && store.sqls_history[ACTIVE_ENV_ID] && store.sqls_history[ACTIVE_ENV_ID].length));
    // MIXED 三条 → activeEnv[0..2]，选中执行一条 → activeEnv[3]，无选区拆分两条 → activeEnv[4..5]
    const hist = store.sqls_history[ACTIVE_ENV_ID];
    check('历史按拆分粒度逐条记录', hist[0].sql === 'SELECT * FROM t_user' && hist[1].sql === 'SELECT FAIL' && hist[2].sql === 'SELECT 1', JSON.stringify(hist.slice(0, 3).map(h => h.sql)));
    check('历史含失败条目标记', hist[1].ok === false && hist[0].ok === true, '');
    const consoles = store.sqls_console_sessions[ACTIVE_ENV_ID].consoles;
    check('全部打开控制台写入 KV', consoles.length === 2 && consoles.some(item => item.sql === MULTI_SQL)
      && consoles.some(item => item.sql === MIXED_SQL), JSON.stringify(consoles.map(item => item.title)));
    await page.reload();
    await page.waitForSelector('[data-act="toggle-console-menu"]', { timeout: 8000 });
    check('重载后恢复全部控制台标签', await page.locator('#tabbar .tab').count() === 2);
    await openConsoleFromAll(page, 0);
    check('重载后恢复控制台 SQL', await page.inputValue('#edTa') === MULTI_SQL);
    check('凭据标志写入 KV（密码不落盘）', store.sqls_creds && store.sqls_creds[ACTIVE_ENV_ID]
      && store.sqls_creds[ACTIVE_ENV_ID].remember === true && !JSON.stringify(store.sqls_creds).includes('pass123'));

    await testPostgresFlow(page);
  } finally {
    try { await browser.close(); } catch (e) { }
    child.kill();
    restoreStore(storeBackup);
  }

  const fail = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} 项通过`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('E2E 异常:', e.message); process.exit(2); });
