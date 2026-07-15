/**
 * mock Archery 服务 — 供桌面端 e2e 验证。
 * 复现 Django 语义：csrftoken Cookie + X-CSRFToken 校验、sessionid 会话、
 * 未登录返回 HTML 登录页、统一 {status,msg,data} 协议。
 * 用法：node test/mock-archery.js [port=9123]
 */
const http = require('http');
const PORT = +(process.argv[2] || 9123);

const CSRF = 'mockcsrftoken123';
const SESS = 'mocksession456';
const USER = 'tester', PWD = 'pass123';

const DDL = "CREATE TABLE `t_user` (\n  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '主键',\n  `name` varchar(64) NOT NULL COMMENT '姓名',\n  `age` int DEFAULT NULL,\n  `status` varchar(20) NOT NULL DEFAULT 'active' COMMENT '状态',\n  PRIMARY KEY (`id`),\n  KEY `idx_name` (`name`)\n) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COMMENT='用户表'";
const MYSQL_INSTANCE = 'mock-inst';
const POSTGRES_INSTANCE = 'mock-pg';
const POSTGRES_DB = 'dify';
const POSTGRES_TABLE = 'account_integrates';
const POSTGRES_SCHEMAS = Object.freeze(['public', 'audit']);
const MYSQL_TOTAL_ROWS = 2;
const POSTGRES_TOTAL_ROWS = Object.freeze({ public: 1, audit: 1 });
const POSTGRES_COLUMN_LIST = Object.freeze([
  'column_name',
  'data_type',
  'character_maximum_length',
  'numeric_precision',
  'numeric_scale',
  'is_nullable',
  'column_default',
  'description',
]);
const POSTGRES_COLUMNS = Object.freeze({
  public: Object.freeze([
    Object.freeze(['id', 'uuid', null, null, null, 'NO', 'uuid_generate_v4()', '主键']),
    Object.freeze(['provider', 'character varying', 64, null, null, 'YES', null, '供应商']),
  ]),
  audit: Object.freeze([
    Object.freeze(['id', 'uuid', null, null, null, 'NO', 'uuid_generate_v4()', '主键']),
    Object.freeze(['audit_marker', 'text', null, null, null, 'YES', null, '审计标记']),
  ]),
});

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function json(res, obj, extraHeaders) {
  res.writeHead(200, { 'Content-Type': 'application/json', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}
function loginPage(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Set-Cookie': `csrftoken=${CSRF}; Path=/`
  });
  res.end('<!DOCTYPE html><html><body>login page</body></html>');
}

function errorJson(res, message) {
  return json(res, { status: 1, msg: message, data: null });
}

function handleResource(url, res) {
  const instance = url.searchParams.get('instance_name');
  const db = url.searchParams.get('db_name') || '';
  const schema = url.searchParams.get('schema_name') || '';
  const table = url.searchParams.get('tb_name') || '';
  const resourceType = url.searchParams.get('resource_type');
  if (instance === MYSQL_INSTANCE) {
    if (resourceType === 'database') return json(res, { status: 0, msg: 'ok', data: ['demo_db'] });
    if (db !== 'demo_db') return errorJson(res, 'MySQL 数据库参数错误');
    if (resourceType === 'table' && !schema) return json(res, { status: 0, msg: 'ok', data: ['t_user'] });
    if (resourceType === 'column' && !schema && table === 't_user') {
      return json(res, { status: 0, msg: 'ok', data: ['id', 'name', 'age'] });
    }
    return errorJson(res, 'MySQL 资源参数错误');
  }
  if (instance !== POSTGRES_INSTANCE) return errorJson(res, '未知实例');
  if (resourceType === 'database') return json(res, { status: 0, msg: 'ok', data: [POSTGRES_DB] });
  if (db !== POSTGRES_DB) return errorJson(res, 'PostgreSQL 数据库参数错误');
  if (resourceType === 'schema') return json(res, { status: 0, msg: 'ok', data: [...POSTGRES_SCHEMAS] });
  if (!POSTGRES_SCHEMAS.includes(schema)) return errorJson(res, 'PostgreSQL 模式参数错误');
  if (resourceType === 'table') return json(res, { status: 0, msg: 'ok', data: [POSTGRES_TABLE] });
  if (resourceType === 'column' && table === POSTGRES_TABLE) {
    return json(res, { status: 0, msg: 'ok', data: POSTGRES_COLUMNS[schema].map(column => column[0]) });
  }
  return errorJson(res, 'PostgreSQL 资源参数错误');
}

function handleDescribe(form, res) {
  const instance = form.get('instance_name');
  const db = form.get('db_name');
  const schema = form.get('schema_name') || '';
  const table = form.get('tb_name');
  if (instance === MYSQL_INSTANCE && db === 'demo_db' && !schema && table === 't_user') {
    return json(res, { status: 0, msg: 'ok', data: { rows: [['t_user', DDL]] } });
  }
  if (instance !== POSTGRES_INSTANCE || db !== POSTGRES_DB
    || !POSTGRES_SCHEMAS.includes(schema) || table !== POSTGRES_TABLE) {
    return errorJson(res, '表结构参数错误');
  }
  return json(res, {
    status: 0,
    msg: 'ok',
    data: {
      full_sql: `select column metadata for ${schema}.${table}`,
      rows: POSTGRES_COLUMNS[schema],
      column_list: [...POSTGRES_COLUMN_LIST],
      column_type: [],
      error: null,
      affected_rows: POSTGRES_COLUMNS[schema].length,
    },
  });
}

