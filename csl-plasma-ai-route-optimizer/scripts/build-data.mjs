#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const sourceDir = path.join(root, 'source-data');
const outDir = path.join(root, 'lib', 'data');
const dataQuality = [];

const SOURCES = {
  billingFY26: 'Billing Center FY26.xlsx',
  routeOrigins: 'CSL Route Origin.xlsx',
  centers: 'Plasma Centers Information.xlsx',
  casesByCenter: 'Plasma Centers cases details.xlsx',
  rateTable: 'Rate Table.xlsx',
  scheduledCenters: 'Schedule plasma centers.xlsx',
  weekAStops: 'Week A Schedule based on Routes.docx',
  weekBStops: 'Week B Schedule Based on Routes.docx'
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
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
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
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
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

function rowsToObjects(rows) {
  const headerIndex = rows.findIndex((row) => row.filter((cell) => cleanText(cell)).length >= 2);
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map(headerKey);
  return rows.slice(headerIndex + 1).map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      const value = cleanText(row[index]);
      if (value !== '') obj[header] = value;
    });
    return obj;
  }).filter((row) => Object.keys(row).length);
}

function readXlsx(fileName) {
  const filePath = path.join(sourceDir, fileName);
  if (!existsSync(filePath)) { note(fileName, 'missing', 'Source file is missing.'); return []; }
  try {
    const zip = readZipEntries(filePath);
    const workbook = zip.get('xl/workbook.xml') || '';
    const rels = parseRelationships(zip.get('xl/_rels/workbook.xml.rels') || '');
    const shared = parseSharedStrings(zip.get('xl/sharedStrings.xml') || '');
    const allRows = [];

    for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
      const name = attr(sheet[0], 'name') || 'Sheet';
      const relId = attr(sheet[0], 'r:id');
      const target = rels[relId] || '';
      const sheetPath = target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`;
      const rows = rowsToObjects(parseSheetRows(zip.get(sheetPath) || '', shared));
      allRows.push(...rows.map((row) => ({ sourceSheet: name, ...row })));
    }
    note(fileName, 'source-parsed', `Parsed ${allRows.length} row(s).`);
    return allRows;
  } catch (err) {
    note(fileName, 'parse-error', err.message);
    return [];
  }
}

function firstPresent(row, fields) {
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') return row[field];
  }
  return '';
}

function numericValue(value) {
  const n = Number(String(value ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function validBillingRow(row) {
  const identity = firstPresent(row, ['bOL', 'bol', 'invoiceNo', 'routeNameMckensson', 'routeNameMckesson', 'routeName', 'stopLocation']);
  const amount = numericValue(firstPresent(row, ['linehaulAmount', 'fuelSurcharge', 'bOLTotal', 'bolTotal', 'cases', 'miles', 'rateMiles']));
  const text = Object.values(row).join(' ').trim();
  return Boolean(identity && amount && !/^invoice\s+|^route\s+|^total\s*$/i.test(text));
}

function normalizeBillingRows(rows) {
  return rows.filter(validBillingRow).map((row) => ({
    ...row,
    linehaulAmount: numericValue(firstPresent(row, ['linehaulAmount', 'Linehaul Amount'])),
    fuelSurcharge: numericValue(firstPresent(row, ['fuelSurcharge', 'Fuel Surcharge'])),
    bOLTotal: numericValue(firstPresent(row, ['bOLTotal', 'bolTotal', 'BOL Total'])),
    invoiceDate: firstPresent(row, ['invoiceDate', 'Invoice Date']),
    pickupDate: firstPresent(row, ['pickupDate', 'Pickup Date']),
    invoiceNo: firstPresent(row, ['invoiceNo', 'Invoice No']),
    bol: firstPresent(row, ['bOL', 'bol', 'BOL'])
  }));
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

function findField(row, patterns) {
  const entry = Object.entries(row).find(([key]) => patterns.some((pattern) => pattern.test(key)));
  return entry?.[1] || '';
}

function buildRouteOrigins(rows) {
  const routeOrigins = {};
  const originDetails = {};
  for (const row of rows) {
    const route = findField(row, [/route/i]);
    const origin = findField(row, [/origin/i, /plc/i]);
    if (route && origin) routeOrigins[String(route).trim().toUpperCase()] = origin;
    if (origin) originDetails[origin] ||= { name: origin };
  }
  return { routeOrigins, originDetails, rows };
}

function buildExcludedCenters(rows) {
  return rows.filter((row) => /closed|excluded|inactive|problem/i.test(Object.values(row).join(' ')));
}

function buildSpecialCharges(rows) {
  return rows.filter((row) => Object.keys(row).some((key) => /special|storage|other|charge|fee|surcharge/i.test(key)));
}

const centers = readXlsx(SOURCES.centers);
const scheduledCenters = readXlsx(SOURCES.scheduledCenters);
const billingFY26 = readXlsx(SOURCES.billingFY26);
const casesByCenter = readXlsx(SOURCES.casesByCenter);
const routeOriginRows = readXlsx(SOURCES.routeOrigins);
const rateTableRows = readXlsx(SOURCES.rateTable);
const weekAStops = readDocx(SOURCES.weekAStops);
const weekBStops = readDocx(SOURCES.weekBStops);

mkdirSync(outDir, { recursive: true });
const outputs = {
  'billingFY26.json': normalizeBillingRows(billingFY26),
  'scheduledCenters.json': scheduledCenters,
  'weekAStops.json': weekAStops,
  'weekBStops.json': weekBStops,
  'casesByCenter.json': casesByCenter,
  'centers.json': centers,
  'excludedCenters.json': buildExcludedCenters(centers),
  'routeOrigins.json': buildRouteOrigins(routeOriginRows),
  'dataQuality.json': dataQuality,
  'contractAssumptions.json': [{ source: 'generated-by-build-data', casesPerPallet: 70, collectionTrailer: '48 ft refrigerated trailer', fuelSurchargeRule: '1% per full $0.08 above $1.70/gallon' }],
  'contractRules.json': [{ source: 'generated-by-build-data', rule: 'Validate billing mileage against contract rating, PC Miler/e-Miler, or invoice mileage where available.' }],
  'specialCharges.json': buildSpecialCharges([...normalizeBillingRows(billingFY26), ...rateTableRows])
};

for (const [fileName, payload] of Object.entries(outputs)) {
  writeFileSync(path.join(outDir, fileName), `${JSON.stringify(payload, null, 2)}\n`);
}

console.log(`Generated ${Object.keys(outputs).length} JSON file(s) in ${path.relative(root, outDir)}.`);
console.log(`Data quality notes: ${dataQuality.length}`);
