/**
 * dbadmin 表结构响应解析：兼容 MySQL CREATE TABLE 与 PostgreSQL 列元数据。
 */

const NUMERIC_RE = /\b(int|integer|bigint|tinyint|smallint|mediumint|decimal|numeric|real|double(?:\s+precision)?|float|bit|year|serial|bigserial|money)\b/i;
const POSTGRES_COLUMN_NAME = 'column_name';

export function parseTableDescription(data) {
    const response = data && typeof data === 'object' ? data : {};
    const columnList = Array.isArray(response.column_list) ? response.column_list : [];
    if (columnList.includes(POSTGRES_COLUMN_NAME)) return parsePostgresDescription(response);
    const rows = Array.isArray(response.rows) ? response.rows : [];
    const ddl = rows[0] && typeof rows[0][1] === 'string' ? rows[0][1] : '';
    return {
        ddl,
        sourceSql: response.full_sql || '',
        dialect: 'mysql',
        ...parseCreateTable(ddl),
    };
}

function parsePostgresDescription(response) {
    const positions = new Map(response.column_list.map((name, index) => [name, index]));
    const rows = Array.isArray(response.rows) ? response.rows : [];
    const columns = rows.map(row => parsePostgresColumn(row, positions));
    return {
        ddl: '',
        sourceSql: response.full_sql || '',
        dialect: 'postgresql',
        columns,
        indexes: [],
        engine: 'PostgreSQL',
        charset: '',
        autoInc: null,
        comment: '',
    };
}

function parsePostgresColumn(row, positions) {
    const read = name => row[positions.get(name)];
    const type = formatPostgresType(row, positions);
    const defaultValue = read('column_default');
    return {
        name: String(read(POSTGRES_COLUMN_NAME) || ''),
        type,
        nn: String(read('is_nullable') || '').toUpperCase() === 'NO',
        ai: typeof defaultValue === 'string' && /\bnextval\s*\(/i.test(defaultValue),
        pk: false,
        num: NUMERIC_RE.test(type),
        comment: read('description') == null ? '' : String(read('description')),
        default: defaultValue == null ? '' : String(defaultValue),
    };
}

function formatPostgresType(row, positions) {
    const read = name => row[positions.get(name)];
    const type = String(read('data_type') || '');
    const charLength = read('character_maximum_length');
    if (charLength != null && /^(?:character varying|character|varchar|char)$/i.test(type)) {
        return type + '(' + charLength + ')';
    }
    const precision = read('numeric_precision');
    const scale = read('numeric_scale');
    if (precision == null || !/^(?:numeric|decimal)$/i.test(type)) return type;
    return scale == null ? type + '(' + precision + ')' : type + '(' + precision + ',' + scale + ')';
}

function quotedValueEnd(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
        if (source[index] === '\\') {
            index += 2;
            continue;
        }
        if (source[index] !== quote) {
            index += 1;
            continue;
        }
        if (source[index + 1] === quote) {
            index += 2;
            continue;
        }
        return index + 1;
    }
    return source.length;
}

function defaultExpressionStart(source) {
    let index = 0;
    while (index < source.length) {
        if ("'\"`".includes(source[index])) {
            index = quotedValueEnd(source, index);
            continue;
        }
        if (!/[A-Za-z_]/.test(source[index])) {
            index += 1;
            continue;
        }
        const wordStart = index;
        while (/[A-Za-z_]/.test(source[index] || '')) index += 1;
        if (source.slice(wordStart, index).toUpperCase() !== 'DEFAULT') continue;
        while (/\s/.test(source[index] || '')) index += 1;
        return index;
    }
    return -1;
}