function isCountSql(sql) {
  return /^select\s+count\s*\(\s*\*\s*\)(?:\s+as\s+[a-z_][\w$]*)?\s+from\b/i
    .test(String(sql || '').trim());
}

function countQueryData(sql, total) {
  return {
    column_list: ['total'],
    column_type: ['LONGLONG'],
    rows: [[total]],
    query_time: 0.001,
    affected_rows: 0,
    full_sql: sql,
    is_masked: false,
  };
}

function mysqlQueryData(form) {
  const sql = (form.get('sql_content') || '').trim().replace(/;$/, '');
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
  if (isCountSql(sql)) return countQueryData(form.get('sql_content'), MYSQL_TOTAL_ROWS);
  if (normalized === 'select 1') {
    return { column_list: ['1'], column_type: ['LONGLONG'], rows: [[1]], query_time: 0.001, affected_rows: 0, full_sql: form.get('sql_content'), is_masked: false };
  }
  if (normalized === 'select fail') return { error: '模拟失败：测试某条失败时继续其余条' };
  return {
    column_list: ['id', 'name', 'age'],
    column_type: ['LONGLONG', 'VAR_STRING', 'LONG'],
    rows: [[1, '张三', 28], [2, '李四', 35]],
    query_time: 0.012,
    affected_rows: 0,
    full_sql: form.get('sql_content'),
    is_masked: false,
  };
}

function handleQuery(form, res) {
  const instance = form.get('instance_name');
  if (instance === MYSQL_INSTANCE) {
    if (form.get('db_name') !== 'demo_db' || form.get('schema_name')) return errorJson(res, 'MySQL 查询上下文错误');
    return json(res, { status: 0, msg: 'ok', data: mysqlQueryData(form) });
  }
  const schema = form.get('schema_name') || '';
  const sql = form.get('sql_content') || '';
  if (instance !== POSTGRES_INSTANCE || form.get('db_name') !== POSTGRES_DB || !POSTGRES_SCHEMAS.includes(schema)) {
    return errorJson(res, 'PostgreSQL 查询上下文错误');
  }
  if (sql.includes('`')) return json(res, { status: 0, msg: 'ok', data: { error: 'PostgreSQL 查询禁止反引号' } });
  if (isCountSql(sql)) {
    return json(res, { status: 0, msg: 'ok', data: countQueryData(sql, POSTGRES_TOTAL_ROWS[schema]) });
  }
  const isPublic = schema === 'public';
  return json(res, {
    status: 0,
    msg: 'ok',
    data: {
      column_list: isPublic ? ['id', 'provider'] : ['id', 'audit_marker'],
      column_type: [],
      rows: isPublic ? [['public-id', 'public-provider']] : [['audit-id', 'audit-row']],
      query_time: 0.002,
      affected_rows: 0,
      full_sql: sql,
      is_masked: false,
    },
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ck = cookies(req);
  const authed = ck.sessionid === SESS;
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    const form = new URLSearchParams(body);
    console.log(`${req.method} ${url.pathname}${authed ? ' [authed]' : ''}`);

    if (url.pathname === '/login/') return loginPage(res);

    if (url.pathname === '/authenticate/' && req.method === 'POST') {
      if (req.headers['x-csrftoken'] !== ck.csrftoken || !ck.csrftoken) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('CSRF验证失败');
      }
      if (form.get('username') === USER && form.get('password') === PWD) {
        return json(res, { status: 0, msg: 'ok', data: null },
          { 'Set-Cookie': `sessionid=${SESS}; Path=/; HttpOnly` });
      }
      return json(res, { status: 1, msg: '用户名或密码错误', data: null });
    }

    // 其余接口均要求会话；未登录回 HTML（复现 Archery 重定向到登录页的表现）
    if (!authed) return loginPage(res);

    if (url.pathname === '/group/user_all_instances/') {
      return json(res, {
        status: 0,
        msg: 'ok',
        data: [
          { id: 1, type: 'slave', db_type: 'mysql', instance_name: MYSQL_INSTANCE },
          { id: 2, type: 'slave', db_type: 'pgsql', instance_name: POSTGRES_INSTANCE },
        ],
      });
    }
    if (url.pathname === '/instance/instance_resource/') return handleResource(url, res);
    if (url.pathname === '/instance/describetable/' && req.method === 'POST') {
      return handleDescribe(form, res);
    }
    if (url.pathname === '/query/' && req.method === 'POST') {
      return handleQuery(form, res);
    }
    res.writeHead(404); res.end('not found');
  });
});
server.listen(PORT, () => console.log(`mock Archery listening on :${PORT}`));
