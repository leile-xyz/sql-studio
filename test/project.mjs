import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'target']);
const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.rs', '.toml', '.xml', '.yml', '.yaml',
]);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.rs']);
const MAX_SOURCE_LINES = 1000;

const absolutePath = relativePath => path.join(REPO_ROOT, relativePath);
const readUtf8 = relativePath => readFile(absolutePath(relativePath), 'utf8');

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function testRequiredProjectFiles() {
  const required = [
    'LICENSE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
    'SECURITY.md', 'PRIVACY.md', '.editorconfig', '.gitattributes',
    '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/workflows/ci.yml',
  ];
  for (const relativePath of required) {
    const info = await stat(absolutePath(relativePath));
    assert.ok(info.isFile(), relativePath + ' must be a file');
  }
}

async function testCiRunsRustTests() {
  const workflow = await readUtf8('.github/workflows/ci.yml');
  assert.ok(
    workflow.includes('cargo test --locked --manifest-path src-tauri/Cargo.toml'),
    'CI must run the locked Rust test suite',
  );
}

async function testVersionAndLicenseMetadata() {
  const packageJson = JSON.parse(await readUtf8('package.json'));
  const packageLock = JSON.parse(await readUtf8('package-lock.json'));
  const tauriConfig = JSON.parse(await readUtf8('src-tauri/tauri.conf.json'));
  const cargoToml = await readUtf8('src-tauri/Cargo.toml');
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLicense = cargoToml.match(/^license\s*=\s*"([^"]+)"/m)?.[1];
  const cargoRepository = cargoToml.match(/^repository\s*=\s*"([^"]+)"/m)?.[1];
  const versions = [packageJson.version, packageLock.version, tauriConfig.version, cargoVersion];
  assert.equal(new Set(versions).size, 1, 'package, Tauri and Cargo versions must match');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(cargoLicense, 'MIT');
  assert.equal(packageJson.homepage, 'https://github.com/leile-xyz/sql-studio');
  assert.equal(cargoRepository, packageJson.homepage);
}

async function testAboutDialogMetadata() {
  const relativePath = 'src/index.html';
  const html = await readUtf8(relativePath);
  for (const id of ['btnAbout', 'aboutMask', 'aboutTitle', 'aboutVersion', 'aboutClose', 'updateMask', 'updateTitle', 'updateVersion', 'updateClose']) {
    assert.ok(html.includes(`id="${id}"`), relativePath + ' missing ' + id);
  }
  assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'));
  assert.ok(html.includes('Windows 桌面端 · Tauri 2'), relativePath + ' missing client label');
  assert.ok(html.includes('<span class="k">作者</span><span class="v">fanzhibiao</span>'), relativePath + ' missing author');
  assert.ok(html.includes('MIT License'), relativePath + ' missing license');
  assert.ok(!html.includes('项目定位'), relativePath + ' includes removed project positioning');
  assert.ok(!html.includes('<span class="k">隐私</span>'), relativePath + ' includes removed privacy entry');
  assert.ok(!html.includes('GitHub 仓库'), relativePath + ' includes removed repository entry');
  assert.ok(html.includes('定时计划') && html.includes('消息中心'), relativePath + ' missing update log content');
}

async function testAppEntrypointStructure() {
  const relativePath = 'src/app.js';
  const source = await readUtf8(relativePath);
  assert.ok(
    source.includes("renderConsole(tab, $('tabbody'));\n}\nfunction scheduleConsoleSession(tab)"),
    relativePath + ' missing beautify closing brace',
  );
  assert.ok(source.trimEnd().endsWith('init();'), relativePath + ' missing init call');
}

async function testTreeConsoleContextIsolation() {
  const source = await readUtf8('src/app.js');
  const events = await readUtf8('src/lib/app-events.mjs');
  const html = await readUtf8('src/index.html');
  const toggleStart = source.indexOf('async function toggleNode');
  const toggleEnd = source.indexOf('async function loadDbs', toggleStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart, 'resource tree toggle implementation is missing');
  assert.ok(source.includes('async function syncTreeToConsole'), 'console-to-tree synchronization is missing');
  assert.ok(!source.includes('function syncConsoleToTree'), 'tree browsing must not overwrite console context');
  assert.ok(!source.slice(toggleStart, toggleEnd).includes('syncConsoleToTree'));
  assert.ok(source.includes('function openTreeNodeInConsole'), 'tree console action is missing');
  assert.ok(events.includes("'tree-open-console'"));
  assert.ok(events.includes("event.target.closest('#tree .tnode[data-uid]')"));
  assert.ok(html.includes('id="treeContextMenu"'));
}