function balancedValueEnd(source, start) {
    let depth = 0;
    let index = start;
    while (index < source.length) {
        if ("'\"`".includes(source[index])) {
            index = quotedValueEnd(source, index);
            continue;
        }
        if (source[index] === '(') depth += 1;
        if (source[index] === ')') {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
        index += 1;
    }
    return source.length;
}

function parseMysqlDefault(source) {
    const start = defaultExpressionStart(source);
    if (start < 0 || start >= source.length) return '';
    if (source[start] === '(') return source.slice(start, balancedValueEnd(source, start));
    let quoteStart = start;
    while (/[A-Za-z0-9_]/.test(source[quoteStart] || '')) quoteStart += 1;
    if ("'\"".includes(source[quoteStart])) {
        return source.slice(start, quotedValueEnd(source, quoteStart));
    }
    let end = start;
    while (end < source.length && !/[\s,]/.test(source[end])) end += 1;
    return source.slice(start, end);
}

/** 解析 MySQL CREATE TABLE → { columns, indexes, engine, charset, autoInc, comment } */
export function parseCreateTable(ddl) {
    const result = { columns: [], indexes: [], engine: '', charset: '', autoInc: null, comment: '' };
    if (!ddl) return result;

    const open = ddl.indexOf('(');
    const close = ddl.lastIndexOf(')');
    if (open < 0 || close < 0 || close < open) return result;

    const body = ddl.slice(open + 1, close);
    const tail = ddl.slice(close + 1);
    const mEngine = tail.match(/ENGINE=(\w+)/i);
    const mCharset = tail.match(/(?:DEFAULT\s+)?CHARSET=([\w]+)/i);
    const mAuto = tail.match(/AUTO_INCREMENT=(\d+)/i);
    const mComment = tail.match(/COMMENT='((?:[^'\\]|\\.|'')*)'/i);
    result.engine = mEngine ? mEngine[1] : '';
    result.charset = mCharset ? mCharset[1] : '';
    result.autoInc = mAuto ? Number(mAuto[1]) : null;
    result.comment = mComment ? unquote(mComment[1]) : '';

    const pkCols = new Set();
    const lines = body.split('\n').map(value => value.trim()).filter(Boolean);
    for (let line of lines) {
        line = line.replace(/,$/, '');
        const pk = line.match(/^PRIMARY\s+KEY\s*\(([^)]*)\)/i);
        if (pk) {
            const cols = extractColNames(pk[1]);
            cols.forEach(column => pkCols.add(column));
            result.indexes.push({ name: 'PRIMARY', type: 'BTREE', unique: true, cols });
            continue;
        }
        const uniqueKey = line.match(/^UNIQUE\s+(?:KEY|INDEX)\s+`([^`]+)`\s*\(([^)]*)\)/i);
        if (uniqueKey) {
            result.indexes.push({ name: uniqueKey[1], type: 'BTREE', unique: true, cols: extractColNames(uniqueKey[2]) });
            continue;
        }
        const key = line.match(/^(?:KEY|INDEX)\s+`([^`]+)`\s*\(([^)]*)\)/i);
        if (key) {
            result.indexes.push({ name: key[1], type: 'BTREE', unique: false, cols: extractColNames(key[2]) });
            continue;
        }
        if (/^(CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL|CHECK)\b/i.test(line)) continue;
        const column = line.match(/^`([^`]+)`\s+([a-z]+(?:\s*\([^)]*\))?(?:\s+unsigned)?(?:\s+zerofill)?)/i);
        if (!column) continue;
        const type = column[2].replace(/\s+/g, ' ').trim();
        const comment = line.match(/COMMENT\s+'((?:[^'\\]|\\.|'')*)'/i);
        result.columns.push({
            name: column[1],
            type,
            nn: /\bNOT\s+NULL\b/i.test(line),
            ai: /\bAUTO_INCREMENT\b/i.test(line),
            pk: false,
            num: NUMERIC_RE.test(type),
            comment: comment ? unquote(comment[1]) : '',
            default: parseMysqlDefault(line),
        });
    }
    result.columns.forEach(column => { if (pkCols.has(column.name)) column.pk = true; });
    return result;
}

function extractColNames(source) {
    const names = [];
    const pattern = /`([^`]+)`/g;
    let match;
    while ((match = pattern.exec(source))) names.push(match[1]);
    return names.length
        ? names
        : source.split(',').map(value => value.trim().replace(/`/g, '').replace(/\(.*$/, '')).filter(Boolean);
}

function unquote(source) {
    return source.replace(/''/g, "'").replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}
