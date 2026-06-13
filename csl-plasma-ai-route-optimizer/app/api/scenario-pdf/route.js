import { buildCurrentNetworkBaseline, buildScenarioBriefData } from '../../../lib/aiOptimizer.js';

const ACTIVE_RFQ_BASELINE = {
  activeCenters: 296,
  weeklyCost: 364011.36,
  annualCost: 17472545.31,
  weeklyCases: 35439.52,
  weeklyLiters: 408533.22,
  weeklyMiles: 40429.02,
  casesPerPallet: 70,
  reefer48FootPallets: 24
};

function money(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function num(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function palletsFromCases(cases = 0) {
  return (Number(cases) || 0) / ACTIVE_RFQ_BASELINE.casesPerPallet;
}

function opportunity(current, proposed) {
  return (Number(current) || 0) - (Number(proposed) || 0);
}

function td(value, className = '') {
  return `<td${className ? ` class="${className}"` : ''}>${esc(value)}</td>`;
}

function currentPlcForRoute(row, routeLookup) {
  if (routeLookup.has(row.route)) return routeLookup.get(row.route).currentEndpointPLC;
  const source = [...routeLookup.values()].find((route) => String(row.route || '').startsWith(route.routeName));
  return source?.currentEndpointPLC || 'Current baseline PLC requires validation';
}

function routeRows(routeComparison, routeLookup) {
  return (routeComparison || []).map((row) => {
    const weeklyOpportunity = opportunity(row.currentCost, row.proposedCost);
    const cases = Number(row.currentCases || row.proposedCases || 0);
    const pallets = palletsFromCases(cases);
    const utilization = pallets / ACTIVE_RFQ_BASELINE.reefer48FootPallets * 100;
    return `<tr>
      ${td(row.route)}
      ${td(currentPlcForRoute(row, routeLookup))}
      ${td(`${row.route} / ${row.plc || 'Scenario PLC requires validation'}`)}
      ${td(num(row.currentMiles))}
      ${td(num(row.proposedMiles))}
      ${td(money(row.currentCost), 'money')}
      ${td(money(row.proposedCost), 'money')}
      ${td(money(weeklyOpportunity), 'money')}
      ${td(money(weeklyOpportunity * 52), 'money')}
      ${td(num(cases))}
      ${td(num(pallets))}
      ${td(`${num(utilization)}%`)}
    </tr>`;
  }).join('');
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'Max Savings Optimization';
  const brief = buildScenarioBriefData(mode);
  const s = brief.scenario;
  const generatedAt = new Date(brief.generatedAt || Date.now()).toLocaleString('en-US');
  const routeLookup = new Map(buildCurrentNetworkBaseline().routeGroups.map((route) => [route.routeName, route]));
  const weeklyOpportunity = Number(s.weeklyScenarioSavings) || 0;
  const proposedWeeklyCost = ACTIVE_RFQ_BASELINE.weeklyCost - weeklyOpportunity;
  const proposedAnnualCost = ACTIVE_RFQ_BASELINE.annualCost - weeklyOpportunity * 52;
  const proposedWeeklyMiles = ACTIVE_RFQ_BASELINE.weeklyMiles + (Number(s.deltaTotals?.weeklyMiles) || 0);
  const proposedWeeklyCases = ACTIVE_RFQ_BASELINE.weeklyCases + (Number(s.deltaTotals?.weeklyCases) || 0);
  const baselinePallets = palletsFromCases(ACTIVE_RFQ_BASELINE.weeklyCases);
  const proposedPallets = palletsFromCases(proposedWeeklyCases);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.scenarioName)} Scenario Report</title><style>
    :root{--ink:#111827;--muted:#475569;--line:#dbe3ef;--soft:#f8fafc;--brand:#1d4ed8}
    *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:var(--ink);margin:28px;line-height:1.4;background:#fff}
    .print-button{border:1px solid var(--brand);background:var(--brand);color:#fff;border-radius:6px;padding:9px 12px;font-weight:700;margin-bottom:18px}
    header{border-bottom:3px solid var(--brand);padding-bottom:14px;margin-bottom:18px}h1{font-size:28px;margin:0 0 6px}h2{font-size:17px;margin:24px 0 8px;color:#0f172a}.status{display:inline-block;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:999px;padding:5px 9px;font-weight:700;font-size:12px}
    .summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.metric{border:1px solid var(--line);background:var(--soft);padding:10px;border-radius:6px}.metric span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.metric b{display:block;font-size:18px;margin-top:3px}
    table{width:100%;border-collapse:collapse;font-size:11px;margin:8px 0 16px}th,td{border:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}th{background:#eef2ff;color:#1e3a8a}.money{text-align:right;white-space:nowrap}.notes li{margin-bottom:5px}.small{font-size:11px;color:var(--muted)}.page-break{break-before:page}
    @media print{body{margin:16mm}.print-button{display:none}.page-break{break-before:page}a{color:inherit;text-decoration:none}}
  </style></head><body>
  <button class="print-button" onclick="window.print()">Print / Save as PDF</button>

  <header>
    <h1>${esc(s.scenarioName)}</h1>
    <div class="small">Generated date: ${esc(generatedAt)}</div>
    <div class="status">Directional estimate — requires McKesson / RFQ validation</div>
  </header>

  <section>
    <h2>Executive Summary</h2>
    <div class="summary">
      <div class="metric"><span>Active RFQ centers</span><b>${num(ACTIVE_RFQ_BASELINE.activeCenters)}</b></div>
      <div class="metric"><span>Weekly baseline cost</span><b>${money(ACTIVE_RFQ_BASELINE.weeklyCost)}</b></div>
      <div class="metric"><span>Annual baseline cost</span><b>${money(ACTIVE_RFQ_BASELINE.annualCost)}</b></div>
      <div class="metric"><span>Weekly cases</span><b>${num(ACTIVE_RFQ_BASELINE.weeklyCases)}</b></div>
      <div class="metric"><span>Weekly pallets = cases / 70</span><b>${num(baselinePallets)}</b></div>
      <div class="metric"><span>Estimated annual opportunity</span><b>${money(s.annualScenarioSavings)}</b></div>
    </div>
  </section>

  <section>
    <h2>Current vs Proposed Totals</h2>
    <table><thead><tr><th>Metric</th><th>Current Active RFQ Baseline</th><th>Proposed Scenario</th><th>Opportunity / Delta</th></tr></thead><tbody>
      <tr><td>Weekly cost</td><td class="money">${money(ACTIVE_RFQ_BASELINE.weeklyCost)}</td><td class="money">${money(proposedWeeklyCost)}</td><td class="money">${money(weeklyOpportunity)}</td></tr>
      <tr><td>Annual cost</td><td class="money">${money(ACTIVE_RFQ_BASELINE.annualCost)}</td><td class="money">${money(proposedAnnualCost)}</td><td class="money">${money(s.annualScenarioSavings)}</td></tr>
      <tr><td>Weekly miles</td><td>${num(ACTIVE_RFQ_BASELINE.weeklyMiles)}</td><td>${num(proposedWeeklyMiles)}</td><td>Directional estimate — mileage basis differs and requires validation</td></tr>
      <tr><td>Weekly cases</td><td>${num(ACTIVE_RFQ_BASELINE.weeklyCases)}</td><td>${num(proposedWeeklyCases)}</td><td>${num(Number(s.deltaTotals?.weeklyCases) || 0)}</td></tr>
      <tr><td>Weekly pallets</td><td>${num(baselinePallets)}</td><td>${num(proposedPallets)}</td><td>Pallets use cases / 70</td></tr>
      <tr><td>Weekly opportunity</td><td></td><td></td><td class="money">${money(weeklyOpportunity)}</td></tr>
      <tr><td>Annual opportunity</td><td></td><td></td><td class="money">${money(s.annualScenarioSavings)}</td></tr>
    </tbody></table>
  </section>

  <section class="page-break">
    <h2>Route-by-Route Comparison</h2>
    <table><thead><tr>
      <th>Route name</th><th>Current PLC</th><th>Proposed route / PLC</th><th>Workbook Allocated Source Miles</th><th>Scenario Routed Miles</th><th>Current weekly cost</th><th>Proposed weekly cost</th><th>Weekly opportunity</th><th>Annual opportunity</th><th>Weekly cases</th><th>Weekly pallets</th><th>Pallet utilization using 24-pallet 48-ft capacity</th>
    </tr></thead><tbody>${routeRows(s.routeComparison, routeLookup) || '<tr><td colspan="12">No route comparison rows available.</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Validation Notes</h2>
    <ul class="notes">
      <li>Savings are directional, not guaranteed.</li>
      <li>Current miles and proposed miles may use different basis.</li>
      <li>McKesson validation required.</li>
      <li>RFQ / contract validation required.</li>
      <li>Cold-chain and site storage validation required for frequency changes.</li>
    </ul>
    <p class="small">Pallets are calculated as weekly cases / 70. Capacity uses 24 pallets for a 48-ft reefer. This report is print-ready HTML; use browser Print and Save as PDF.</p>
  </section>
  </body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
