import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDataSummary } from './dataSummary.js';

const DATA_DIR = path.join(process.cwd(), 'lib', 'data');
const ALLOWED_STATUS = {
  OK: 'OK',
  REVIEW: 'Review',
  MISSING: 'Missing Data',
  EXPIRED: 'Expired Window',
  UNMAPPED: 'Unmapped'
};
const MONEY_FIELDS = ['totalRouteCost', 'sumBilledWeekly', 'linehaulCost', 'fuelSurchargeDollar', 'storageFeeDollar', 'otherChargesDollar'];

function readJson(fileName) {
  if (!['billingFY26.json', 'records.json'].includes(fileName)) return null;
  const filePath = path.join(DATA_DIR, fileName);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const arrayValue = Object.values(payload).find(Array.isArray);
  return arrayValue || Object.entries(payload).map(([key, value]) => ({ key, ...(typeof value === 'object' ? value : { value }) }));
}

function firstValue(row, fields) {
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') return row[field];
  }
  return undefined;
}

function numberValue(row, fields) {
  const value = firstValue(row, fields);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasAnyMoney(row) {
  return MONEY_FIELDS.some((field) => Number.isFinite(Number(row[field])) && Number(row[field]) !== 0);
}

function normalizeDate(value) {
  if (!value) return null;

  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 30000) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    return new Date(excelEpoch + numericValue * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const isoDate = normalizeDate(value);
  if (!isoDate) return { date: null, status: ALLOWED_STATUS.MISSING };

  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  const iso = date.toISOString().slice(0, 10);
  return { date: iso, status: date < new Date() ? ALLOWED_STATUS.EXPIRED : ALLOWED_STATUS.OK };
}

function centerNameLookup(records) {
  const lookup = new Map();
  for (const record of rowsFromPayload(records)) {
    const centerNumber = firstValue(record, ['centerNumber', 'centerId', 'id']);
    const centerName = firstValue(record, ['centerName', 'name', 'routeName']);
    if (!centerNumber || !centerName) continue;
    lookup.set(String(centerNumber).trim(), centerName);
    const numericKey = String(Number(centerNumber));
    if (numericKey !== 'NaN') lookup.set(numericKey, centerName);
  }
  return lookup;
}

function billingRows(summary) {
  const billingSummary = summary.files.find((file) => file.fileName === 'billingFY26.json');
  let rows = [];

  if (billingSummary?.sourceStatus === 'source-parsed-json') rows = rowsFromPayload(readJson('billingFY26.json'));
  if (billingSummary?.sourceStatus === 'fallback-records-json') rows = rowsFromPayload(readJson('records.json')).filter(hasAnyMoney);

  return { billingSummary, rows };
}

function auditRow(row, centerNames) {
  const routeName = firstValue(row, ['routeNameMckesson', 'routeName', 'route', 'mckessonRoute']);
  const centerNumber = firstValue(row, ['centerNumber', 'centerId', 'id']);
  const centerName = firstValue(row, ['centerName', 'name']) || centerNames.get(String(centerNumber || '').trim()) || centerNames.get(String(Number(centerNumber)));
  const plc = firstValue(row, ['actualPLC', 'basePLC', 'plc', 'originPLC']);
  const cases = numberValue(row, ['weeklyCases', 'cases', 'caseCount']);
  const miles = numberValue(row, ['weeklyMiles', 'miles', 'routeMiles']);
  const linehaul = numberValue(row, ['linehaulCost', 'linehaul']);
  const fuelSurcharge = numberValue(row, ['fuelSurchargeDollar', 'fuelSurcharge', 'fuel']);
  const totalCost = numberValue(row, ['totalRouteCost', 'sumBilledWeekly', 'totalCost', 'invoiceTotal']) || linehaul + fuelSurcharge;
  const costPerCase = cases > 0 ? totalCost / cases : 0;
  const costPerMile = miles > 0 ? totalCost / miles : 0;
  const invoiceDate = normalizeDate(firstValue(row, ['invoiceDate', 'invoice_date']));
  const pickupDate = normalizeDate(firstValue(row, ['pickupDate', 'pickup_date', 'serviceDate']));
  const disputeDeadline = addDays(invoiceDate, 30);
  const overchargeDeadline = addDays(pickupDate, 180);

  const explanations = [];
  let status = ALLOWED_STATUS.OK;

  if (!routeName) {
    status = ALLOWED_STATUS.UNMAPPED;
    explanations.push('Missing route mapping; row is unmapped for invoice audit.');
  }
  if (!plc) {
    status = ALLOWED_STATUS.UNMAPPED;
    explanations.push('Missing PLC mapping; row is unmapped for invoice audit.');
  }
  if (!linehaul) {
    status = status === ALLOWED_STATUS.OK ? ALLOWED_STATUS.MISSING : status;
    explanations.push('Linehaul amount is missing or zero.');
  }
  if (!fuelSurcharge) explanations.push('Fuel surcharge amount is missing or zero.');
  if (!miles) explanations.push('Miles are missing or zero; cost-per-mile is unavailable.');
  if (!cases) explanations.push('Cases are missing or zero; cost-per-case is unavailable.');
  if (costPerMile && (costPerMile < 1 || costPerMile > 20)) {
    status = status === ALLOWED_STATUS.OK ? ALLOWED_STATUS.REVIEW : status;
    explanations.push('Cost per mile is outside the audit review band.');
  }
  if (disputeDeadline.status === ALLOWED_STATUS.MISSING) explanations.push('Invoice dispute deadline is Missing Data because invoice date is unavailable.');
  if (overchargeDeadline.status === ALLOWED_STATUS.MISSING) explanations.push('Overcharge/undercharge deadline is Missing Data because pickup date is unavailable.');

  return {
    routeName,
    centerName,
    centerNumber,
    plc,
    cases,
    miles,
    linehaul,
    fuelSurcharge,
    totalCost,
    costPerCase: cases > 0 ? Number(costPerCase.toFixed(2)) : null,
    costPerMile: miles > 0 ? Number(costPerMile.toFixed(2)) : null,
    invoiceDate,
    pickupDate,
    invoiceDisputeDeadline: disputeDeadline.date,
    invoiceDisputeDeadlineStatus: disputeDeadline.status,
    overchargeUnderchargeDeadline: overchargeDeadline.date,
    overchargeUnderchargeDeadlineStatus: overchargeDeadline.status,
    status,
    explanation: explanations.length ? explanations.join(' ') : 'Billing-like row passed backend audit checks; route-mile scenarios remain operational opportunity only.'
  };
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
}

export function getInvoiceAudit() {
  const summary = getDataSummary();
  const { billingSummary, rows } = billingRows(summary);
  const centerNames = centerNameLookup(readJson('records.json'));
  const results = rows.map((row) => auditRow(row, centerNames));
  const totalLinehaul = sum(results, 'linehaul');
  const totalFuelSurcharge = sum(results, 'fuelSurcharge');
  const totalCost = sum(results, 'totalCost');
  const totalCases = sum(results, 'cases');
  const totalMiles = sum(results, 'miles');

  return {
    generatedAt: new Date().toISOString(),
    sourceStatus: {
      billingFY26: billingSummary?.sourceStatus || 'missing',
      billingRecordCount: billingSummary?.recordCount || 0,
      dataSummaryGeneratedAt: summary.generatedAt
    },
    totalRows: results.length,
    totalLinehaul,
    totalFuelSurcharge,
    totalCost,
    averageCostPerCase: totalCases > 0 ? Number((totalCost / totalCases).toFixed(2)) : null,
    averageCostPerMile: totalMiles > 0 ? Number((totalCost / totalMiles).toFixed(2)) : null,
    rowsNeedingReview: results.filter((row) => row.status !== ALLOWED_STATUS.OK).length,
    unmappedRows: results.filter((row) => row.status === ALLOWED_STATUS.UNMAPPED).length,
    missingPlcRows: results.filter((row) => !row.plc).length,
    missingRouteRows: results.filter((row) => !row.routeName).length,
    zeroLinehaulRows: results.filter((row) => !row.linehaul).length,
    zeroFuelRows: results.filter((row) => !row.fuelSurcharge).length,
    abnormalCostPerMileRows: results.filter((row) => row.costPerMile && (row.costPerMile < 1 || row.costPerMile > 20)).length,
    operationalOpportunityNotice: 'Route-mile and cost scenarios are operational opportunity only unless actual invoice and contract rating proves savings.',
    rows: results
  };
}
