import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'lib', 'data');

export const DATA_SUMMARY_FILES = [
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
  'specialCharges.json'
];

const DATA_QUALITY_FILE = 'dataQuality.json';
const RECORDS_FILE = 'records.json';

const BUILT_IN_CONTRACT_ASSUMPTIONS = [
  { name: 'deadheadExcludedFromCost', value: true },
  { name: 'chargeStartsAt', value: 'first pickup' },
  { name: 'collectionTrailer', value: '48 ft refrigerated only' },
  { name: 'casesPerPallet', value: 70 }
];

const BUILT_IN_CONTRACT_RULES = [
  { name: 'routeMileage', rule: 'Use available weekly miles as the route mileage basis.' },
  { name: 'costFields', rule: 'Use available linehaul, fuel, storage, other charge, and total cost fields.' },
  { name: 'fallbackData', rule: 'When newer generated JSON is unavailable, summarize existing records.json runtime data.' }
];

function countRecords(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.records)) return data.records.length;
    if (Array.isArray(data.items)) return data.items.length;
    return Object.keys(data).length;
  }
  return data == null ? 0 : 1;
}

function sampleRecords(data) {
  if (Array.isArray(data)) return data.slice(0, 3);
  if (data && typeof data === 'object') {
    if (Array.isArray(data.records)) return data.records.slice(0, 3);
    if (Array.isArray(data.items)) return data.items.slice(0, 3);
    return Object.entries(data).slice(0, 3).map(([key, value]) => ({ key, value }));
  }
  return data == null ? [] : [data];
}

async function readJsonFile(fileName) {
  const content = await readFile(path.join(DATA_DIR, fileName), 'utf8');
  return JSON.parse(content);
}

function warningsForFile(dataQuality, fileName) {
  if (!dataQuality || typeof dataQuality !== 'object') return [];

  const candidates = [
    fileName,
    fileName.replace(/\.json$/, ''),
    path.join('lib', 'data', fileName)
  ];

  for (const key of candidates) {
    const value = dataQuality[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.warnings)) return value.warnings;
  }

  return [];
}

function uniqueBy(records, keyForRecord) {
  const seen = new Map();
  for (const record of records) {
    const key = keyForRecord(record);
    if (key && !seen.has(key)) seen.set(key, record);
  }
  return [...seen.values()];
}

function weekdayEntries(record) {
  const pickupDays = record.pickupDays || {};
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map((day) => ({ day, value: pickupDays[day] || record[day] || '' }))
    .filter(({ value }) => Boolean(value));
}

function weekStops(records, week) {
  return records.flatMap((record) => weekdayEntries(record)
    .filter(({ value }) => String(value).toUpperCase().includes(week))
    .map(({ day, value }) => ({
      centerNumber: record.centerNumber,
      centerName: record.city ? `${record.city}, ${record.state}` : record.routeName,
      routeName: record.routeName,
      mckessonRoute: record.mckessonRoute,
      pickupDay: day,
      pickupPattern: value,
      city: record.city,
      state: record.state,
      lat: record.lat,
      lng: record.lng
    })));
}


