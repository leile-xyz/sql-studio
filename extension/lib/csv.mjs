const UTF8_BOM = '\uFEFF';

export function buildCsv(columns, rows) {
  const header = columns.map(column => encodeCell(column.name)).join(',');
  const lines = rows.map(row => columns.map((column, index) => encodeCell(row[index])).join(','));
  return UTF8_BOM + [header, ...lines].join('\r\n');
}
function encodeCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
