import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'lib', 'data');
const SUMMARY_FILES = [
  'centers.json',
  'scheduledCenters.json',
  'weekAStops.json',
  'weekBStops.json',
  'billingFY26.json',
  'casesByCenter.json',
  'excludedCenters.json',
  'routeOrigins.json',
  'contractAssumptions.json',
  'contractRules.json',
  'specialCharges.json',
  'dataQuality.json'
];
const READ_ALLOWLIST = new Set([...SUMMARY_FILES, 'records.json']);
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SOURCE_PARSED_JSON = 'source-parsed-json';
const FALLBACK_RECORDS_JSON = 'fallback-records-json';
const GENERATED_WARNING = 'generated-warning';
const MISSING = 'missing';

function safeReadJson(fileName) {
  if (!READ_ALLOWLIST.has(fileName)) return { status: MISSING, data: null };

  const filePath = path.join(DATA_DIR, fileName);
  if (!existsSync(filePath)) return { status: MISSING, data: null };

  try {
    return { status: SOURCE_PARSED_JSON, data: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { status: MISSING, data: null, warning: `${fileName} could not be parsed: ${err.message}` };
  }
}

function toRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return data == null ? [] : [data];

  const arrayValue = Object.values(data).find(Array.isArray);
  if (arrayValue) return arrayValue;
  return Object.entries(data).map(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value) ? { key, ...value } : { key, value }
  );
}

function compactRecord(record) {
  if (!record || typeof record !== 'object') return record;

  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') {
      if (Array.isArray(value)) out[key] = value.slice(0, 3);
      else out[key] = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function summary(fileName, rows, sourceStatus) {
  const records = toRows(rows);
  return {
    fileName,
    recordCount: records.length,
    sampleRecords: records.slice(0, 3).map(compactRecord),
    sourceStatus
  };
}

function openWithValidRoute(r) {
  return String(r.centerStatus || '').toUpperCase() === 'OPEN' && Boolean(r.mckessonRoute || r.routeNameMckesson);
}

function hasPickupDay(r) {
  return DAYS.some((day) => Boolean(r[day] || r.pickupDays?.[day]));
}

function isWeek(r, week) {
  const needle = String(week).toUpperCase();
  return [r.weekPatternA, r.weekPatternB, ...DAYS.map((day) => r[day] || r.pickupDays?.[day])]
    .some((value) => String(value || '').toUpperCase().includes(needle));
}

function hasAnyNumber(r, fields) {
  return fields.some((field) => Number.isFinite(Number(r[field])) && Number(r[field]) !== 0);
}

function hasClosedOrProblemStatus(r) {
  const status = `${r.centerStatus || ''} ${r.status || ''} ${r.excludeReason || ''} ${r.problem || ''}`.toUpperCase();
  return status.includes('CLOSED') || status.includes('EXCLUDED') || status.includes('PROBLEM') || status.includes('INACTIVE');
}

function pick(r, fields) {
  return Object.fromEntries(fields.filter((field) => r[field] !== undefined).map((field) => [field, r[field]]));
}

function fallbackRows(fileName, records) {
  switch (fileName) {
    case 'centers.json':
      return records;
    case 'scheduledCenters.json':
      return records.filter(openWithValidRoute);
    case 'weekAStops.json':
      return records.filter((r) => isWeek(r, 'A') || hasPickupDay(r));
    case 'weekBStops.json':
      return records.filter((r) => isWeek(r, 'B') || hasPickupDay(r));
    case 'billingFY26.json':
      return records
        .filter((r) => hasAnyNumber(r, ['totalRouteCost', 'sumBilledWeekly', 'linehaulCost', 'fuelSurchargeDollar', 'storageFeeDollar', 'otherChargesDollar']))
        .map((r) => pick(r, ['centerNumber', 'routeName', 'routeNameMckesson', 'totalRouteCost', 'sumBilledWeekly', 'linehaulCost', 'fuelSurchargeDollar', 'storageFeeDollar', 'otherChargesDollar']));
    case 'casesByCenter.json':
      return records.map((r) => pick(r, ['centerNumber', 'routeName', 'weeklyCases', 'weeklyLiters', 'weeklyPallets']));
    case 'excludedCenters.json':
      return records.filter(hasClosedOrProblemStatus);
    case 'specialCharges.json':
      return records
        .filter((r) => hasAnyNumber(r, ['storageFeeDollar', 'otherChargesDollar']))
        .map((r) => pick(r, ['centerNumber', 'routeName', 'storageFeeDollar', 'otherChargesDollar']));
    default:
      return [];
  }
}

function generatedRows(fileName, recordsStatus, recordsWarning) {
  const base = { warning: `${fileName} is missing; using generated safe defaults for summary only.` };
  if (recordsStatus !== SOURCE_PARSED_JSON) base.recordsJson = recordsWarning || 'records.json is missing or could not be parsed.';

  if (fileName === 'contractAssumptions.json') {
    return [{ ...base, deadheadCharged: false, chargeStartsAt: 'first pickup', generated: true }];
  }
  if (fileName === 'contractRules.json') {
    return [{ ...base, rule: 'No contract rules JSON was available; route optimizer logic was not changed.', generated: true }];
  }
  if (fileName === 'dataQuality.json') {
    return [
      base,
      { warning: 'New generated JSON files may be absent; summaries can fall back to records.json.', generated: true },
      { warning: `records.json status: ${recordsStatus}.`, generated: true }
    ];
  }
  return [];
}

export function getDataSummary() {
  const recordsRead = safeReadJson('records.json');
  const records = Array.isArray(recordsRead.data) ? recordsRead.data : [];

  const files = SUMMARY_FILES.map((fileName) => {
    const read = safeReadJson(fileName);
    if (read.status === SOURCE_PARSED_JSON) return summary(fileName, read.data, SOURCE_PARSED_JSON);

    if (['contractAssumptions.json', 'contractRules.json', 'dataQuality.json'].includes(fileName)) {
      return summary(fileName, generatedRows(fileName, recordsRead.status, recordsRead.warning), GENERATED_WARNING);
    }

    if (recordsRead.status === SOURCE_PARSED_JSON) return summary(fileName, fallbackRows(fileName, records), FALLBACK_RECORDS_JSON);
    return summary(fileName, [], MISSING);
  });

  const dataQuality = files.find((file) => file.fileName === 'dataQuality.json') || summary('dataQuality.json', [], MISSING);
  return { files, dataQuality, generatedAt: new Date().toISOString() };
}