async function testDesktopLightweightMode() {
  const cargoToml = await readUtf8('src-tauri/Cargo.toml');
  const tauriConfig = JSON.parse(await readUtf8('src-tauri/tauri.conf.json'));
  const e2eConfig = JSON.parse(await readUtf8('test/tauri.e2e.conf.json'));
  const mainSource = await readUtf8('src-tauri/src/main.rs');
  const backgroundSource = await readUtf8('src-tauri/src/background.rs');
  const lifecycleSource = await readUtf8('src-tauri/src/lifecycle.rs');
  const frontendLifecycle = await readUtf8('src/lib/native-lifecycle.mjs');
  const mainWindow = tauriConfig.app.windows.find(window => window.label === 'main');
  const e2eMainWindow = e2eConfig.app.windows.find(window => window.label === 'main');
  assert.match(cargoToml, /tauri\s*=\s*\{[^\n]*"tray-icon"/);
  assert.equal(mainWindow?.create, false, 'main WebviewWindow must be deferred');
  assert.equal(e2eMainWindow?.create, false, 'E2E main WebviewWindow must be deferred');
  assert.ok(mainSource.includes('background::setup_tray(app)?;'));
  assert.ok(mainSource.includes('LifecycleState::from_store(&data)'));
  assert.ok(mainSource.includes('lifecycle::create_main_window(app.handle())?;'));
  assert.ok(mainSource.includes('api.prevent_close();'));
  assert.ok(mainSource.includes('lifecycle::request_close_main_window(window.app_handle())'));
  assert.ok(mainSource.includes('tauri::RunEvent::ExitRequested'));
  assert.ok(mainSource.includes('api.prevent_exit();'));
  assert.ok(!mainSource.includes('hide_main_window'));
  assert.ok(lifecycleSource.includes('WebviewWindowBuilder::from_config(app, config)?.build()?'));
  assert.ok(lifecycleSource.includes('app.save_window_state(StateFlags::all())'));
  assert.ok(lifecycleSource.includes('window.destroy()?;'));
  assert.ok(lifecycleSource.includes('PREPARE_CLOSE_EVENT'));
  assert.ok(lifecycleSource.includes('pub async fn bootstrap_state'));
  assert.ok(lifecycleSource.includes('pub async fn save_ui_snapshot'));
  assert.ok(lifecycleSource.includes('pub async fn window_close_ready'));
  assert.ok(lifecycleSource.includes('CLOSE_DESTROY_FAILED_EVENT'));
  assert.ok(lifecycleSource.includes('persist_mode(&kv, previous).await'));
  assert.ok(frontendLifecycle.includes('CLOSE_DESTROY_FAILED_EVENT'));
  assert.ok(backgroundSource.includes('TrayIconBuilder::with_id(TRAY_ICON_ID)'));
  assert.ok(backgroundSource.includes('.show_menu_on_left_click(false)'));
  assert.ok(backgroundSource.includes('LIGHTWEIGHT_MENU_ID'));
  assert.ok(backgroundSource.includes('"进入轻量模式"'));
  assert.ok(backgroundSource.includes('lifecycle::show_or_create_main_window(&handle)'));
  assert.ok(backgroundSource.includes('restore_main_window(tray.app_handle())'));
  assert.ok(backgroundSource.includes('lifecycle::set_mode_from_handle(&handle, true)'));
  assert.ok(!backgroundSource.includes('CheckMenuItem'));
  assert.ok(!backgroundSource.includes('SETTINGS_MENU_ID'));
  assert.ok(!backgroundSource.includes('STATUS_MENU_ID'));
  assert.ok(!backgroundSource.includes('set_checked'));
  assert.ok(backgroundSource.includes('handle.exit(0)'));
  assert.ok(frontendLifecycle.includes("invoke('bootstrap_state')"));
  assert.ok(frontendLifecycle.includes("invoke('save_ui_snapshot'"));
  assert.ok(frontendLifecycle.includes("invoke('window_close_ready')"));
}

async function testScheduleStructure() {
  const main = await readUtf8('src-tauri/src/main.rs');
  const scheduleUi = await readUtf8('src/lib/workflow-schedule.mjs');
  const previewStart = scheduleUi.indexOf('function queueSchedulePreview');
  const previewEnd = scheduleUi.indexOf('async function saveSchedule');
  assert.ok(main.includes('workflow_schedule_preview'), 'schedule preview command must be registered');
  assert.ok(scheduleUi.includes("preview: input => invoke('workflow_schedule_preview'"));
  assert.ok(previewStart >= 0 && previewEnd > previewStart, 'schedule preview implementation is missing');
  assert.ok(!scheduleUi.slice(previewStart, previewEnd).includes('onChanged'), 'preview must not refresh workflow list');
  assert.ok(
    scheduleUi.includes('setScheduleFields(context, context.state.schedule);\n    context.get(\'workflowScheduleError\')'),
    'schedule toggle failure must restore persisted fields',
  );
}

async function testMcpStructure() {
  const mcp = await readUtf8('src-tauri/src/mcp.rs');
  const tools = await readUtf8('src-tauri/src/mcp_tools.rs');
  const main = await readUtf8('src-tauri/src/main.rs');
  const dialog = await readUtf8('src/lib/mcp-dialog.mjs');
  for (const name of ['list_environments', 'list_instances', 'list_databases', 'list_tables', 'get_table_schema']) {
    assert.ok(tools.includes(`const ${name.toUpperCase()}`) || tools.includes(`"${name}"`), `MCP missing ${name}`);
  }
  assert.ok(mcp.includes('load_or_create_token()'));
  assert.ok(mcp.includes('mcp_reset_token') || main.includes('mcp::reset_token'));
  assert.ok(main.includes('mcp::load_or_create_token()'));
  assert.ok(dialog.includes('mcpResetToken'));
}

async function testConsoleLauncherStructure() {
  const html = await readUtf8('src/index.html');
  assert.ok(html.includes('id="consoleMenu"'));
  assert.ok(html.includes('id="consoleAllMenu"'));
  assert.ok(html.includes('id="renameConsoleMask"'));
  assert.ok(html.includes('id="renameConsoleInput"'));
  assert.ok(html.includes('id="renameConsoleSubmit"'));
  assert.ok(html.includes('id="btnSidebarCollapse"'));
  assert.ok(html.includes('id="btnSidebarExpand"'));

  const css = await readUtf8('src/app.css');
  assert.ok(css.includes('.console-launcher-wrap'));
  assert.ok(css.includes('.tabs-scroll'));
  assert.ok(css.includes('#main.sidebar-collapsed #sidebar'));
  assert.ok(css.includes('#main.sidebar-collapsed #sidebarRail'));
}

async function testPluginModuleStructure() {
  const html = await readUtf8('src/index.html');
  for (const id of ['btnPlugins', 'pluginMask', 'pluginList', 'dingtalkCard', 'pluginBack', 'dingtalkDetail', 'dingtalkStatusBanner', 'dingtalkWebhook', 'dingtalkSecret', 'dingtalkTest']) {
    assert.ok(html.includes(`id="${id}"`), 'plugin UI missing ' + id);
  }
  assert.ok(html.includes('class="plugin-card" id="dingtalkCard"'));
  assert.ok(html.includes('type="password" id="dingtalkWebhook"'));
  assert.ok(html.includes('type="password" id="dingtalkSecret"'));
  const rust = await readUtf8('src-tauri/src/plugins/dingtalk.rs');
  assert.ok(rust.includes('Policy::none()'), 'DingTalk client must reject redirects');
  assert.ok(rust.includes('url.scheme() != "https"'), 'DingTalk webhook must require HTTPS');
  assert.ok(!(await readUtf8('src/lib/store.js')).includes('access_token'));
}

function markdownTargets(source) {
  const targets = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(source))) targets.push(match[1].trim());
  return targets;
}

