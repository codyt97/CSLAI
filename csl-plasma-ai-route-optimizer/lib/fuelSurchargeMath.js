import { getBillingRows } from './invoiceAuditMath.js';

const ABNORMAL_FUEL_PERCENT = 0.6;

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function expectedFuelSurchargePercent(dieselAverage) {
  const diesel = Number(dieselAverage);
  if (!Number.isFinite(diesel)) return null;
  return Math.max(0, Math.floor((diesel - 1.70) / 0.08)) / 100;
}

export async function getFuelSurchargeAudit(dieselAverage) {
  const rows = await getBillingRows();
  const totalLinehaul = rows.reduce((total, row) => total + row.linehaul, 0);
  const totalFuel = rows.reduce((total, row) => total + row.fuelSurcharge, 0);
  const actualFuelSurchargePercentage = totalLinehaul ? numberValue((totalFuel / totalLinehaul).toFixed(4)) : 0;
  const expected = expectedFuelSurchargePercent(dieselAverage);
  const rowsWithZeroFuelSurchargeDespiteLinehaul = rows.filter((row) => row.linehaul > 0 && row.fuelSurcharge === 0);
  const rowsWithAbnormalFuelPercentage = rows
    .map((row) => ({
      ...row,
      actualFuelSurchargePercentage: row.linehaul ? numberValue((row.fuelSurcharge / row.linehaul).toFixed(4)) : 0
    }))
    .filter((row) => row.actualFuelSurchargePercentage > ABNORMAL_FUEL_PERCENT);

  if (expected === null) {
    return {
      actualFuelSurchargePercentage,
      expectedFuelSurchargePercentage: null,
      variance: null,
      status: 'Needs Diesel Average',
      explanation: 'Provide dieselAverage query parameter to apply the contract formula: 1% for each full $0.08 diesel increase above $1.70/gallon.',
      rowsWithZeroFuelSurchargeDespiteLinehaul,
      rowsWithAbnormalFuelPercentage
    };
  }

  const variance = numberValue((actualFuelSurchargePercentage - expected).toFixed(4));
  const hasRowExceptions = rowsWithZeroFuelSurchargeDespiteLinehaul.length > 0 || rowsWithAbnormalFuelPercentage.length > 0;
  const status = Math.abs(variance) <= 0.005 && !hasRowExceptions ? 'OK' : 'Review';

  return {
    actualFuelSurchargePercentage,
    expectedFuelSurchargePercentage: numberValue(expected.toFixed(4)),
    variance,
    status,
    explanation: `Expected fuel surcharge is ${numberValue((expected * 100).toFixed(2))}% from diesel average ${dieselAverage}; invoice baseline uses available billing rows and does not use Geoapify miles.`,
    rowsWithZeroFuelSurchargeDespiteLinehaul,
    rowsWithAbnormalFuelPercentage
  };
}
