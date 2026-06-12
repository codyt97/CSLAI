#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const htmlPath = path.join(root, 'public', 'network-map.html');
const recordsPath = path.join(root, 'lib', 'data', 'records.json');
const html = readFileSync(htmlPath, 'utf8');
const lines = html.split(/\r?\n/);
const records = JSON.parse(readFileSync(recordsPath, 'utf8'));

const EXPECTED = {
  activeCenters: 296,
  weeklyCost: 364011.36,
  annualCost: 17472545.31,
  casesPerPallet: 70
};
const LIMIT = 30;

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function closeEnough(a, b, tolerance = 0.01) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tolerance;
}

function compact(text, length = 180) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
}

function activeRuntimeRecords() {
  return records.filter((record) => {
    const status = String(record.centerStatus || '').toUpperCase();
    const route = String(record.routeNameMckesson || record.mckessonRoute || '').trim().toUpperCase();
    return status === 'OPEN' && route && route !== '#N/A';
  });
}

function findOccurrences(patterns) {
  const out = [];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        out.push({ line: index + 1, pattern: String(pattern), text: line });
        break;
      }
    }
  });
  return out;
}

function classifyPalletFinding(finding) {
  const text = finding.text;
  if (/weeklyCases\s*\/\s*CASES_PER_PALLET|70 cases = 1 pallet|CASES_PER_PALLET\s*=\s*70/.test(text)) {
    return { status: 'safe', reason: 'Calculates pallets from weeklyCases / 70 or documents the 70 cases per pallet rule.' };
  }
  if (/sumField\(['"]weeklyPallets['"]\)|\.weeklyPallets|weeklyPallets\s*[:=]\s*[^;]*(record|raw|DATA)|palletImpact\s*:\s*c\.weeklyPallets/.test(text) && !/k\.weeklyPallets/.test(text)) {
    return { status: 'unsafe', reason: 'Uses stored/summed weeklyPallets; RFQ capacity should use weeklyCases / 70.' };
  }
  if (/k\.weeklyPallets|getRouteKpis\(r\)/.test(text)) {
    return { status: 'safe', reason: 'Uses getRouteKpis output, which calculates weeklyPallets from weeklyCases / 70.' };
  }
  if (/const DATA =/.test(text)) {
    return { status: 'needs review', reason: 'Embedded runtime DATA includes weeklyPallets fields; verify consumers do not use them for RFQ capacity.' };
  }
  return { status: 'needs review', reason: 'Pallet-related occurrence; verify it traces to weeklyCases / 70.' };
}

function classifyMileageFinding(finding) {
  const text = finding.text;
  if (/Current Source Miles|currentSourceMiles|currentWorkbookMiles|weeklyMiles/.test(text) && /proposedScenarioMiles|newMiles|Miles Saved|mileageDelta/.test(text)) {
    return { risk: 'high', reason: 'Same line compares current source/workbook miles with proposed scenario/routed miles.' };
  }
  if (/mileageBasisForRoute|Mileage Basis|mileageBasisStatus/.test(text)) {
    return { risk: 'needs review', reason: 'Mileage basis guard exists, but confirm it prevents source-vs-routed savings claims.' };
  }
  if (/weeklyMiles|Current Source Miles|currentMiles/.test(text)) {
    return { risk: 'needs review', reason: 'References current/source/workbook miles.' };
  }
  if (/newMiles|proposedScenarioMiles|Miles Saved/.test(text)) {
    return { risk: 'needs review', reason: 'References proposed/scenario routed miles.' };
  }
  return { risk: 'needs review', reason: 'Mileage-related occurrence.' };
}

function classifyCostFinding(finding) {
  const text = finding.text;
  if (/381925/.test(text)) return { risk: 'high', reason: 'References all-row diagnostic baseline $381,925.48 instead of active RFQ baseline.' };
  if (/364011/.test(text)) return { risk: 'safe', reason: 'References expected active RFQ weekly baseline.' };
  if (/const DATA =/.test(text) && /totalRouteCost|sumBilledWeekly/.test(text)) {
    return { risk: 'needs review', reason: 'Embedded DATA includes all row-level costs; active visible baseline cannot be confirmed from this alone.' };
  }
  if (/sumBilledWeekly|totalRouteCost/.test(text)) return { risk: 'needs review', reason: 'Uses row cost fields; ensure closed/hidden rows are excluded before baseline rollup.' };
  return { risk: 'needs review', reason: 'Cost-related occurrence.' };
}

function printFindings(title, findings, formatter, filter = () => true) {
  const selected = findings.filter(filter).slice(0, LIMIT);
  console.log(`\n## ${title}`);
  if (!selected.length) {
    console.log('No findings in this category.');
    return;
  }
  selected.forEach((finding, idx) => {
    const extra = formatter(finding);
    console.log(`${idx + 1}. line ${finding.line} [${extra.status || extra.risk}] ${extra.reason}`);
    console.log(`   ${compact(finding.text)}`);
  });
}

const active = activeRuntimeRecords();
const runtimeWeeklyCost = active.reduce((sum, record) => sum + (Number(record.sumBilledWeekly ?? record.totalRouteCost) || 0), 0);
const runtimeAnnualCost = runtimeWeeklyCost * 48;
const runtimeCases = active.reduce((sum, record) => sum + (Number(record.weeklyCases) || 0), 0);
const runtimeStoredPallets = active.reduce((sum, record) => sum + (Number(record.weeklyPallets) || 0), 0);
const runtimeCalculatedPallets = runtimeCases / EXPECTED.casesPerPallet;
const palletMismatches = active.filter((record) => !closeEnough(Number(record.weeklyPallets) || 0, (Number(record.weeklyCases) || 0) / EXPECTED.casesPerPallet, 0.05));

const palletFindings = findOccurrences([/weeklyPallets/, /r\.weeklyPallets/, /sumField\(['"]weeklyPallets['"]\)/]).map((finding) => ({ ...finding, ...classifyPalletFinding(finding) }));
const mileageFindings = findOccurrences([/Current Source Miles/, /currentMiles/, /weeklyMiles/, /newMiles/, /proposedScenarioMiles/, /Miles Saved/]).map((finding) => ({ ...finding, ...classifyMileageFinding(finding) }));
const costFindings = findOccurrences([/totalRouteCost/, /sumBilledWeekly/, /381925/, /364011/]).map((finding) => ({ ...finding, ...classifyCostFinding(finding) }));

const unsafePallets = palletFindings.filter((finding) => finding.status === 'unsafe');
const highMileage = mileageFindings.filter((finding) => finding.risk === 'high');
const riskyCosts = costFindings.filter((finding) => finding.risk === 'high' || finding.risk === 'needs review');

console.log('# Network Map KPI Audit');
console.log(`Audited file: public/network-map.html`);
console.log(`Runtime data: lib/data/records.json`);
console.log('\n## Baseline check result');
console.log(`Active centers: ${active.length} (${active.length === EXPECTED.activeCenters ? 'PASS' : `FAIL expected ${EXPECTED.activeCenters}`})`);
console.log(`Weekly cost from active runtime rows: ${money(runtimeWeeklyCost)} (${closeEnough(runtimeWeeklyCost, EXPECTED.weeklyCost) ? 'PASS' : `FAIL expected ${money(EXPECTED.weeklyCost)}`})`);
console.log(`Annual cost from active runtime rows: ${money(runtimeAnnualCost)} (${closeEnough(runtimeAnnualCost, EXPECTED.annualCost) ? 'PASS' : `FAIL expected ${money(EXPECTED.annualCost)}`})`);
console.log(`Pallet rule check: cases / 70 = ${round(runtimeCalculatedPallets, 2)} pallets; stored weeklyPallets sum = ${round(runtimeStoredPallets, 2)} (${palletMismatches.length ? `FAIL ${palletMismatches.length} active records differ` : 'PASS'})`);
console.log('Note: if hidden-row visibility is not present in runtime JSON, active visible RFQ baseline cannot be independently proven from records.json alone.');

printFindings('Unsafe pallet calculation locations (top 30)', palletFindings, (finding) => finding, (finding) => finding.status === 'unsafe');
printFindings('Pallet calculations needing review (top 30)', palletFindings, (finding) => finding, (finding) => finding.status === 'needs review');
printFindings('Mileage comparison risks (top 30)', mileageFindings, (finding) => finding, (finding) => finding.risk === 'high' || finding.risk === 'needs review');
printFindings('Cost baseline risks (top 30)', costFindings, (finding) => finding, (finding) => finding.risk === 'high' || finding.risk === 'needs review');

console.log('\n## Recommended next fix list');
const fixes = [];
if (active.length !== EXPECTED.activeCenters || !closeEnough(runtimeWeeklyCost, EXPECTED.weeklyCost)) fixes.push('Add/consume an active-visible RFQ flag or regenerated active dataset so network-map baseline excludes hidden OPEN rows and reconciles to $364,011.36 weekly.');
if (palletMismatches.length || unsafePallets.length) fixes.push('For RFQ capacity/trailer utilization, replace stored weeklyPallets rollups with weeklyCases / 70 at route/group calculation boundaries.');
if (highMileage.length || mileageFindings.length) fixes.push('Prevent savings from comparing workbook source miles against proposed routed miles unless mileageBasisStatus is Comparable.');
if (riskyCosts.length) fixes.push('Ensure totalRouteCost/sumBilledWeekly baseline rollups filter to active visible RFQ rows and never use all-row $381,925.48 diagnostic total.');
fixes.push('Keep network-map labels explicit: Current Source Miles are workbook/source miles; Proposed Scenario Miles are routed/model miles and require routing validation.');
fixes.slice(0, LIMIT).forEach((fix, index) => console.log(`${index + 1}. ${fix}`));

console.log('\n## Summary counts');
console.log(`Unsafe pallet findings: ${unsafePallets.length}`);
console.log(`Mileage high-risk findings: ${highMileage.length}`);
console.log(`Cost baseline risk findings: ${riskyCosts.length}`);