async function testMarkdownLinks(files) {
  const markdownFiles = files.filter(file => path.extname(file).toLowerCase() === '.md');
  for (const file of markdownFiles) {
    const source = await readFile(file, 'utf8');
    for (const rawTarget of markdownTargets(source)) {
      if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
      const withoutAnchor = rawTarget.split('#')[0].replace(/^<|>$/g, '');
      if (!withoutAnchor) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(withoutAnchor));
      await stat(target).catch(() => assert.fail(path.relative(REPO_ROOT, file) + ' has broken link: ' + rawTarget));
    }
  }
}

async function testEncodingAndSourceSize(files) {
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && path.basename(file) !== 'Cargo.lock') continue;
    const bytes = await readFile(file);
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    assert.equal(hasBom, false, path.relative(REPO_ROOT, file) + ' must not contain UTF-8 BOM');
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const lineCount = bytes.toString('utf8').split(/\r?\n/).length;
    assert.ok(lineCount <= MAX_SOURCE_LINES, path.relative(REPO_ROOT, file) + ' exceeds 1000 lines');
  }
}

const files = await walkFiles(REPO_ROOT);
await testRequiredProjectFiles();
await testCiRunsRustTests();
await testVersionAndLicenseMetadata();
await testAboutDialogMetadata();
await testAppEntrypointStructure();
await testTreeConsoleContextIsolation();
await testDesktopLightweightMode();
await testScheduleStructure();
await testMcpStructure();
await testConsoleLauncherStructure();
await testPluginModuleStructure();
await testMarkdownLinks(files);
await testEncodingAndSourceSize(files);
console.log('PASS  project: community files, version/license metadata, Markdown links, UTF-8 and source size');
