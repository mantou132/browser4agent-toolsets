/**
 * @module Google Sheets Tools
 * @description Read Google Sheets worksheets as CSV
 * @icon 📊
 * @author Browser for AI Agent
 */

/**
 * Read a worksheet as CSV of displayed values, plus the names of all worksheets. Note: in a column mixing numbers and text, cells of the minority type may come back empty
 * @pattern https://docs.google.com/spreadsheets/d/*
 * @param {{ sheet?: string, range?: string }} options
 * @param {string} [options.sheet] - Worksheet name; defaults to the currently open worksheet
 * @param {string} [options.range] - Range in A1 notation, e.g. A1:D20; defaults to the whole worksheet
 */
export async function read_sheet({ sheet, range } = {}) {
  const sheets = [...document.querySelectorAll('.docs-sheet-tab .docs-sheet-tab-name')].map((el) => el.textContent);
  const active = document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name')?.textContent;
  const name = sheet || active;
  if (!name) throw new Error('Could not determine the current worksheet');
  if (!sheets.includes(name)) throw new Error(`Worksheet not found: ${name}. Available: ${sheets.join(', ')}`);

  // /export redirects to googleusercontent.com (blocked by CORS); the gviz endpoint is same-origin.
  const id = location.pathname.split('/')[3];
  const params = new URLSearchParams({ tqx: 'out:csv', sheet: name });
  if (range) params.set('range', range);
  const res = await fetch(`/spreadsheets/d/${id}/gviz/tq?${params}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to load the worksheet: ${res.status}`);
  return { sheets, sheet: name, range, csv: await res.text() };
}
