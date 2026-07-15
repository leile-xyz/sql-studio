import { buildCsv } from './csv.mjs';
import { collectConsoleExport, collectTableExport } from './export-service.mjs';

export function createCsvExportActions(options) {
  async function saveCsv(columns, rows, name) {
    const saved = await options.saveText(name || 'export', buildCsv(columns, rows));
    if (saved) options.toast('已导出 ' + rows.length + ' 行为 CSV', 'ok');
  }
  async function exportTableCsv(tab) {
    if (!tab || !tab.data) { options.toast('无数据可导出', 'err'); return; }
    try {
      const result = await collectTableExport({ api: options.api, origin: options.getOrigin(), tab });
      await saveCsv(result.columns, result.rows, tab.table);
    } catch (error) { options.toast('导出失败：' + error.message, 'err'); }
  }
  async function exportConsoleCsv(tab) {
    const result = tab && tab.results && tab.results[tab.activeResult];
    if (!result || !result.ok) { options.toast('当前结果无可导出数据', 'err'); return; }
    try {
      const exported = await collectConsoleExport({ api: options.api, origin: options.getOrigin(), result });
      await saveCsv(exported.columns, exported.rows, tab.title);
    } catch (error) { options.toast('导出失败：' + error.message, 'err'); }
  }
  return Object.freeze({ exportTableCsv, exportConsoleCsv });
}
