export async function saveCsvText(api, name, csv) {
  return api.exportCsv(name, csv);
}
