import { getInvoiceAudit } from './invoiceAuditMath.js';

const STATUS = {
  OK: 'OK',
  REVIEW: 'Review',
  NEEDS_DIESEL: 'Needs Diesel Average',
  MISSING: 'Missing Data'
};

export function expectedFuelSurchargePercent(dieselAverage) {
  const diesel = Number(dieselAverage);
  if (!Number.isFinite(diesel)) return null;
  return Math.max(0, Math.floor((diesel - 1.7) / 0.08));
}

export function getFuelSurchargeAudit({ dieselAverage } = {}) {
  const invoiceAudit = getInvoiceAudit();
  const diesel = dieselAverage === undefined || dieselAverage === null || dieselAverage === '' ? null : Number(dieselAverage);
  const expectedPercent = expectedFuelSurchargePercent(diesel);
  const totalLinehaul = invoiceAudit.totalLinehaul;
  const totalFuelSurcharge = invoiceAudit.totalFuelSurcharge;
  const actualPercent = totalLinehaul > 0 ? (totalFuelSurcharge / totalLinehaul) * 100 : null;

  const rows = invoiceAudit.rows.map((row) => {
    const actualFuelSurchargePercent = row.linehaul > 0 ? (row.fuelSurcharge / row.linehaul) * 100 : null;
    const explanations = [];
    let status = 'OK';

    if (!row.linehaul) {
      status = STATUS.MISSING;
      explanations.push('Linehaul is missing or zero, so actual fuel surcharge percent cannot be calculated.');
    } else if (expectedPercent === null) {
      status = STATUS.NEEDS_DIESEL;
      explanations.push('Diesel average is required to calculate expected fuel surcharge percent.');
    } else if (Math.abs(actualFuelSurchargePercent - expectedPercent) > 1) {
      status = STATUS.REVIEW;
      explanations.push('Actual fuel surcharge percent differs from expected fuel surcharge percent by more than 1 percentage point.');
    }
    if (row.linehaul > 0 && !row.fuelSurcharge) {
      status = expectedPercent === null ? STATUS.NEEDS_DIESEL : STATUS.REVIEW;
      explanations.push('Linehaul exists but fuel surcharge is zero or missing.');
    }

    return {
      routeName: row.routeName,
      centerName: row.centerName,
      centerNumber: row.centerNumber,
      plc: row.plc,
      linehaul: row.linehaul,
      fuelSurcharge: row.fuelSurcharge,
      actualFuelSurchargePercent: actualFuelSurchargePercent === null ? null : Number(actualFuelSurchargePercent.toFixed(2)),
      expectedFuelSurchargePercent: expectedPercent,
      variancePercent: expectedPercent === null || actualFuelSurchargePercent === null ? null : Number((actualFuelSurchargePercent - expectedPercent).toFixed(2)),
      status,
      explanation: explanations.length ? explanations.join(' ') : 'Fuel surcharge row is within backend audit tolerance.'
    };
  });

  const zeroFuelWithLinehaulRows = rows.filter((row) => row.linehaul > 0 && !row.fuelSurcharge).length;
  const missingLinehaulRows = rows.filter((row) => !row.linehaul).length;
  const abnormalFuelPercentRows = rows.filter((row) => row.status === STATUS.REVIEW).length;
  const variancePercent = expectedPercent === null || actualPercent === null ? null : Number((actualPercent - expectedPercent).toFixed(2));
  const linehaulMappingInvalid = totalLinehaul === 0 && totalFuelSurcharge > 0;
  const status = linehaulMappingInvalid || abnormalFuelPercentRows || Math.abs(variancePercent || 0) > 0.5
    ? STATUS.REVIEW
    : expectedPercent === null
      ? STATUS.NEEDS_DIESEL
      : missingLinehaulRows
        ? STATUS.MISSING
        : STATUS.OK;

  return {
    generatedAt: new Date().toISOString(),
    dieselAverage: diesel,
    expectedFuelSurchargePercent: expectedPercent,
    totalLinehaul,
    totalFuelSurcharge,
    actualFuelSurchargePercent: actualPercent === null ? null : Number(actualPercent.toFixed(2)),
    variancePercent,
    status,
    explanation: linehaulMappingInvalid
      ? 'Linehaul mapping appears invalid.'
      : expectedPercent === null
        ? 'Needs Diesel Average: provide dieselAverage to apply 1% per full $0.08 above $1.70/gallon.'
        : 'Expected fuel surcharge uses 1% per full $0.08 diesel increase above $1.70/gallon; this is an audit signal and requires contract rating or McKesson repricing confirmation.',
    zeroFuelWithLinehaulRows,
    missingLinehaulRows,
    abnormalFuelPercentRows,
    rows
  };
}
