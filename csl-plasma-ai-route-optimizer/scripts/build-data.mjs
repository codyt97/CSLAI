#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const sourceDir = path.join(root, 'source-data');
const outDir = path.join(root, 'lib', 'data');
const dataQuality = [];
const dryRun = process.argv.includes('--dry-run');

const SOURCES = {
  consolidatedWorkbook: 'Data base final RFQ.xlsx',
  masterSheet: 'Data base RFQ',
  weekAStops: 'Week A Schedule based on Routes.docx',
  weekBStops: 'Week B Schedule Based on Routes.docx'
};

const EXPECTED_BASELINE_WEEKLY = 364011.36;
const VALID_PLCS = new Set(['Dallas PLC', 'Whitestown PLC']);
const FALLBACK_COLUMNS = {
  centerNameWithNumber: 1, // B
  centerNumber: 2, // C
  weekAPattern: 14, // O
  weekBPattern: 15, // P
  pickupDaysStart: 16, // Q
  pickupDaysEnd: 22, // W
  weightPerCase: 25, // Z
  weeklyCases: 30, // AE
  weeklyLiters: 31, // AF
  billedWeeklyAmount: 42 // AQ
};

function note(fileName, status, message, extra = {}) {
  dataQuality.push({ fileName, status, message, ...extra });
}

