#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const sourceDir = path.join(root, 'source-data');
const workbookName = 'Data base final RFQ.xlsx';
const workbookPath = path.join(sourceDir, workbookName);
const weekAName = 'Week A Schedule based on Routes.docx';
const weekBName = 'Week B Schedule Based on Routes.docx';
const expectedWeeklyBaseline = 364011.36;
const validPlcs = new Set(['Dallas PLC', 'Whitestown PLC']);
const inspectedSheets = [
  'Data base RFQ',
  'Center Mapping pick up',
  'McKesson Fleet spend FY 26',
  'Rate Table',
  'Invoice Detail FY26'
];
const aliases = {
  'Invoice Detail FY26': ['Invoice Detail FY26', 'Invoice  Detail FY26'],
  'McKesson Fleet spend FY 26': ['McKesson Fleet spend FY 26', 'Mckesson Fleet spend FY 26']
};
const fallback = {
  route: 13,
  status: 11,
  actualPlc: 9,
  centerNumber: 2,
  centerName: 1,
  miles: 29,
  cases: 30,
  liters: 31,
  pallets: 32,
  linehaul: 33,
  fuelPct: 34,
  fuelAmount: 35,
  storage: 36,
  other: 37,
  aq: 42
};

function xmlDecode(value = '') {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function clean(value) {
  return xmlDecode(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function key(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function number(value, digits = 2) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
}

function numeric(value) {
  const text = clean(value).replace(/[,$%]/g, '');
  if (!text || /^#?N\/A$/i.test(text)) return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function zipEntries(filePath) {
  const buffer = readFileSync(filePath);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`ZIP end record not found in ${filePath}`);
  const entries = new Map();
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data) entries.set(name, data.toString('utf8'));
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function attr(tag, name) {
  return xmlDecode(tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '');
}

function columnIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/)?.[0] || 'A';
  return [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function columnName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellAddress(row, index) {
  return `${columnName(index)}${row.excelRowNumber || ''}`;
}

function parseRels(xml = '') {
  const out = {};
  for (const rel of xml.matchAll(/<Relationship\b[^>]*>/g)) out[attr(rel[0], 'Id')] = attr(rel[0], 'Target');
  return out;
}

function sharedStrings(xml = '') {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((si) => [...si[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlDecode(t[1])).join(''));
}

function parseRows(xml = '', shared = []) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = rowMatch[1];
    const cells = [];
    cells.excelRowNumber = Number(attr(rowAttrs, 'r')) || rows.length + 1;
    cells.excelRowHidden = attr(rowAttrs, 'hidden') === '1';
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cellTag = cellMatch[1];
      const body = cellMatch[2];
      const idx = columnIndex(attr(cellTag, 'r'));
      const type = attr(cellTag, 't');
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      const inline = body.match(/<is\b[\s\S]*?<\/is>/)?.[0] || '';
      if (type === 's') cells[idx] = shared[Number(value)] ?? '';
      else if (type === 'inlineStr') cells[idx] = clean(inline);
      else cells[idx] = xmlDecode(value);
    }
    rows.push(cells);
  }
  return rows;
}

function headerInfo(rows) {
  const headerIndex = rows.findIndex((row) => {
    const text = row.map(clean).join(' | ');
    return /Route Name Mckensson|Center Status|Total Cases by week|Sum of Amount Billed Weekly|invoice|route|rate|center/i.test(text) || row.filter((c) => clean(c)).length >= 4;
  });
  if (headerIndex < 0) return { headerIndex: -1, headers: [] };
  return { headerIndex, headers: rows[headerIndex].map(clean) };
}

function objectsFor(rows, sheetName) {
  const { headerIndex, headers } = headerInfo(rows);
  if (headerIndex < 0) return [];
  return rows.slice(headerIndex + 1).map((row) => {
    const obj = { sourceSheet: sheetName, sourceRowNumber: row.excelRowNumber, excelRowHidden: Boolean(row.excelRowHidden), rawRow: row };
    headers.forEach((header, i) => {
      const value = clean(row[i]);
      if (header && value !== '') obj[header] = value;
      const k = key(header);
      if (k && value !== '') obj[k] = value;
    });
    return obj;
  }).filter((row) => Object.keys(row).some((k) => !['sourceSheet', 'sourceRowNumber', 'excelRowHidden', 'rawRow'].includes(k)));
}

function readWorkbook() {
  if (!existsSync(workbookPath)) return { found: false, sheets: [], byName: new Map(), rowsByName: new Map(), headersByName: new Map() };
  const zip = zipEntries(workbookPath);
  const workbook = zip.get('xl/workbook.xml') || '';
  const rels = parseRels(zip.get('xl/_rels/workbook.xml.rels') || '');
  const shared = sharedStrings(zip.get('xl/sharedStrings.xml') || '');
  const sheets = [];
  const byName = new Map();
  const rowsByName = new Map();
  const headersByName = new Map();
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(sheet[0], 'name') || 'Sheet';
    const relId = attr(sheet[0], 'r:id');
    const target = rels[relId] || '';
    const sheetPath = target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`;
    const rows = parseRows(zip.get(sheetPath) || '', shared);
    sheets.push(name);
    rowsByName.set(name, rows);
    headersByName.set(name, headerInfo(rows).headers);
    byName.set(name, objectsFor(rows, name));
  }
  return { found: true, sheets, byName, rowsByName, headersByName };
}

function resolveSheet(workbook, wanted) {
  const candidates = aliases[wanted] || [wanted];
  return candidates.find((name) => workbook.byName.has(name) || workbook.rowsByName.has(name)) || '';
}

function getField(row, patterns, fallbackIndex) {
  for (const [name, value] of Object.entries(row)) {
    if (['sourceSheet', 'sourceRowNumber', 'excelRowHidden', 'rawRow'].includes(name)) continue;
    if (patterns.some((pattern) => pattern.test(name)) && clean(value)) return value;
  }
  if (fallbackIndex !== undefined) return clean(row.rawRow?.[fallbackIndex]);
  return '';
}

function normalizePlc(value) {
  const text = clean(value);
  if (!text || /^#?N\/A$/i.test(text) || /^(closed|unassigned|not assigned)$/i.test(text)) return '';
  return [...validPlcs].find((plc) => plc.toLowerCase() === text.toLowerCase()) || '';
}

function normalizeName(value) {
  const states = 'al ak az ar ca co ct de fl ga hi ia id il in ks ky la ma md me mi mn mo ms mt nc nd ne nh nj nm nv ny oh ok or pa ri sc sd tn tx ut va vt wa wi wv wy dc';
  const statePattern = new RegExp(`\\b(${states.split(' ').join('|')})\\b`, 'g');
  return key(value)
    .replace(/\b0*\d{1,4}\b/g, '')
    .replace(statePattern, '')
    .replace(/\b(csl|plasma|center|centre)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCenterNumber(value) {
  const text = clean(value);
  const matches = [...text.matchAll(/\b0*(\d{2,4})\b/g)].map((m) => String(Number(m[1])));
  return matches.at(-1) || '';
}

function isSummary(row) {
  const text = Object.values(row).filter((v) => typeof v !== 'object').join(' ');
  const centerNumber = getField(row, [/^center number$/, /^center$/, /^center #$/], fallback.centerNumber);
  return /grand total|monthly total|annual total|summary|subtotal/i.test(text) || !centerNumber;
}

function center(row) {
  const route = getField(row, [/^route name mckensson$/, /^route name mckesson$/, /^current route$/], fallback.route);
  const status = getField(row, [/^center status$/, /^status$/], fallback.status);
  const cases = numeric(getField(row, [/total cases by week/, /weekly cases/], fallback.cases));
  const liters = numeric(getField(row, [/total liters by week/, /weekly liters/], fallback.liters));
  const centerNumber = getField(row, [/^center name$/, /^center number$/, /^center$/], fallback.centerNumber);
  const centerName = getField(row, [/^route name$/, /^name$/, /^center name$/], fallback.centerName);
  return {
    sourceRowNumber: row.sourceRowNumber,
    hidden: row.excelRowHidden,
    centerNumber: String(Number(centerNumber) || centerNumber).padStart(3, '0'),
    centerNumberKey: String(Number(centerNumber) || centerNumber),
    centerName,
    centerNameKey: normalizeName(centerName),
    route,
    status,
    actualPlc: normalizePlc(getField(row, [/^actual plc$/, /current plc/, /destination plc/], fallback.actualPlc)),
    miles: numeric(getField(row, [/total miles by week/, /weekly miles/, /^miles$/], fallback.miles)),
    cases,
    liters,
    pallets: numeric(getField(row, [/total pallets by week/, /weekly pallets/, /^pallets$/], fallback.pallets)) || cases / 70,
    linehaul: numeric(getField(row, [/linehaul/], fallback.linehaul)),
    fuelPct: numeric(getField(row, [/fuel.*%/, /fuel surcharge pct/], fallback.fuelPct)),
    fuelAmount: numeric(getField(row, [/fuel.*\$/, /fuel surcharge amount/, /fuel surcharge/], fallback.fuelAmount)),
    storage: numeric(getField(row, [/storage/], fallback.storage)),
    other: numeric(getField(row, [/other/, /accessorial/], fallback.other)),
    aq: numeric(getField(row, [/sum of amount billed weekly/, /amount billed weekly/, /billed weekly/, /total billed/], fallback.aq))
  };
}

function isActive(c) {
  return /^open$/i.test(c.status) && Boolean(clean(c.route)) && !c.hidden;
}

function groupBy(rows, fn) {
  const map = new Map();
  for (const row of rows) {
    const k = clean(fn(row)) || '(missing)';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

function routeSummary(activeCenters) {
  return [...groupBy(activeCenters, (c) => c.route)].map(([route, rows]) => {
    const sum = (field) => rows.reduce((acc, row) => acc + numeric(row[field]), 0);
    const pallets = sum('pallets');
    const miles = sum('miles');
    const cases = sum('cases');
    const aq = sum('aq');
    const plcs = [...groupBy(rows, (r) => r.actualPlc || 'Missing / not assigned').entries()].map(([plc, items]) => `${plc}:${items.length}`).join(', ');
    const utilization = pallets / 24;
    const capacityStatus = pallets < 12 ? 'Underutilized' : pallets <= 21.6 ? 'Normal' : pallets <= 24 ? 'High utilization' : 'Over capacity';
    return {
      route,
      count: rows.length,
      plcs,
      cases,
      liters: sum('liters'),
      pallets,
      utilization,
      capacityStatus,
      miles,
      aq,
      costPerMile: miles ? aq / miles : 0,
      costPerCase: cases ? aq / cases : 0,
      costPerPallet: pallets ? aq / pallets : 0,
      linehaul: sum('linehaul'),
      fuelAmount: sum('fuelAmount'),
      storage: sum('storage'),
      other: sum('other')
    };
  }).sort((a, b) => a.route.localeCompare(b.route));
}

function table(rows, columns, limit = rows.length) {
  const slice = rows.slice(0, limit);
  if (!slice.length) return '  (none)';
  const widths = columns.map((col) => Math.min(42, Math.max(col.label.length, ...slice.map((row) => String(col.value(row)).length))));
  const clip = (text, width) => String(text).length > width ? `${String(text).slice(0, width - 1)}…` : String(text);
  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join(' | ');
  const line = widths.map((w) => '-'.repeat(w)).join('-|-');
  const body = slice.map((row) => columns.map((col, i) => clip(col.value(row), widths[i]).padEnd(widths[i])).join(' | ')).join('\n');
  return `${header}\n${line}\n${body}`;
}

function classifyHeaders(headers, patterns) {
  return headers.filter((h) => patterns.some((pattern) => pattern.test(h))).join(', ') || '(none detected)';
}

function inferGrain(headers, rows) {
  const h = headers.join(' ').toLowerCase();
  if (/invoice|bol|bill of lading/.test(h)) return 'invoice-line-level';
  if (/month|period/.test(h)) return 'monthly';
  if (/week/.test(h)) return 'weekly';
  if (/stop|center/.test(h) && /route/.test(h)) return 'stop-level';
  if (/route/.test(h)) return 'route-level';
  return rows.length ? 'unclear' : 'no rows';
}

function inspectGeneric(workbook, sheetLabel) {
  const sheetName = resolveSheet(workbook, sheetLabel);
  const rows = sheetName ? workbook.byName.get(sheetName) || [] : [];
  const rawRows = sheetName ? workbook.rowsByName.get(sheetName) || [] : [];
  const headers = sheetName ? workbook.headersByName.get(sheetName) || [] : [];
  return { sheetName, rows, rawRows, headers };
}

function sumField(rows, patterns) {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = getField(row, patterns);
    if (value !== '') { total += numeric(value); found = true; }
  }
  return found ? total : null;
}

function routeField(row) {
  return getField(row, [/route name mckensson/, /route name mckesson/, /^route name$/, /^route$/, /lane/]);
}

function dateFromExcel(value) {
  const n = numeric(value);
  if (!n || n < 20000 || n > 80000) return null;
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000);
}

function monthKey(date) {
  return date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` : '';
}

function weekKey(date) {
  if (!date) return '';
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-W${String(Math.floor((date - start) / 604800000) + 1).padStart(2, '0')}`;
}

function routeTotals(rows, knownRoutes) {
  const mapped = rows.map((row) => ({ row, route: routeField(row) })).filter((r) => r.route);
  const groups = groupBy(mapped, (r) => r.route.toUpperCase());
  const out = [...groups.entries()].map(([route, items]) => ({
    route,
    rows: items.length,
    billed: sumField(items.map((i) => i.row), [/^bol total$/i, /amount billed/, /billed amount/, /total route cost/, /total cost/]) || 0,
    fuel: sumField(items.map((i) => i.row), [/fuel.*\$/, /fuel surcharge amount/, /fuel surcharge/]) || 0,
    miles: sumField(items.map((i) => i.row), [/miles per stop/, /miles/]) || 0
  }));
  const known = new Set(knownRoutes.map((r) => r.toUpperCase()));
  const unmapped = [...new Set(out.map((r) => r.route).filter((r) => !known.has(r)))].slice(0, 25);
  return { out, unmapped };
}

function docxRows(fileName) {
  const filePath = path.join(sourceDir, fileName);
  if (!existsSync(filePath)) return { found: false, rows: [], text: '' };
  const xml = zipEntries(filePath).get('word/document.xml') || '';
  const rows = [];
  for (const table of xml.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)) {
    for (const tr of table[0].matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)) {
      const cells = [...tr[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map((cell) => clean(cell[0]));
      if (cells.some(Boolean)) rows.push(cells);
    }
  }
  const paragraphs = [...xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)].map((p) => clean(p[0])).filter(Boolean);
  if (!rows.length) rows.push(...paragraphs.map((paragraph) => [paragraph]));
  const text = clean([...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => xmlDecode(m[1])).join(' '));
  return { found: true, rows, text };
}

function routeNamesInDoc(doc, knownRoutes) {
  const text = doc.text.toUpperCase();
  return knownRoutes.filter((route) => route && text.includes(route.toUpperCase())).sort();
}

function unmatchedDocStops(doc, centers) {
  const knownNumbers = new Set(centers.map((c) => clean(c.centerNumber).replace(/^0+/, '')).filter(Boolean));
  const knownNames = new Set(centers.map((c) => key(c.centerName).replace(/\b\d{1,3}\b/g, '').trim()).filter(Boolean));
  const unmatched = [];
  for (const cells of doc.rows) {
    const text = clean(cells.join(' '));
    const numbers = [...text.matchAll(/\b0*(\d{2,3})\b/g)].map((m) => m[1].replace(/^0+/, ''));
    const hasKnownNumber = numbers.some((n) => knownNumbers.has(n));
    const nameKey = key(text).replace(/\b\d{1,3}\b/g, '').trim();
    const hasKnownName = [...knownNames].some((name) => name && nameKey.includes(name));
    if (text && /\b\d{2,4}\b/.test(text) && !hasKnownNumber && !hasKnownName) unmatched.push(text.slice(0, 160));
    if (unmatched.length >= 25) break;
  }
  return unmatched;
}

function rateTableRawInspection(rawRows) {
  const nonEmptyRows = rawRows.filter((row) => row.some((cell) => clean(cell)));
  const maxColumns = Math.max(0, ...rawRows.map((row) => row.length));
  const numericCells = [];
  const labels = [];
  for (const row of rawRows) {
    row.forEach((cell, index) => {
      const text = clean(cell);
      if (!text) return;
      const n = numeric(text);
      if (Number.isFinite(n) && text.match(/\d/) && !/[A-Za-z]/.test(text.replace(/[,$%.\-]/g, ''))) numericCells.push({ address: cellAddress(row, index), value: n, text });
      if (/[A-Za-z]/.test(text) && /rate|mile|fuel|surcharge|accessorial|storage|trailer|equipment|reefer|48|minimum|pickup|stop/i.test(text)) labels.push({ address: cellAddress(row, index), text });
    });
  }
  const breakpoints = numericCells.filter((c) => c.value >= 0 && c.value <= 5000 && Number.isInteger(c.value)).slice(0, 40);
  const rates = numericCells.filter((c) => c.value > 0 && c.value < 1000 && !Number.isInteger(c.value)).slice(0, 40);
  const findRows = (pattern) => nonEmptyRows.filter((row) => row.some((cell) => pattern.test(clean(cell)))).slice(0, 12)
    .map((row) => `R${row.excelRowNumber}: ${row.slice(0, 12).map((cell, i) => clean(cell) ? `${cellAddress(row, i)}=${clean(cell)}` : '').filter(Boolean).join(' | ')}`);
  return {
    rowCount: rawRows.length,
    nonEmptyCount: nonEmptyRows.length,
    maxColumns,
    firstRows: nonEmptyRows.slice(0, 60).map((row) => `R${row.excelRowNumber}: ${row.slice(0, 12).map((cell, i) => clean(cell) ? `${cellAddress(row, i)}=${clean(cell)}` : '').filter(Boolean).join(' | ')}`),
    labels: labels.slice(0, 30),
    numericSample: numericCells.slice(0, 40),
    breakpoints,
    rates,
    fuelRows: findRows(/fuel|surcharge/i),
    trailerRows: findRows(/48|trailer|equipment|reefer/i),
    accessorialRows: findRows(/accessorial|storage|other|fee|charge|pickup|stop/i)
  };
}

function buildCenterIndexes(activeCenters) {
  const byNumber = new Map();
  const byName = new Map();
  for (const c of activeCenters) {
    if (c.centerNumberKey) byNumber.set(c.centerNumberKey, c);
    if (c.centerNameKey) byName.set(c.centerNameKey, c);
  }
  return { byNumber, byName };
}

function matchFleetRow(row, indexes) {
  const centerName = getField(row, [/^center name$/, /shipper name/, /consignee name/]);
  const num = extractCenterNumber(centerName);
  if (num && indexes.byNumber.has(num)) return { center: indexes.byNumber.get(num), method: 'center-number' };
  const nameKey = normalizeName(centerName);
  if (nameKey && indexes.byName.has(nameKey)) return { center: indexes.byName.get(nameKey), method: 'center-name' };
  const nonCenter = /plc|warehouse|kedplasma|biolife|baxter|versiti|lifestream|inova|opi|rxcrossroads|erlanger/i.test(centerName);
  if (!nonCenter && nameKey.length >= 5) {
    for (const [candidate, center] of indexes.byName.entries()) {
      if (candidate.length >= 5 && nameKey.includes(candidate)) return { center, method: 'center-name-contained' };
    }
  }
  return { center: null, method: 'unmatched', centerName };
}

function aggregateFleetByRoute(fleetRows, activeCenters) {
  const indexes = buildCenterIndexes(activeCenters);
  const unmatched = [];
  const routeMap = new Map();
  let matchedRows = 0;
  for (const row of fleetRows) {
    const match = matchFleetRow(row, indexes);
    if (!match.center) {
      unmatched.push(getField(row, [/^center name$/, /shipper name/, /consignee name/]) || '(blank)');
      continue;
    }
    matchedRows += 1;
    const route = match.center.route;
    if (!routeMap.has(route)) routeMap.set(route, { route, amount: 0, fuel: 0, miles: 0, cases: 0, liters: 0, rows: 0 });
    const out = routeMap.get(route);
    out.amount += numeric(getField(row, [/amount billed/, /billed amount/]));
    out.fuel += numeric(getField(row, [/fuel surcharge/, /fuel.*\$/]));
    out.miles += numeric(getField(row, [/^miles$/]));
    out.cases += numeric(getField(row, [/actual cases/, /^cases$/]));
    out.liters += numeric(getField(row, [/^liters$/]));
    out.rows += 1;
  }
  return {
    totalRows: fleetRows.length,
    matchedRows,
    unmatchedRows: fleetRows.length - matchedRows,
    matchRate: fleetRows.length ? matchedRows / fleetRows.length : 0,
    unmatchedNames: [...new Set(unmatched)].slice(0, 25),
    routes: [...routeMap.values()].sort((a, b) => a.route.localeCompare(b.route))
  };
}

function aggregateInvoiceByRoute(invoiceRows) {
  const routeMap = new Map();
  for (const row of invoiceRows) {
    const route = clean(routeField(row)).toUpperCase();
    if (!route) continue;
    if (!routeMap.has(route)) {
      routeMap.set(route, {
        route,
        rows: 0,
        bols: new Set(),
        linehaul: 0,
        fuel: 0,
        bolTotal: 0,
        cases: 0,
        liters: 0,
        miles: 0,
        rateMiles: 0,
        months: new Set(),
        weeks: new Set()
      });
    }
    const out = routeMap.get(route);
    out.rows += 1;
    const bol = getField(row, [/^bol$/i]);
    if (bol) out.bols.add(bol);
    out.linehaul += numeric(getField(row, [/linehaul amount/, /linehaul/]));
    out.fuel += numeric(getField(row, [/fuel surcharge/]));
    out.bolTotal += numeric(getField(row, [/^bol total$/i]));
    out.cases += numeric(getField(row, [/^cases$/]));
    out.liters += numeric(getField(row, [/^liters$/]));
    out.miles += numeric(getField(row, [/^miles$/]));
    out.rateMiles += numeric(getField(row, [/rate miles/]));
    const date = dateFromExcel(getField(row, [/pickup date/, /invoice date/]));
    const m = monthKey(date);
    const w = weekKey(date);
    if (m) out.months.add(m);
    if (w) out.weeks.add(w);
  }
  return [...routeMap.values()].map((r) => ({
    ...r,
    uniqueBolCount: r.bols.size,
    monthCount: r.months.size,
    weekCount: r.weeks.size,
    avgCostPerMile: r.miles ? r.bolTotal / r.miles : 0,
    avgFuelPctOfTotal: r.bolTotal ? r.fuel / r.bolTotal : 0,
    impliedFuelPct: r.linehaul ? r.fuel / r.linehaul : 0,
    impliedLinehaulRatePerMile: r.rateMiles ? r.linehaul / r.rateMiles : 0,
    impliedTotalRatePerMile: r.rateMiles ? r.bolTotal / r.rateMiles : 0
  })).sort((a, b) => a.route.localeCompare(b.route));
}

function compareInvoiceToAq(routes, invoiceRoutes) {
  const invoiceMap = new Map(invoiceRoutes.map((r) => [r.route, r]));
  return routes.map((route) => {
    const invoice = invoiceMap.get(route.route.toUpperCase());
    const weeklyAvg = invoice?.weekCount ? invoice.bolTotal / invoice.weekCount : 0;
    const monthlyAvg = invoice?.monthCount ? invoice.bolTotal / invoice.monthCount : 0;
    const variance = weeklyAvg ? weeklyAvg - route.aq : 0;
    return {
      route: route.route,
      aq: route.aq,
      rawTotal: invoice?.bolTotal || 0,
      monthlyAvg,
      weeklyAvg,
      basis: invoice?.weekCount ? 'weekly average' : invoice?.monthCount ? 'monthly average' : invoice ? 'raw FY26 total' : 'unknown period',
      variance,
      variancePct: weeklyAvg && route.aq ? Math.abs(variance) / route.aq : null
    };
  });
}

function matchQuality(variancePct) {
  if (variancePct === null || !Number.isFinite(variancePct)) return 'Unknown';
  if (variancePct <= 0.01) return 'Strong';
  if (variancePct <= 0.05) return 'Possible';
  if (variancePct <= 0.10) return 'Weak';
  return 'No match';
}

function printSection(title) {
  console.log(`\n## ${title}`);
}

const workbook = readWorkbook();

printSection('1. Workbook inspection');
console.log(`Workbook found: ${workbook.found ? 'yes' : 'no'} (${workbookName})`);
console.log(`Sheet names found: ${workbook.sheets.join(', ') || '(none)'}`);
for (const sheet of inspectedSheets) {
  const found = resolveSheet(workbook, sheet);
  console.log(`Required sheet "${sheet}": ${found ? `yes (${found})` : 'no'}`);
  console.log(`  Headers: ${(found ? workbook.headersByName.get(found) : [])?.filter(Boolean).join(' | ') || '(none detected)'}`);
}

const dataSheet = resolveSheet(workbook, 'Data base RFQ');
const masterRows = dataSheet ? workbook.byName.get(dataSheet).filter((row) => !isSummary(row)) : [];
const centers = masterRows.map(center);
const activeCenters = centers.filter(isActive);
const hiddenOpenRouted = centers.filter((c) => /^open$/i.test(c.status) && c.route && c.hidden);
const excluded = centers.filter((c) => !isActive(c));
const routes = routeSummary(activeCenters);
const weeklyBaseline = activeCenters.reduce((sum, c) => sum + c.aq, 0);
const allAq = centers.reduce((sum, c) => sum + c.aq, 0);

printSection('2. Baseline reconciliation');
console.log(`Total master rows: ${centers.length}`);
console.log(`Active visible center count: ${activeCenters.length}`);
console.log(`Hidden OPEN routed rows excluded: ${hiddenOpenRouted.length}`);
console.log(`Closed/excluded count: ${excluded.length}`);
console.log(`McKesson route count: ${routes.length}`);
console.log(`Active Column AQ weekly total: ${money(weeklyBaseline)}`);
console.log(`Monthly baseline: ${money(weeklyBaseline * 4)}`);
console.log(`Annual baseline: ${money(weeklyBaseline * 48)}`);
console.log(`All non-summary Column AQ total for diagnostics: ${money(allAq)}`);
if (Math.abs(weeklyBaseline - expectedWeeklyBaseline) > 0.01) {
  console.log(`MISMATCH: expected ${money(expectedWeeklyBaseline)} but active Column AQ total is ${money(weeklyBaseline)}. Stopping before formula analysis.`);
  process.exit(0);
}

const knownRoutes = routes.map((r) => r.route);
const weekA = docxRows(weekAName);
const weekB = docxRows(weekBName);
printSection('3. Word schedule summary');
console.log(`Week A stop count: ${weekA.rows.length}`);
console.log(`Week B stop count: ${weekB.rows.length}`);
console.log(`Route names found in Week A: ${routeNamesInDoc(weekA, knownRoutes).join(', ') || '(none matched)'}`);
console.log(`Route names found in Week B: ${routeNamesInDoc(weekB, knownRoutes).join(', ') || '(none matched)'}`);
console.log(`Unmatched Week A stops (first 25): ${unmatchedDocStops(weekA, centers).join(' || ') || '(none)'}`);
console.log(`Unmatched Week B stops (first 25): ${unmatchedDocStops(weekB, centers).join(' || ') || '(none)'}`);

printSection('4. Center Mapping pick up inspection');
{
  const { headers, rows } = inspectGeneric(workbook, 'Center Mapping pick up');
  console.log(`Headers: ${headers.filter(Boolean).join(' | ') || '(none detected)'}`);
  console.log(`Total rows: ${rows.length}`);
  console.log(`Possible route columns: ${classifyHeaders(headers, [/route/i, /lane/i])}`);
  console.log(`Possible center columns: ${classifyHeaders(headers, [/center/i, /plasma/i, /name/i])}`);
  console.log(`Possible pickup day columns: ${classifyHeaders(headers, [/pickup/i, /day/i, /mon|tue|wed|thu|fri|sat|sun/i])}`);
  console.log(`Possible Week A / Week B columns: ${classifyHeaders(headers, [/week\s*a/i, /week\s*b/i, /pattern/i])}`);
  console.log(`Possible PLC columns: ${classifyHeaders(headers, [/plc/i, /destination/i])}`);
  console.log('Possible joins to Data base RFQ: center number/name and/or McKesson route name; not enforced by this diagnostic.');
}

printSection('5. McKesson Fleet spend FY 26 inspection');
const fleet = inspectGeneric(workbook, 'McKesson Fleet spend FY 26');
const fleetTotals = routeTotals(fleet.rows, knownRoutes);
const fleetByRoute = aggregateFleetByRoute(fleet.rows, centers.filter((c) => clean(c.route) && clean(c.route) !== '#N/A'));
console.log(`Headers: ${fleet.headers.filter(Boolean).join(' | ') || '(none detected)'}`);
console.log(`Row count: ${fleet.rows.length}`);
console.log(`Guessed row grain: ${inferGrain(fleet.headers, fleet.rows)}`);
console.log(`Fields found - route name: ${classifyHeaders(fleet.headers, [/route/i, /lane/i])}; stop/center: ${classifyHeaders(fleet.headers, [/stop/i, /center/i])}; miles: ${classifyHeaders(fleet.headers, [/mile/i])}; miles per stop: ${classifyHeaders(fleet.headers, [/mile.*stop/i])}`);
console.log(`Fields found - billed amount: ${classifyHeaders(fleet.headers, [/amount billed/i, /billed amount/i, /total/i])}; fuel surcharge amount: ${classifyHeaders(fleet.headers, [/fuel.*\$/i, /fuel surcharge/i])}; fuel surcharge %: ${classifyHeaders(fleet.headers, [/fuel.*%/i])}; linehaul: ${classifyHeaders(fleet.headers, [/linehaul/i])}`);
console.log(`Fields found - storage: ${classifyHeaders(fleet.headers, [/storage/i])}; other/accessorial: ${classifyHeaders(fleet.headers, [/other/i, /accessorial/i])}; date/month/week: ${classifyHeaders(fleet.headers, [/date/i, /month/i, /week/i, /period/i])}`);
console.log(`Direct route totals available: ${fleetTotals.out.length ? 'yes' : 'no (no route field detected)'}`);
console.log(`Center-to-route matched Fleet Spend rows: ${fleetByRoute.matchedRows} / ${fleetByRoute.totalRows} (${pct(fleetByRoute.matchRate)})`);
console.log(`Unmatched Fleet Spend rows: ${fleetByRoute.unmatchedRows}`);
console.log(`Top 25 unmatched Fleet Spend center names: ${fleetByRoute.unmatchedNames.join(', ') || '(none)'}`);
console.log(`Route-level Fleet Spend totals after center match:\n${table(fleetByRoute.routes, [
  { label: 'Route', value: (r) => r.route },
  { label: 'Rows', value: (r) => r.rows },
  { label: 'Amount', value: (r) => money(r.amount) },
  { label: 'Fuel', value: (r) => money(r.fuel) },
  { label: 'Miles', value: (r) => number(r.miles) },
  { label: 'Cases', value: (r) => number(r.cases) },
  { label: 'Liters', value: (r) => number(r.liters) }
])}`);
console.log(`Top 15 routes by Fleet amount billed:\n${table([...fleetByRoute.routes].sort((a, b) => b.amount - a.amount), [{ label: 'Route', value: (r) => r.route }, { label: 'Rows', value: (r) => r.rows }, { label: 'Amount', value: (r) => money(r.amount) }], 15)}`);
console.log(`Top 15 routes by Fleet fuel surcharge:\n${table([...fleetByRoute.routes].sort((a, b) => b.fuel - a.fuel), [{ label: 'Route', value: (r) => r.route }, { label: 'Fuel', value: (r) => money(r.fuel) }], 15)}`);
console.log(`Top 15 routes by Fleet miles:\n${table([...fleetByRoute.routes].sort((a, b) => b.miles - a.miles), [{ label: 'Route', value: (r) => r.route }, { label: 'Miles', value: (r) => number(r.miles) }], 15)}`);

printSection('6. Rate Table inspection');
const rateTable = inspectGeneric(workbook, 'Rate Table');
{
  const { headers, rows } = rateTable;
  const looks = [];
  if (headers.some((h) => /route/i.test(h))) looks.push('route-based');
  if (headers.some((h) => /mile/i.test(h))) looks.push('mileage-based');
  if (headers.some((h) => /stop|pickup/i.test(h))) looks.push('stop-based');
  if (headers.some((h) => /trailer|equipment|reefer|48/i.test(h))) looks.push('trailer-based');
  if (headers.some((h) => /fuel/i.test(h))) looks.push('fuel-based');
  if (headers.some((h) => /accessorial|storage|other|fee/i.test(h))) looks.push('accessorial-based');
  console.log(`Headers: ${headers.filter(Boolean).join(' | ') || '(none detected)'}`);
  console.log(`Row count: ${rows.length}`);
  console.log(`Possible rate categories: ${classifyHeaders(headers, [/rate/i, /category/i, /tier/i, /minimum/i])}`);
  console.log(`Possible route fields: ${classifyHeaders(headers, [/route/i, /lane/i])}`);
  console.log(`Possible mileage fields: ${classifyHeaders(headers, [/mile/i])}`);
  console.log(`Possible stop charge fields: ${classifyHeaders(headers, [/stop/i, /pickup/i])}`);
  console.log(`Possible trailer/equipment fields: ${classifyHeaders(headers, [/trailer/i, /equipment/i, /reefer/i, /48/i])}`);
  console.log(`Possible fuel surcharge fields: ${classifyHeaders(headers, [/fuel/i])}`);
  console.log(`Possible accessorial fields: ${classifyHeaders(headers, [/accessorial/i, /storage/i, /other/i, /fee/i])}`);
  console.log(`Looks like: ${looks.join(', ') || 'unclear'}`);
}

printSection('Rate Table raw grid inspection');
const rateRaw = rateTableRawInspection(rateTable.rawRows);
console.log(`Sheet dimensions: ${rateRaw.rowCount} row(s) x ${rateRaw.maxColumns} column(s); non-empty rows: ${rateRaw.nonEmptyCount}`);
console.log(`First 60 non-empty rows, first 12 columns:\n${rateRaw.firstRows.join('\n') || '(none)'}`);
console.log(`Section labels detected (first 30): ${rateRaw.labels.map((c) => `${c.address}=${c.text}`).join(' | ') || '(none)'}`);
console.log(`Numeric values found (first 40): ${rateRaw.numericSample.map((c) => `${c.address}=${c.text}`).join(' | ') || '(none)'}`);
console.log(`Possible mileage breakpoints (first 40): ${rateRaw.breakpoints.map((c) => `${c.address}=${c.text}`).join(' | ') || '(none)'}`);
console.log(`Possible rate-per-mile values (first 40): ${rateRaw.rates.map((c) => `${c.address}=${c.text}`).join(' | ') || '(none)'}`);
console.log(`Possible fuel surcharge rows:\n${rateRaw.fuelRows.join('\n') || '(none)'}`);
console.log(`Possible 48-foot / trailer / equipment rows:\n${rateRaw.trailerRows.join('\n') || '(none)'}`);
console.log(`Possible accessorial rows:\n${rateRaw.accessorialRows.join('\n') || '(none)'}`);

printSection('7. Invoice Detail FY26 inspection');
const invoice = inspectGeneric(workbook, 'Invoice Detail FY26');
const invoiceRoutes = aggregateInvoiceByRoute(invoice.rows);
const invoiceAqComparison = compareInvoiceToAq(routes, invoiceRoutes);
console.log(`Headers: ${invoice.headers.filter(Boolean).join(' | ') || '(none detected)'}`);
console.log(`Row count: ${invoice.rows.length}`);
console.log(`Guessed row grain: ${inferGrain(invoice.headers, invoice.rows)}`);
console.log(`Total billed amount if available: ${sumField(invoice.rows, [/^bol total$/i, /amount billed/i, /billed amount/i]) === null ? '(not available)' : money(sumField(invoice.rows, [/^bol total$/i, /amount billed/i, /billed amount/i]))}`);
console.log(`Total fuel surcharge if available: ${sumField(invoice.rows, [/fuel.*\$/i, /fuel surcharge/i]) === null ? '(not available)' : money(sumField(invoice.rows, [/fuel.*\$/i, /fuel surcharge/i]))}`);
console.log(`Total linehaul if available: ${sumField(invoice.rows, [/linehaul/i]) === null ? '(not available)' : money(sumField(invoice.rows, [/linehaul/i]))}`);
console.log(`Route fields if available: ${classifyHeaders(invoice.headers, [/route/i, /lane/i])}`);
console.log(`Center fields if available: ${classifyHeaders(invoice.headers, [/center/i, /plasma/i, /stop/i])}`);
console.log(`Date/invoice fields if available: ${classifyHeaders(invoice.headers, [/date/i, /invoice/i, /bol/i, /week/i, /month/i])}`);
console.log(`Can join to Data base RFQ: ${invoice.headers.some((h) => /route|center|plasma|stop/i.test(h)) ? 'possibly, using detected route/center fields' : 'unclear from detected headers'}`);

printSection('Invoice Detail FY26 route aggregation');
console.log(table(invoiceRoutes, [
  { label: 'Route', value: (r) => r.route },
  { label: 'Rows', value: (r) => r.rows },
  { label: 'BOLs', value: (r) => r.uniqueBolCount },
  { label: 'Linehaul', value: (r) => money(r.linehaul) },
  { label: 'Fuel', value: (r) => money(r.fuel) },
  { label: 'BOL Total', value: (r) => money(r.bolTotal) },
  { label: 'Cases', value: (r) => number(r.cases) },
  { label: 'Liters', value: (r) => number(r.liters) },
  { label: 'Miles', value: (r) => number(r.miles) },
  { label: 'Rate Miles', value: (r) => number(r.rateMiles) },
  { label: 'Avg $/mi', value: (r) => money(r.avgCostPerMile) },
  { label: 'Fuel % total', value: (r) => pct(r.avgFuelPctOfTotal) },
  { label: 'Fuel/linehaul', value: (r) => pct(r.impliedFuelPct) },
  { label: 'Linehaul/rate mi', value: (r) => money(r.impliedLinehaulRatePerMile) },
  { label: 'Total/rate mi', value: (r) => money(r.impliedTotalRatePerMile) }
]));

printSection('Invoice Detail FY26 vs Data base RFQ AQ comparison');
console.log('Basis note: raw FY26 total, monthly average, and weekly average are not the same period basis as RFQ weekly AQ unless confirmed externally. Variances below are diagnostics only.');
console.log(table(invoiceAqComparison, [
  { label: 'Route', value: (r) => r.route },
  { label: 'AQ/week', value: (r) => money(r.aq) },
  { label: 'Invoice raw total', value: (r) => money(r.rawTotal) },
  { label: 'Invoice monthly avg', value: (r) => money(r.monthlyAvg) },
  { label: 'Invoice weekly avg', value: (r) => money(r.weeklyAvg) },
  { label: 'Basis', value: (r) => r.basis },
  { label: 'Var vs weekly AQ', value: (r) => r.weeklyAvg ? money(r.variance) : 'n/a' },
  { label: 'Var %', value: (r) => r.variancePct === null ? 'n/a' : pct(r.variancePct) }
]));

printSection('8. Route-level summary from Data base RFQ');
console.log(table(routes, [
  { label: 'Route', value: (r) => r.route },
  { label: 'Ctrs', value: (r) => r.count },
  { label: 'PLC mix', value: (r) => r.plcs },
  { label: 'Cases', value: (r) => number(r.cases) },
  { label: 'Liters', value: (r) => number(r.liters) },
  { label: 'Pallets', value: (r) => number(r.pallets) },
  { label: 'Util', value: (r) => `${(r.utilization * 100).toFixed(1)}%` },
  { label: 'Capacity', value: (r) => r.capacityStatus },
  { label: 'Miles', value: (r) => number(r.miles) },
  { label: 'AQ/week', value: (r) => money(r.aq) },
  { label: '$/mile', value: (r) => r.miles ? money(r.costPerMile) : 'n/a' },
  { label: '$/case', value: (r) => r.cases ? money(r.costPerCase) : 'n/a' },
  { label: '$/pallet', value: (r) => r.pallets ? money(r.costPerPallet) : 'n/a' }
]));

printSection('9. Candidate charge-model diagnostics');
console.log('A. RFQ summary reconciliation only, not pricing formula proof');
const rfqRecon = routes.map((r) => {
  const estimated = r.linehaul + r.fuelAmount + r.storage + r.other;
  const variance = estimated - r.aq;
  const variancePct = r.aq ? Math.abs(variance) / r.aq : null;
  return { route: r.route, estimated, aq: r.aq, variance, variancePct, quality: matchQuality(variancePct) };
});
console.log(table(rfqRecon, [
  { label: 'Route', value: (r) => r.route },
  { label: 'Linehaul+fuel+accessorials', value: (r) => money(r.estimated) },
  { label: 'AQ', value: (r) => money(r.aq) },
  { label: 'Var', value: (r) => money(r.variance) },
  { label: 'Var %', value: (r) => pct(r.variancePct) },
  { label: 'Quality', value: (r) => r.quality }
]));
console.log('B. Raw invoice / rate table diagnostics');
const invoiceDiagnosticRows = invoiceRoutes.map((r) => ({
  route: r.route,
  linehaulPerRateMile: r.impliedLinehaulRatePerMile,
  fuelPct: r.impliedFuelPct,
  totalPerRateMile: r.impliedTotalRatePerMile,
  bolPerCase: r.cases ? r.bolTotal / r.cases : 0,
  bolPerPallet: r.cases ? r.bolTotal / (r.cases / 70) : 0
}));
console.log(`Invoice route raw rate diagnostics:\n${table(invoiceDiagnosticRows, [
  { label: 'Route', value: (r) => r.route },
  { label: 'Linehaul/rate mi', value: (r) => money(r.linehaulPerRateMile) },
  { label: 'Fuel/linehaul', value: (r) => pct(r.fuelPct) },
  { label: 'BOL/rate mi', value: (r) => money(r.totalPerRateMile) },
  { label: 'BOL/case', value: (r) => money(r.bolPerCase) },
  { label: 'BOL/pallet', value: (r) => money(r.bolPerPallet) }
])}`);
const fleetRateRows = fleetByRoute.routes.map((r) => ({
  route: r.route,
  amountPerMile: r.miles ? r.amount / r.miles : 0,
  amountPerCase: r.cases ? r.amount / r.cases : 0,
  amountPerPallet: r.cases ? r.amount / (r.cases / 70) : 0,
  fuelPct: r.amount ? r.fuel / r.amount : 0
}));
console.log(`Fleet Spend route raw rate diagnostics after center-route join:\n${table(fleetRateRows, [
  { label: 'Route', value: (r) => r.route },
  { label: 'Amount/mile', value: (r) => money(r.amountPerMile) },
  { label: 'Amount/case', value: (r) => money(r.amountPerCase) },
  { label: 'Amount/pallet', value: (r) => money(r.amountPerPallet) },
  { label: 'Fuel/amount', value: (r) => pct(r.fuelPct) }
])}`);
console.log(`Rate Table raw numeric candidates: breakpoints=${rateRaw.breakpoints.slice(0, 20).map((c) => `${c.address}:${c.text}`).join(', ') || '(none)'}; rates=${rateRaw.rates.slice(0, 20).map((c) => `${c.address}:${c.text}`).join(', ') || '(none)'}`);
console.log(`Invoice weekly-average vs AQ strongest numeric reconciliations:\n${table([...invoiceAqComparison].filter((r) => r.variancePct !== null).sort((a, b) => a.variancePct - b.variancePct), [
  { label: 'Route', value: (r) => r.route },
  { label: 'AQ/week', value: (r) => money(r.aq) },
  { label: 'Invoice weekly avg', value: (r) => money(r.weeklyAvg) },
  { label: 'Var %', value: (r) => pct(r.variancePct) },
  { label: 'Quality', value: (r) => matchQuality(r.variancePct) }
], 10)}`);
console.log('Strong match means numeric reconciliation only. It does not confirm McKesson’s pricing formula.');

printSection('10. Recommended McKesson validation questions');
[
  'Is the route billed as a fixed weekly route rate, mileage rate, or hybrid?',
  'Is fuel surcharge applied to linehaul only or total route amount?',
  'Are stops billed separately?',
  'Are all pickups priced as 48-foot trailer moves?',
  'Are storage/accessorial charges included in Column AQ?',
  'Are relay routes priced differently?',
  'Are hidden RFQ rows intentionally excluded from active baseline?'
].forEach((q) => console.log(`- ${q}`));