function fallbackData(fileName, records) {
  switch (fileName) {
    case 'centers.json':
      return uniqueBy(records, (record) => record.centerNumber).map((record) => ({
        centerNumber: record.centerNumber,
        city: record.city,
        state: record.state,
        zip: record.zip,
        address: record.address,
        centerStatus: record.centerStatus,
        basePLC: record.basePLC,
        actualPLC: record.actualPLC,
        lat: record.lat,
        lng: record.lng
      }));
    case 'scheduledCenters.json':
      return records.filter((record) => weekdayEntries(record).length > 0).map((record) => ({
        centerNumber: record.centerNumber,
        routeName: record.routeName,
        mckessonRoute: record.mckessonRoute,
        pickupFrequency: record.pickupFrequency,
        weekPatternA: record.weekPatternA,
        weekPatternB: record.weekPatternB,
        pickupDays: record.pickupDays
      }));
    case 'weekAStops.json':
      return weekStops(records, 'A');
    case 'weekBStops.json':
      return weekStops(records, 'B');
    case 'billingFY26.json':
      return records.map((record) => ({
        centerNumber: record.centerNumber,
        routeName: record.routeName,
        weeklyMiles: record.weeklyMiles,
        weeklyCases: record.weeklyCases,
        linehaulCost: record.linehaulCost,
        fuelSurchargeDollar: record.fuelSurchargeDollar,
        storageFeeDollar: record.storageFeeDollar,
        otherChargesDollar: record.otherChargesDollar,
        totalRouteCost: record.totalRouteCost,
        sumBilledWeekly: record.sumBilledWeekly,
        costPerCase: record.costPerCase,
        costPerLiter: record.costPerLiter
      }));
    case 'casesByCenter.json':
      return uniqueBy(records, (record) => record.centerNumber).map((record) => ({
        centerNumber: record.centerNumber,
        routeName: record.routeName,
        city: record.city,
        state: record.state,
        weeklyCases: record.weeklyCases,
        weeklyLiters: record.weeklyLiters,
        weeklyPallets: record.weeklyPallets,
        weightPerCase: record.weightPerCase
      }));
    case 'excludedCenters.json':
      return records.filter((record) => String(record.centerStatus || '').toUpperCase() !== 'OPEN').map((record) => ({
        centerNumber: record.centerNumber,
        routeName: record.routeName,
        city: record.city,
        state: record.state,
        centerStatus: record.centerStatus
      }));
    case 'specialCharges.json':
      return records.filter((record) => Number(record.storageFeeDollar || 0) || Number(record.otherChargesDollar || 0) || Number(record.fuelSurchargeDollar || 0)).map((record) => ({
        centerNumber: record.centerNumber,
        routeName: record.routeName,
        fuelSurchargePct: record.fuelSurchargePct,
        fuelSurchargeDollar: record.fuelSurchargeDollar,
        storageFeeDollar: record.storageFeeDollar,
        otherChargesDollar: record.otherChargesDollar
      }));
    case 'contractAssumptions.json':
      return BUILT_IN_CONTRACT_ASSUMPTIONS;
    case 'contractRules.json':
      return BUILT_IN_CONTRACT_RULES;
    default:
      return null;
  }
}

function fallbackWarning(fileName, sourceStatus) {
  if (sourceStatus === 'source-parsed-json') return null;
  if (sourceStatus === 'generated-warning') {
    return `${fileName} is missing; returned safe built-in values.`;
  }
  if (sourceStatus === 'fallback-records-json') {
    return `${fileName} is missing; summary was derived from ${RECORDS_FILE}.`;
  }
  return `${fileName} is missing and no fallback is available.`;
}

async function summarizeFile(fileName, dataQuality, records) {
  try {
    const data = await readJsonFile(fileName);
    return {
      fileName,
      sourceStatus: 'source-parsed-json',
      recordCount: countRecords(data),
      sampleRecords: sampleRecords(data),
      dataQualityWarnings: warningsForFile(dataQuality, fileName)
    };
  } catch (error) {
    const fallback = records ? fallbackData(fileName, records) : null;
    const sourceStatus = fallback
      ? (fileName.startsWith('contract') ? 'generated-warning' : 'fallback-records-json')
      : 'missing';
    const warning = fallbackWarning(fileName, sourceStatus);

    return {
      fileName,
      sourceStatus,
      recordCount: countRecords(fallback),
      sampleRecords: sampleRecords(fallback),
      dataQualityWarnings: warning ? [warning] : [],
      error: sourceStatus === 'missing' ? error.message : undefined
    };
  }
}

export async function getDataSummary() {
  const generatedWarnings = [];
  let dataQuality = null;
  let records = null;

  try {
    dataQuality = await readJsonFile(DATA_QUALITY_FILE);
  } catch {
    generatedWarnings.push(`${DATA_QUALITY_FILE} is missing; data-quality warnings were generated from fallback behavior.`);
  }

  try {
    records = await readJsonFile(RECORDS_FILE);
  } catch (error) {
    generatedWarnings.push(`${RECORDS_FILE} is missing; fallback summaries are unavailable: ${error.message}`);
  }

  const files = await Promise.all(DATA_SUMMARY_FILES.map((fileName) => summarizeFile(fileName, dataQuality, records)));
  const fallbackWarnings = files.flatMap((file) => file.dataQualityWarnings || []);

  return {
    files,
    dataQuality: {
      sourceStatus: dataQuality ? 'source-parsed-json' : 'generated-warning',
      available: Boolean(dataQuality),
      warnings: [
        ...(dataQuality?.warnings || dataQuality?.dataQualityWarnings || []),
        ...generatedWarnings,
        ...fallbackWarnings
      ]
    }
  };
}