function xmlDecode(value = '') {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function cleanText(value) {
  return xmlDecode(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function readZipEntries(filePath) {
  const buffer = readFileSync(filePath);
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record not found');

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
  return xmlDecode(tag.match(new RegExp(`${name}=\"([^\"]*)\"`))?.[1] || '');
}

function columnIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/)?.[0] || 'A';
  return [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function parseRelationships(xml = '') {
  const rels = {};
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    rels[attr(match[0], 'Id')] = attr(match[0], 'Target');
  }
  return rels;
}

function parseSharedStrings(xml = '') {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((si) => {
    return [...si[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlDecode(t[1])).join('');
  });
}

function parseSheetRows(xml = '', sharedStrings = []) {
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
      const inline = body.match(/<is\b[\s\S]*?<\/is>/)?.[0];
      const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
      if (type === 's') cells[idx] = sharedStrings[Number(value)] ?? '';
      else if (type === 'inlineStr') cells[idx] = cleanText(inline || '');
      else cells[idx] = xmlDecode(value);
    }
    rows.push(cells);
  }
  return rows;
}

function headerKey(value, index) {
  const key = cleanText(value).replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/ ([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase()).replace(/^./, (ch) => ch.toLowerCase());
  return key || `column${index + 1}`;
}

function getHeaderInfo(rows) {
  const headerIndex = rows.findIndex((row) => {
    const text = row.map(cleanText).join(' | ');
    return /Route Name Mckensson|Center Status|Data base RFQ|Total Cases by week|Total Liters by week/i.test(text) || row.filter((cell) => cleanText(cell)).length >= 8;
  });
  if (headerIndex < 0) return { headerIndex: -1, rawHeaders: [], keys: [] };
  const rawHeaders = rows[headerIndex].map(cleanText);
  const keys = rawHeaders.map(headerKey);
  return { headerIndex, rawHeaders, keys };
}

function rowsToObjects(rows) {
  const { headerIndex, rawHeaders, keys } = getHeaderInfo(rows);
  if (headerIndex < 0) return [];
  return rows.slice(headerIndex + 1).map((row, rowOffset) => {
    const obj = {
      sourceRowNumber: row.excelRowNumber || headerIndex + rowOffset + 2,
      excelRowHidden: Boolean(row.excelRowHidden)
    };
    keys.forEach((header, index) => {
      const value = cleanText(row[index]);
      if (value !== '') obj[header] = value;
    });
    rawHeaders.forEach((header, index) => {
      const value = cleanText(row[index]);
      if (header && value !== '') obj[header] = value;
    });
    return obj;
  }).filter((row) => Object.keys(row).some((key) => !['sourceRowNumber', 'excelRowHidden'].includes(key)));
}

function readXlsxWorkbook(fileName) {
  const filePath = path.join(sourceDir, fileName);
  if (!existsSync(filePath)) {
    note(fileName, 'missing', 'Consolidated source workbook is missing.');
    return { found: false, sheets: [], rowsBySheet: new Map(), objectsBySheet: new Map(), headersBySheet: new Map() };
  }

  const zip = readZipEntries(filePath);
  const workbook = zip.get('xl/workbook.xml') || '';
  const rels = parseRelationships(zip.get('xl/_rels/workbook.xml.rels') || '');
  const shared = parseSharedStrings(zip.get('xl/sharedStrings.xml') || '');
  const sheets = [];
  const rowsBySheet = new Map();
  const objectsBySheet = new Map();
  const headersBySheet = new Map();

  for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(sheet[0], 'name') || 'Sheet';
    const relId = attr(sheet[0], 'r:id');
    const target = rels[relId] || '';
    const sheetPath = target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`;
    const rows = parseSheetRows(zip.get(sheetPath) || '', shared);
    const headerInfo = getHeaderInfo(rows);
    const objects = rowsToObjects(rows).map((row) => ({ sourceSheet: name, ...row }));
    sheets.push(name);
    rowsBySheet.set(name, rows);
    objectsBySheet.set(name, objects);
    headersBySheet.set(name, headerInfo.rawHeaders);
  }

  note(fileName, 'source-parsed', `Parsed workbook sheet(s): ${sheets.join(', ')}.`, {
    sourceWorkbook: fileName,
    sourceSheet: SOURCES.masterSheet,
    oldExcelFilesRequired: false,
    wordScheduleDocsRequired: [SOURCES.weekAStops, SOURCES.weekBStops],
    validPLCs: [...VALID_PLCS],
    plcNote: '#N/A and blank PLC values are treated as missing/not assigned, not as a PLC.',
    baselineColumn: 'AQ McKesson billed weekly amount'
  });
  return { found: true, sheets, rowsBySheet, objectsBySheet, headersBySheet };
}

function firstPresent(row, fields) {
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') return row[field];
  }
  return '';
}

function cellValue(rawRow, index) {
  return cleanText(rawRow?.[index] || '');
}

function numericValue(value) {
  const n = Number(String(value ?? '').replace(/[$,%]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCenterNumber(value) {
  const text = cleanText(value);
  if (!text) return '';
  const n = Number(text);
  return Number.isFinite(n) ? String(n).padStart(3, '0') : text.padStart(3, '0');
}

function normalizePlc(value) {
  const text = cleanText(value);
  if (!text || /^#?N\/A$/i.test(text) || /^closed|unassigned|not assigned$/i.test(text)) return '';
  const match = [...VALID_PLCS].find((plc) => plc.toLowerCase() === text.toLowerCase());
  return match || '';
}

function statusValue(row) {
  return cleanText(firstPresent(row, ['centerStatus', 'Center Status', 'status', 'Status']));
}

function isSummaryRow(row, rawRow) {
  const text = Object.values(row).join(' ');
  const centerNumber = firstPresent(row, ['centerNumber', 'Center Number', 'Center #']) || cellValue(rawRow, FALLBACK_COLUMNS.centerNumber);
  return /grand total|monthly total|annual total|summary|subtotal/i.test(text) || !centerNumber;
}

function masterField(row, rawRow, names, fallbackIndex) {
  return firstPresent(row, names) || cellValue(rawRow, fallbackIndex);
}

function masterRows(workbook) {
  const rows = workbook.objectsBySheet.get(SOURCES.masterSheet) || [];
  const rawRows = workbook.rowsBySheet.get(SOURCES.masterSheet) || [];
  const { headerIndex } = getHeaderInfo(rawRows);
  return rows.map((row, index) => ({ row, rawRow: rawRows[headerIndex + index + 1] || [] })).filter(({ row, rawRow }) => !isSummaryRow(row, rawRow));
}

function mappedCenter({ row, rawRow }) {
  const centerNumber = normalizeCenterNumber(masterField(row, rawRow, ['centerNumber', 'Center Number', 'assignedCenterNumber', 'Assigned Center Number', 'number'], FALLBACK_COLUMNS.centerNumber));
  const centerNameWithNumber = masterField(row, rawRow, ['centerName', 'Center Name', 'plasmaCenter', 'Plasma Center', 'name', 'NAME'], FALLBACK_COLUMNS.centerNameWithNumber);
  const routeNameMckensson = masterField(row, rawRow, ['routeNameMckensson', 'Route Name Mckensson', 'routeNameMckesson', 'Route Name Mckesson', 'currentRoute', 'Current Route'], undefined);
  const basePLC = normalizePlc(firstPresent(row, ['basePLC', 'Base PLC', 'assignedPLC', 'Assigned PLC', 'plc', 'PLC']));
  const actualPLC = normalizePlc(firstPresent(row, ['actualPLC', 'Actual PLC', 'currentPLC', 'Current PLC', 'destinationPLC', 'Destination PLC'])) || basePLC;
  const weeklyCases = numericValue(masterField(row, rawRow, ['totalCasesByWeek', 'Total Cases by week', 'weeklyCases', 'Weekly Cases'], FALLBACK_COLUMNS.weeklyCases));
  const weeklyLiters = numericValue(masterField(row, rawRow, ['totalLitersByWeek', 'Total Liters by week', 'weeklyLiters', 'Weekly Liters'], FALLBACK_COLUMNS.weeklyLiters));
  const billedWeeklyAmount = numericValue(masterField(row, rawRow, ['totalBilledAmountFromMckesson', 'Total Billed Amount from McKesson', 'mckessonBilledWeeklyAmount', 'amountBilledWeekly', 'Amount Billed Weekly', 'sumOfAmountBilledWeekly', 'Sum of Amount Billed Weekly'], FALLBACK_COLUMNS.billedWeeklyAmount));
  const pickupDays = [];
  for (let col = FALLBACK_COLUMNS.pickupDaysStart; col <= FALLBACK_COLUMNS.pickupDaysEnd; col++) {
    const value = cellValue(rawRow, col);
    if (value) pickupDays.push(value);
  }

  return {
    sourceSheet: row.sourceSheet,
    sourceRowNumber: row.sourceRowNumber,
    excelRowHidden: Boolean(row.excelRowHidden),
    iD: firstPresent(row, ['iD', 'ID', 'id']) || centerNumber,
    nAME: centerNameWithNumber,
    cENTERNUMBER: centerNumber,
    centerName: centerNameWithNumber,
    centerNumber,
    address: firstPresent(row, ['address', 'Address', 'aDDRESS']),
    city: firstPresent(row, ['city', 'City', 'cITY']),
    state: firstPresent(row, ['state', 'State', 'sTATE']),
    zIP: firstPresent(row, ['zIP', 'ZIP', 'Zip', 'zip']),
    basePLC,
    actualPLC,
    routeNameMckensson,
    routeName: routeNameMckensson,
    centerStatus: statusValue(row),
    pickupFrequency: firstPresent(row, ['pickupFrequency', 'Pickup Frequency', 'frequency', 'Frequency']),
    weekAPattern: masterField(row, rawRow, ['weekAPattern', 'Week A Pattern', 'Week A'], FALLBACK_COLUMNS.weekAPattern),
    weekBPattern: masterField(row, rawRow, ['weekBPattern', 'Week B Pattern', 'Week B'], FALLBACK_COLUMNS.weekBPattern),
    pickupDays: pickupDays.join(', '),
    totalCasesByWeek: weeklyCases,
    totalLitersByWeek: weeklyLiters,
    weeklyPallets: weeklyCases / 70,
    weightPerCase: numericValue(masterField(row, rawRow, ['weightPerCase', 'Weight per case'], FALLBACK_COLUMNS.weightPerCase)),
    mckessonBilledWeeklyAmount: billedWeeklyAmount
  };
}

function isOpenScheduled(center) {
  return /^open$/i.test(center.centerStatus) && Boolean(center.routeNameMckensson) && !center.excelRowHidden;
}

function plcCounts(centers, field) {
  const counts = { 'Dallas PLC': 0, 'Whitestown PLC': 0, 'Missing / not assigned': 0 };
  for (const center of centers) {
    const plc = normalizePlc(center[field]);
    counts[plc || 'Missing / not assigned'] += 1;
  }
  return counts;
}

function buildRouteOrigins(centers) {
  const routeOrigins = {};
  const originDetails = {};
  for (const center of centers) {
    const route = cleanText(center.routeNameMckensson).toUpperCase();
    const origin = normalizePlc(center.actualPLC || center.basePLC);
    if (route && origin) routeOrigins[route] = origin;
    if (origin) originDetails[origin] ||= { name: origin };
  }
  return { routeOrigins, originDetails, rows: centers };
}

function buildSpecialCharges(rows) {
  return rows.filter((row) => Object.keys(row).some((key) => /special|storage|other|charge|fee|surcharge/i.test(key)));
}

function readDocx(fileName) {
  const filePath = path.join(sourceDir, fileName);
  if (!existsSync(filePath)) { note(fileName, 'missing', 'Source file is missing.'); return []; }
  try {
    const xml = readZipEntries(filePath).get('word/document.xml') || '';
    const tables = [...xml.matchAll(/<w:tbl[\s\S]*?<\/w:tbl>/g)];
    const out = [];
    for (const table of tables) {
      const rows = [...table[0].matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map((row) => {
        return [...row[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map((cell) => cleanText(cell[0]));
      }).filter((row) => row.some(Boolean));
      out.push(...rowsToObjects(rows));
    }
    if (!out.length) {
      out.push(...[...xml.matchAll(/<w:p[\s\S]*?<\/w:p>/g)].map((p) => ({ text: cleanText(p[0]) })).filter((p) => p.text));
    }
    note(fileName, 'source-parsed', `Parsed ${out.length} row(s).`);
    return out;
  } catch (err) {
    note(fileName, 'parse-error', err.message);
    return [];
  }
}

function buildOutputs() {
  const workbook = readXlsxWorkbook(SOURCES.consolidatedWorkbook);
  const master = masterRows(workbook);
  const centers = master.map(mappedCenter);
  const scheduledCenters = centers.filter(isOpenScheduled);
  const excludedCenters = centers.filter((center) => !isOpenScheduled(center));
  const weekAStops = readDocx(SOURCES.weekAStops);
  const weekBStops = readDocx(SOURCES.weekBStops);
  const allRowsColumnAQTotal = centers.reduce((sum, row) => sum + numericValue(row.mckessonBilledWeeklyAmount), 0);
  const baselineWeekly = scheduledCenters.reduce((sum, row) => sum + numericValue(row.mckessonBilledWeeklyAmount), 0);
  const routeCount = new Set(scheduledCenters.map((center) => cleanText(center.routeNameMckensson)).filter(Boolean)).size;
  const warnings = [];
  const requiredHeaders = ['Route Name Mckensson', 'Center Status'];
  const headers = workbook.headersBySheet.get(SOURCES.masterSheet) || [];
  for (const header of requiredHeaders) {
    if (!headers.some((candidate) => candidate.toLowerCase() === header.toLowerCase())) warnings.push(`Missing expected header: ${header}; fallback mapping may be used.`);
  }
  if (Math.abs(baselineWeekly - EXPECTED_BASELINE_WEEKLY) > 1) warnings.push(`Active visible OPEN routed Column AQ total ${baselineWeekly.toFixed(2)} does not reconcile to expected ${EXPECTED_BASELINE_WEEKLY.toFixed(2)}.`);
  if (warnings.length) note(SOURCES.consolidatedWorkbook, 'warning', 'Parser validation warning(s).', { warnings });

  const billingFY26 = centers.map((center) => ({
    sourceSheet: center.sourceSheet,
    sourceRowNumber: center.sourceRowNumber,
    routeNameMckensson: center.routeNameMckensson,
    centerNumber: center.centerNumber,
    centerName: center.centerName,
    centerStatus: center.centerStatus,
    amountBilledWeekly: center.mckessonBilledWeeklyAmount,
    actualCasesWeekly: center.totalCasesByWeek,
    litersWeekly: center.totalLitersByWeek
  }));
  const casesByCenter = centers.map((center) => ({
    sourceSheet: center.sourceSheet,
    sourceRowNumber: center.sourceRowNumber,
    nAME: center.centerName,
    centerNumber: center.centerNumber,
    cases: center.totalCasesByWeek,
    liters: center.totalLitersByWeek,
    pallets: center.weeklyPallets
  }));

  const stats = {
    sourceWorkbook: SOURCES.consolidatedWorkbook,
    sourceSheet: SOURCES.masterSheet,
    totalMasterRows: master.length,
    openCenterCount: scheduledCenters.length,
    closedExcludedCount: excludedCenters.length,
    mckessonRouteCount: routeCount,
    basePLCCounts: plcCounts(centers, 'basePLC'),
    actualPLCCounts: plcCounts(centers, 'actualPLC'),
    weeklyBaselineBilledAmount: baselineWeekly,
    allRowsColumnAQTotal,
    monthlyBaselineBilledAmount: baselineWeekly * 4,
    annualBaselineBilledAmount: baselineWeekly * 48,
    hiddenOpenRoutedCount: centers.filter((center) => /^open$/i.test(center.centerStatus) && Boolean(center.routeNameMckensson) && center.excelRowHidden).length,
    weeklyCasesTotal: scheduledCenters.reduce((sum, row) => sum + numericValue(row.totalCasesByWeek), 0),
    weeklyLitersTotal: scheduledCenters.reduce((sum, row) => sum + numericValue(row.totalLitersByWeek), 0),
    weeklyPalletsTotal: scheduledCenters.reduce((sum, row) => sum + numericValue(row.weeklyPallets), 0),
    weekAStopCount: weekAStops.length,
    weekBStopCount: weekBStops.length,
    warnings
  };

  note(SOURCES.consolidatedWorkbook, 'validation', 'Consolidated workbook validation summary.', stats);

  return {
    stats,
    workbook,
    outputs: {
      'billingFY26.json': billingFY26,
      'scheduledCenters.json': scheduledCenters,
      'weekAStops.json': weekAStops,
      'weekBStops.json': weekBStops,
      'casesByCenter.json': casesByCenter,
      'centers.json': centers,
      'excludedCenters.json': excludedCenters,
      'routeOrigins.json': buildRouteOrigins(scheduledCenters),
      'dataQuality.json': dataQuality,
      'rateTable.json': {
        source: SOURCES.consolidatedWorkbook,
        note: 'Legacy Rate Table workbook is no longer required by the parser migration. Route-cost assumptions remain unchanged in application logic.',
        rateUnit: 'Mileage commodity rates are dollars per 100 lbs.',
        minimumChargeWeightLbs: 750,
        defaultWeightPerCaseLbs: 250,
        cpiIncrease2025: 0.0239,
        dedicatedTransportationRatePerMile: 3.34,
        dedicatedRatePerMile: 3.34,
        nonStandardPickupPerHour: 97.27,
        averageFuelSurchargePctFromWorkbook: 0.24056947933800188,
        mileageRates: []
      },
      'contractAssumptions.json': [{ source: 'generated-by-build-data', casesPerPallet: 70, collectionTrailer: '48 ft refrigerated trailer', fuelSurchargeRule: '1% per full $0.08 above $1.70/gallon' }],
      'contractRules.json': [{ source: 'generated-by-build-data', rule: 'Validate billing mileage against contract rating, PC Miler/e-Miler, or invoice mileage where available.' }],
      'specialCharges.json': buildSpecialCharges(billingFY26),
      'stats.json': stats
    }
  };
}

function printDryRun({ stats, workbook }) {
  const headers = workbook.headersBySheet.get(SOURCES.masterSheet) || [];
  console.log('Dry run only. No JSON files were written.');
  console.log(`Workbook found: ${workbook.found ? 'yes' : 'no'} (${SOURCES.consolidatedWorkbook})`);
  console.log(`Sheet names: ${workbook.sheets.join(', ') || '(none)'}`);
  console.log(`Detected ${SOURCES.masterSheet} headers: ${headers.filter(Boolean).join(' | ') || '(none)'}`);
  console.log(`Total master rows: ${stats.totalMasterRows}`);
  console.log(`Open center count: ${stats.openCenterCount}`);
  console.log(`Closed/excluded count: ${stats.closedExcludedCount}`);
  console.log(`Hidden OPEN routed count excluded from active baseline: ${stats.hiddenOpenRoutedCount}`);
  console.log(`McKesson route count: ${stats.mckessonRouteCount}`);
  console.log(`Base PLC counts: ${JSON.stringify(stats.basePLCCounts)}`);
  console.log(`Actual PLC counts: ${JSON.stringify(stats.actualPLCCounts)}`);
  console.log(`Column AQ active baseline weekly total: $${stats.weeklyBaselineBilledAmount.toFixed(2)}`);
  console.log(`Column AQ all non-summary rows total: $${stats.allRowsColumnAQTotal.toFixed(2)}`);
  console.log(`Weekly billed amount: $${stats.weeklyBaselineBilledAmount.toFixed(2)}`);
  console.log(`Monthly billed amount: $${stats.monthlyBaselineBilledAmount.toFixed(2)}`);
  console.log(`Annual billed amount: $${stats.annualBaselineBilledAmount.toFixed(2)}`);
  console.log(`Weekly cases total: ${stats.weeklyCasesTotal.toFixed(2)}`);
  console.log(`Weekly liters total: ${stats.weeklyLitersTotal.toFixed(2)}`);
  console.log(`Weekly pallets total: ${stats.weeklyPalletsTotal.toFixed(2)}`);
  console.log(`Week A Word stop count: ${stats.weekAStopCount}`);
  console.log(`Week B Word stop count: ${stats.weekBStopCount}`);
  console.log(`Warnings/missing columns: ${stats.warnings.length ? stats.warnings.join(' | ') : 'none'}`);
}

const result = buildOutputs();
if (dryRun) {
  printDryRun(result);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const [fileName, payload] of Object.entries(result.outputs)) {
    writeFileSync(path.join(outDir, fileName), `${JSON.stringify(payload, null, 2)}\n`);
  }
  console.log(`Generated ${Object.keys(result.outputs).length} JSON file(s) in ${path.relative(root, outDir)}.`);
  console.log(`Data quality notes: ${dataQuality.length}`);
}
