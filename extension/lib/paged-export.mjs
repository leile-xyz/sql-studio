function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(name + ' 必须是非负安全整数');
  }
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(name + ' 必须是正安全整数');
  }
  return value;
}

function copyColumns(columns, label) {
  if (!Array.isArray(columns)) throw new Error(label + ' columns 必须是数组');
  if (columns.some(column => typeof column !== 'string')) {
    throw new Error(label + ' columns 必须只包含字符串');
  }
  return Object.freeze([...columns]);
}

function sameColumns(expected, actual) {
  return expected.length === actual.length
    && expected.every((column, index) => column === actual[index]);
}

function copyPageRows(rows, columnCount, page) {
  if (!Array.isArray(rows)) throw new Error('第 ' + page + ' 页 rows 必须是数组');
  return rows.map((row, index) => {
    if (!Array.isArray(row)) throw new Error('第 ' + page + ' 页第 ' + (index + 1) + ' 行必须是数组');
    if (row.length !== columnCount) {
      throw new Error('第 ' + page + ' 页第 ' + (index + 1) + ' 行列数不一致');
    }
    return Object.freeze([...row]);
  });
}

function initialColumns(options) {
  const provided = Object.prototype.hasOwnProperty.call(options, 'columns');
  return provided ? copyColumns(options.columns, '初始') : null;
}

export async function collectPagedRows(options) {
  if (!options || typeof options !== 'object') throw new Error('分页导出参数不能为空');
  const totalRows = nonNegativeSafeInteger(options.totalRows, 'totalRows');
  const pageSize = positiveSafeInteger(options.pageSize, 'pageSize');
  if (typeof options.fetchPage !== 'function') throw new Error('fetchPage 必须是函数');
  let columns = initialColumns(options);
  const rows = [];
  const pageCount = Math.ceil(totalRows / pageSize);
  for (let page = 1; page <= pageCount; page += 1) {
    const offset = (page - 1) * pageSize;
    const expectedRows = Math.min(pageSize, totalRows - offset);
    const request = Object.freeze({ page, pageSize, offset, expectedRows });
    const result = await options.fetchPage(request);
    if (!result || typeof result !== 'object') throw new Error('第 ' + page + ' 页未返回有效结果');
    const pageColumns = copyColumns(result.columns, '第 ' + page + ' 页');
    if (columns && !sameColumns(columns, pageColumns)) throw new Error('第 ' + page + ' 页列定义不一致');
    if (!columns) columns = pageColumns;
    const pageRows = copyPageRows(result.rows, columns.length, page);
    if (pageRows.length !== expectedRows) {
      throw new Error('第 ' + page + ' 页行数不符：预期 ' + expectedRows + '，实际 ' + pageRows.length);
    }
    rows.push(...pageRows);
  }
  if (rows.length !== totalRows) {
    throw new Error('分页导出总行数不符：预期 ' + totalRows + '，实际 ' + rows.length);
  }
  return Object.freeze({
    columns: columns || Object.freeze([]),
    rows: Object.freeze(rows),
  });
}
