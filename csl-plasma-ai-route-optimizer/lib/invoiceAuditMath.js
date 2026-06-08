import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataSummary } from './dataSummary.js';

const DATA_DIR = path.join(process.cwd(), 'lib', 'data');
const ABNORMAL_COST_PER_MILE = 8;

async function readJson(fileName) {
  const content = await readFile(path.join(DATA_DIR, fileName), 'utf8');
  return JSON.parse(content);
}

function numberValue(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function textValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim()) || '';
}

function addDays(value, days) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function deadlineStatus(deadline) {
  if (!deadline) return 'Missing Data';
  return new Date(`${deadline}T00:00:00.000Z`) < new Date() ? 'Expired Window' : 'OK';
}

function normalizeRow(row, index, sourceStatus) {
  const linehaul = numberValue(row.linehaulCost, row.linehaul, row.linehaulCharge);
  const fuelSurcharge = numberValue(row.fuelSurchargeDollar, row.fuelSurcharge, row.fuelCharge);
  const totalCost = numberValue(row.totalRouteCost, row.sumBilledWeekly, row.totalCost, row.bolCost, linehaul + fuelSurcharge);
  const weeklyCases = numberValue(row.weeklyCases, row.cases);
  const weeklyMiles = numberValue(row.weeklyMiles, row.miles);
  const costPerMile = numberValue(row.costPerMile, weeklyMiles ? totalCost / weeklyMiles : undefined);

  return {
    rowId: textValue(row.id, row.invoiceNumber, row.bol, row.bolNumber, index + 1),
    centerNumber: textValue(row.centerNumber, row.center, row.plasmaCenter),
    routeName: textValue(row.routeName, row.mckessonRoute, row.route),
    plc: textValue(row.actualPLC, row.basePLC, row.plc),
    invoiceDate: textValue(row.invoiceDate, row.invoice_date),
    pickupDate: textValue(row.pickupDate, row.pickup_date, row.shipDate),
    linehaul,
    fuelSurcharge,
    totalCost,
    weeklyCases,
    weeklyMiles,
    costPerMile,
    sourceStatus
  };
}

function statusForRow(row) {
  const issues = [];
  if (!row.centerNumber && !row.routeName) issues.push('unmapped row');
  if (!row.plc) issues.push('missing PLC');
  if (!row.routeName) issues.push('missing route');
  if (row.linehaul === 0) issues.push('zero linehaul');
  if (row.fuelSurcharge === 0 && row.linehaul > 0) issues.push('zero fuel surcharge despite linehaul');
  if (row.costPerMile > ABNORMAL_COST_PER_MILE) issues.push(`abnormal cost per mile above ${ABNORMAL_COST_PER_MILE}`);
  return {
    status: issues.length ? (issues.includes('unmapped row') ? 'Unmapped' : 'Review') : 'OK',
    issues
  };
}

export async function getBillingRows() {
  const summary = await getDataSummary();
  const billingSummary = summary.files.find((file) => file.fileName === 'billingFY26.json');
  const sourceFile = billingSummary?.sourceStatus === 'source-parsed-json' ? 'billingFY26.json' : 'records.json';
  const rows = await readJson(sourceFile);
  const sourceStatus = billingSummary?.sourceStatus || (sourceFile === 'records.json' ? 'fallback-records-json' : 'source-parsed-json');

  return (Array.isArray(rows) ? rows : rows.records || rows.items || []).map((row, index) => normalizeRow(row, index, sourceStatus));
}

export async function getInvoiceAudit() {
  const rows = await getBillingRows();
  const totalLinehaul = numberValue(rows.reduce((total, row) => total + row.linehaul, 0).toFixed(2));
  const totalFuelSurcharge = numberValue(rows.reduce((total, row) => total + row.fuelSurcharge, 0).toFixed(2));
  const totalBolRouteCost = numberValue(rows.reduce((total, row) => total + row.totalCost, 0).toFixed(2));
  const totalCases = rows.reduce((total, row) => total + row.weeklyCases, 0);
  const totalMiles = rows.reduce((total, row) => total + row.weeklyMiles, 0);

  const rowResults = rows.map((row) => {
    const audit = statusForRow(row);
    const disputeDeadline = addDays(row.invoiceDate, 30);
    const overchargeUnderchargeDeadline = addDays(row.pickupDate, 180);

    return {
      ...row,
      status: audit.status,
      explanation: audit.issues.length ? audit.issues.join('; ') : 'No invoice audit exception detected from available fields.',
      disputeDeadlineStatus: deadlineStatus(disputeDeadline),
      disputeDeadline,
      overchargeUnderchargeDeadlineStatus: deadlineStatus(overchargeUnderchargeDeadline),
      overchargeUnderchargeDeadline,
      scenarioLabel: 'operational opportunity only; not confirmed invoice savings'
    };
  });

  return {
    totalRows: rowResults.length,
    totalLinehaul,
    totalFuelSurcharge,
    totalBolRouteCost,
    averageCostPerCase: totalCases ? numberValue((totalBolRouteCost / totalCases).toFixed(2)) : 0,
    averageCostPerMile: totalMiles ? numberValue((totalBolRouteCost / totalMiles).toFixed(2)) : 0,
    rowsNeedingReview: rowResults.filter((row) => row.status === 'Review').length,
    unmappedRows: rowResults.filter((row) => row.status === 'Unmapped').length,
    rowsWithMissingPLC: rowResults.filter((row) => !row.plc).length,
    rowsWithMissingRoute: rowResults.filter((row) => !row.routeName).length,
    rowsWithZeroLinehaul: rowResults.filter((row) => row.linehaul === 0).length,
    rowsWithZeroFuel: rowResults.filter((row) => row.fuelSurcharge === 0).length,
    rowsWithAbnormalCostPerMile: rowResults.filter((row) => row.costPerMile > ABNORMAL_COST_PER_MILE).length,
    guidance: 'Do not use Geoapify miles as billing truth. Route-mile or cost scenarios are operational opportunities unless actual invoice/contract rating proves savings.',
    rows: rowResults
  };
}
