import { buildCurrentNetworkBaseline, buildScenarioBriefData } from '../../../lib/aiOptimizer.js';

const ACTIVE_RFQ_BASELINE = {
  activeCenters: 296,
  weeklyCost: 364011.36,
  monthlyCost: 1456045.44,
  annualCost: 17472545.31,
  weeklyCases: 35439.52,
  weeklyLiters: 408533.22,
  weeklyMiles: 40429.02,
  casesPerPallet: 70,
  reefer48FootPallets: 24
};

const TOTALS_UNAVAILABLE = 'Scenario totals unavailable — run/load Optimization Engine route groups first.';

function money(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function moneyOrMessage(value, message = 'Unavailable') {
  return Number.isFinite(value) ? money(value) : message;
}

function num(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function numOrMessage(value, message = 'Unavailable') {
  return Number.isFinite(value) ? num(value) : message;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function paramNumber(searchParams, key) {
  const raw = searchParams.get(key);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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

function centerKey(value) {
  return String(value ?? '').trim();
}

function unavailable(value) {
  return value === null || value === undefined || value === '' ? 'Unavailable' : value;
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
    const proposedOnly = (Number(row.currentCost) || 0) <= 0 || (Number(row.currentMiles) || 0) <= 0;
    const proposedRouteLabel = `${row.route} / ${row.plc || 'Scenario PLC requires validation'}${proposedOnly ? ' — Proposed-only / paired route impact — not standalone portfolio savings' : ''}`;
    return `<tr>
      ${td(row.route)}
      ${td(currentPlcForRoute(row, routeLookup))}
      ${td(proposedRouteLabel)}
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

function baselineNodeLookup(nodes = []) {
  const lookup = new Map();
  for (const node of nodes || []) {
    const keys = [node.centerNumber, node.id, node.centerName].map(centerKey).filter(Boolean);
    for (const key of keys) if (!lookup.has(key)) lookup.set(key, node);
  }
  return lookup;
}

function frequencyChangeLookup(changes = []) {
  const lookup = new Map();
  for (const row of changes || []) {
    const keys = [row.centerNumber, row.id, row.centerName].map(centerKey).filter(Boolean);
    for (const key of keys) if (!lookup.has(key)) lookup.set(key, row);
  }
  return lookup;
}

function assignmentStatus({ node, proposedPLC, proposedRoute, proposedFrequency }) {
  const statuses = [];
  if (!node) statuses.push('New proposed route / paired route impact');
  if (node && proposedPLC && proposedPLC !== node.currentPLC) statuses.push('PLC reassigned');
  if (node && proposedRoute && proposedRoute !== node.currentRoute) statuses.push('Route reassigned');
  if (node && proposedFrequency && proposedFrequency !== node.currentPickupFrequency) statuses.push('Requires validation');
  return statuses.length ? statuses.join('; ') : 'Unchanged';
}

function buildAssignmentDetails(routeStopSequences = [], nodes = [], frequencyChanges = []) {
  const nodeLookup = baselineNodeLookup(nodes);
  const freqLookup = frequencyChangeLookup(frequencyChanges);
  const rows = [];
  for (const route of routeStopSequences || []) {
    for (const stop of route.stops || []) {
      const node = nodeLookup.get(centerKey(stop.centerNumber)) || nodeLookup.get(centerKey(stop.centerName));
      const freqChange = freqLookup.get(centerKey(stop.centerNumber)) || freqLookup.get(centerKey(stop.centerName));
      const weeklyCases = Number(stop.casesWeek ?? node?.weeklyCases ?? freqChange?.currentWeeklyCases ?? 0);
      const proposedFrequency = freqChange?.proposedPickupFrequency || stop.frequency || node?.currentPickupFrequency || '';
      rows.push({
        centerName: stop.centerName || node?.centerName || 'Unavailable',
        centerId: stop.centerNumber || node?.centerNumber || node?.id || 'Unavailable',
        city: stop.city || node?.city || 'Unavailable',
        state: stop.state || node?.state || 'Unavailable',
        currentPLC: node?.currentPLC || freqChange?.currentPLC || 'Unavailable',
        proposedPLC: route.proposedPLC || freqChange?.proposedPLC || 'Requires validation',
        currentRoute: node?.currentRoute || freqChange?.currentRoute || 'Unavailable',
        proposedRoute: route.routeName || freqChange?.proposedRoute || 'Requires validation',
        pickupFrequency: proposedFrequency || 'Unavailable',
        weeklyCases,
        weeklyPallets: palletsFromCases(weeklyCases),
        assignmentStatus: assignmentStatus({ node, proposedPLC: route.proposedPLC, proposedRoute: route.routeName, proposedFrequency })
      });
    }
  }
  return rows;
}

function assignmentDetailRows(rows = []) {
  if (!rows.length) return '<tr><td colspan="12">Center-level proposed assignment details unavailable for this scenario output.</td></tr>';
  return rows.map((row) => `<tr>
    ${td(row.centerName)}
    ${td(row.centerId)}
    ${td(row.city)}
    ${td(row.state)}
    ${td(row.currentPLC)}
    ${td(row.proposedPLC)}
    ${td(row.currentRoute)}
    ${td(row.proposedRoute)}
    ${td(row.pickupFrequency)}
    ${td(num(row.weeklyCases))}
    ${td(num(row.weeklyPallets))}
    ${td(row.assignmentStatus)}
  </tr>`).join('');
}

function plcReassignmentRows(rows = []) {
  const changed = (rows || []).filter((row) => row && row.currentPLC !== row.proposedPLC);
  if (!changed.length) return '<tr><td colspan="9">No PLC reassignment details available for this scenario output.</td></tr>';
  return changed.map((row) => {
    const weeklyCases = Number(row.currentWeeklyCases || row.proposedWeeklyCases || 0);
    return `<tr>
      ${td(`${row.centerNumber || ''} ${row.centerName || ''}`.trim() || 'Unavailable')}
      ${td(`${unavailable(row.city)}, ${unavailable(row.state)}`)}
      ${td(unavailable(row.currentPLC))}
      ${td(unavailable(row.proposedPLC))}
      ${td(unavailable(row.currentRoute))}
      ${td(unavailable(row.proposedRoute))}
      ${td(num(weeklyCases))}
      ${td(num(palletsFromCases(weeklyCases)))}
      ${td(row.reason || 'Requires McKesson / RFQ validation')}
    </tr>`;
  }).join('');
}

function frequencyChangeRows(rows = []) {
  const changed = (rows || []).filter((row) => row && row.currentPickupFrequency !== row.proposedPickupFrequency);
  if (!changed.length) return '<tr><td colspan="7">Frequency change details unavailable — current frequency shown only.</td></tr>';
  return changed.map((row) => {
    const weeklyCases = Number(row.currentWeeklyCases || row.proposedWeeklyCases || 0);
    return `<tr>
      ${td(`${row.centerNumber || ''} ${row.centerName || ''}`.trim() || 'Unavailable')}
      ${td(`${unavailable(row.city)}, ${unavailable(row.state)}`)}
      ${td(unavailable(row.currentPickupFrequency))}
      ${td(unavailable(row.proposedPickupFrequency))}
      ${td(num(weeklyCases))}
      ${td(num(palletsFromCases(weeklyCases)))}
      ${td(row.reason || 'Requires pickup frequency, cold-chain, storage, and McKesson validation')}
    </tr>`;
  }).join('');
}

function routeStopSequenceRows(routeStopSequences = []) {
  const rows = [];
  for (const route of routeStopSequences || []) {
    const stops = (route.stops || []).slice();
    const hasStopOrder = stops.some((stop) => Number.isFinite(Number(stop.stopNumber)));
    stops.sort((a, b) => {
      if (hasStopOrder) return (Number(a.stopNumber) || 9999) - (Number(b.stopNumber) || 9999);
      return `${a.state || ''}|${a.city || ''}|${a.centerName || ''}`.localeCompare(`${b.state || ''}|${b.city || ''}|${b.centerName || ''}`);
    });
    for (const stop of stops) {
      const weeklyCases = Number(stop.casesWeek || 0);
      rows.push(`<tr>
        ${td(route.routeName || 'Unavailable')}
        ${td(route.proposedPLC || 'Requires validation')}
        ${td(hasStopOrder ? stop.stopNumber : 'Stop order unavailable — sorted for review only')}
        ${td(`${stop.centerNumber || ''} ${stop.centerName || ''}`.trim() || 'Unavailable')}
        ${td(`${unavailable(stop.city)}, ${unavailable(stop.state)}`)}
        ${td(unavailable(stop.frequency))}
        ${td(num(weeklyCases))}
        ${td(num(palletsFromCases(weeklyCases)))}
        ${td(numOrMessage(Number(stop.oneWayMiles), 'Unavailable'))}
        ${td(moneyOrMessage(Number(stop.costWeek), 'Unavailable'), 'money')}
      </tr>`);
    }
  }
  return rows.join('') || '<tr><td colspan="10">Route stop sequence details unavailable for this scenario output.</td></tr>';
}

function optimizationTotals(searchParams) {
  if (searchParams.get('source') !== 'optimization') return null;
  if (searchParams.get('totalsAvailable') !== 'true') return { available: false };

  const weeklyOpportunity = paramNumber(searchParams, 'weeklyOpportunity');
  const annualOpportunity = paramNumber(searchParams, 'annualOpportunity');
  const currentWeeklyCost = paramNumber(searchParams, 'currentWeeklyCost');
  const proposedWeeklyCost = paramNumber(searchParams, 'proposedWeeklyCost');
  const currentAnnualCost = paramNumber(searchParams, 'currentAnnualCost') ?? (currentWeeklyCost === null ? null : currentWeeklyCost * 52);
  const proposedAnnualCost = paramNumber(searchParams, 'proposedAnnualCost') ?? (proposedWeeklyCost === null ? null : proposedWeeklyCost * 52);
  return {
    available: true,
    scope: searchParams.get('scope') || 'visible-route-groups',
    routeCount: paramNumber(searchParams, 'routeCount'),
    weeklyOpportunity,
    annualOpportunity,
    currentWeeklyCost,
    proposedWeeklyCost,
    currentAnnualCost,
    proposedAnnualCost,
    currentWeeklyMiles: paramNumber(searchParams, 'currentWeeklyMiles'),
    proposedWeeklyMiles: paramNumber(searchParams, 'proposedWeeklyMiles'),
    weeklyCases: paramNumber(searchParams, 'weeklyCases'),
    proposedWeeklyCases: paramNumber(searchParams, 'proposedWeeklyCases'),
    weeklyPallets: paramNumber(searchParams, 'weeklyPallets'),
    proposedWeeklyPallets: paramNumber(searchParams, 'proposedWeeklyPallets')
  };
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'Max Savings Optimization';
  const brief = buildScenarioBriefData(mode);
  const s = brief.scenario;
  const generatedAt = new Date(brief.generatedAt || Date.now()).toLocaleString('en-US');
  const baseline = buildCurrentNetworkBaseline();
  const routeLookup = new Map(baseline.routeGroups.map((route) => [route.routeName, route]));
  const assignmentDetails = buildAssignmentDetails(brief.routeStopSequences || s.proposedStopSequences, baseline.nodes, brief.frequencyChanges || s.centersChangedFrequency);
  const optTotals = optimizationTotals(searchParams);
  const isOptimizationReport = optTotals !== null;
  const hasOptimizationTotals = Boolean(optTotals?.available);

  const report = hasOptimizationTotals ? {
    currentWeeklyCost: optTotals.currentWeeklyCost,
    proposedWeeklyCost: optTotals.proposedWeeklyCost,
    currentAnnualCost: optTotals.currentAnnualCost,
    proposedAnnualCost: optTotals.proposedAnnualCost,
    weeklyOpportunity: optTotals.weeklyOpportunity,
    annualOpportunity: optTotals.annualOpportunity,
    currentWeeklyMiles: optTotals.currentWeeklyMiles,
    proposedWeeklyMiles: optTotals.proposedWeeklyMiles,
    weeklyCases: optTotals.weeklyCases,
    proposedWeeklyCases: optTotals.proposedWeeklyCases,
    weeklyPallets: optTotals.weeklyPallets,
    proposedWeeklyPallets: optTotals.proposedWeeklyPallets,
    opportunityDisplay: moneyOrMessage(optTotals.annualOpportunity, TOTALS_UNAVAILABLE),
    weeklyOpportunityDisplay: moneyOrMessage(optTotals.weeklyOpportunity, TOTALS_UNAVAILABLE)
  } : isOptimizationReport ? {
    currentWeeklyCost: null,
    proposedWeeklyCost: null,
    currentAnnualCost: null,
    proposedAnnualCost: null,
    weeklyOpportunity: null,
    annualOpportunity: null,
    currentWeeklyMiles: null,
    proposedWeeklyMiles: null,
    weeklyCases: null,
    proposedWeeklyCases: null,
    weeklyPallets: null,
    proposedWeeklyPallets: null,
    opportunityDisplay: TOTALS_UNAVAILABLE,
    weeklyOpportunityDisplay: TOTALS_UNAVAILABLE
  } : {
    currentWeeklyCost: ACTIVE_RFQ_BASELINE.weeklyCost,
    proposedWeeklyCost: null,
    currentAnnualCost: ACTIVE_RFQ_BASELINE.annualCost,
    proposedAnnualCost: null,
    weeklyOpportunity: null,
    annualOpportunity: null,
    currentWeeklyMiles: ACTIVE_RFQ_BASELINE.weeklyMiles,
    proposedWeeklyMiles: null,
    weeklyCases: ACTIVE_RFQ_BASELINE.weeklyCases,
    proposedWeeklyCases: null,
    weeklyPallets: palletsFromCases(ACTIVE_RFQ_BASELINE.weeklyCases),
    proposedWeeklyPallets: null,
    opportunityDisplay: TOTALS_UNAVAILABLE,
    weeklyOpportunityDisplay: TOTALS_UNAVAILABLE
  };

  const scenarioName = isOptimizationReport ? 'Optimization Engine Scenario Report' : s.scenarioName;
  const baselinePallets = palletsFromCases(ACTIVE_RFQ_BASELINE.weeklyCases);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(scenarioName)} Scenario Report</title><style>
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
    <h1>${esc(scenarioName)}</h1>
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
      <div class="metric"><span>Estimated annual opportunity</span><b>${esc(report.opportunityDisplay)}</b></div>
    </div>
    ${isOptimizationReport ? `<p class="small">Scenario report totals source: Optimization Engine visible summary${hasOptimizationTotals && optTotals.routeCount !== null ? ` (${num(optTotals.routeCount)} route group${optTotals.routeCount === 1 ? '' : 's'})` : ''}.</p>` : ''}
  </section>

  <section>
    <h2>Current vs Proposed Totals</h2>
    <table><thead><tr><th>Metric</th><th>Current Visible Scenario Total</th><th>Proposed Visible Scenario Total</th><th>Opportunity / Delta</th></tr></thead><tbody>
      <tr><td>Weekly cost</td><td class="money">${moneyOrMessage(report.currentWeeklyCost, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td class="money">${moneyOrMessage(report.proposedWeeklyCost, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td class="money">${esc(report.weeklyOpportunityDisplay)}</td></tr>
      <tr><td>Annual cost</td><td class="money">${moneyOrMessage(report.currentAnnualCost, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td class="money">${moneyOrMessage(report.proposedAnnualCost, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td class="money">${esc(report.opportunityDisplay)}</td></tr>
      <tr><td>Weekly miles</td><td>${numOrMessage(report.currentWeeklyMiles, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${numOrMessage(report.proposedWeeklyMiles, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>Directional estimate — mileage basis differs and requires validation</td></tr>
      <tr><td>Weekly cases</td><td>${numOrMessage(report.weeklyCases, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${numOrMessage(report.proposedWeeklyCases, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${isOptimizationReport ? 'Matches Optimization Engine visible route universe when available' : num(Number(s.deltaTotals?.weeklyCases) || 0)}</td></tr>
      <tr><td>Weekly pallets</td><td>${numOrMessage(report.weeklyPallets, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${numOrMessage(report.proposedWeeklyPallets, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>Pallets use cases / 70</td></tr>
      <tr><td>Weekly opportunity</td><td></td><td></td><td class="money">${esc(report.weeklyOpportunityDisplay)}</td></tr>
      <tr><td>Annual opportunity</td><td></td><td></td><td class="money">${esc(report.opportunityDisplay)}</td></tr>
    </tbody></table>
  </section>

  <section class="page-break">
    <h2>Route-by-Route Comparison</h2>
    <table><thead><tr>
      <th>Route name</th><th>Current PLC</th><th>Proposed route / PLC</th><th>Workbook Allocated Source Miles</th><th>Scenario Routed Miles</th><th>Current weekly cost</th><th>Proposed weekly cost</th><th>Weekly opportunity</th><th>Annual opportunity</th><th>Weekly cases</th><th>Weekly pallets</th><th>Pallet utilization using 24-pallet 48-ft capacity</th>
    </tr></thead><tbody>${routeRows(s.routeComparison, routeLookup) || '<tr><td colspan="12">No route comparison rows available.</td></tr>'}</tbody></table>
  </section>

  <section class="page-break">
    <h2>Center-to-PLC / Route Assignment Detail</h2>
    <p class="small">Which plasma center goes where. Weekly pallets are calculated as weekly cases / 70. Missing proposed fields are shown as Unavailable or Requires validation.</p>
    <table><thead><tr>
      <th>Center name</th><th>Center ID</th><th>City</th><th>State</th><th>Current PLC</th><th>Proposed PLC</th><th>Current route / McKesson route</th><th>Proposed route</th><th>Pickup frequency</th><th>Weekly cases</th><th>Weekly pallets = weekly cases / 70</th><th>Assignment status</th>
    </tr></thead><tbody>${assignmentDetailRows(assignmentDetails)}</tbody></table>
  </section>

  <section class="page-break">
    <h2>PLC Reassignments</h2>
    <table><thead><tr>
      <th>Center</th><th>City, State</th><th>From PLC</th><th>To PLC</th><th>Current route</th><th>Proposed route</th><th>Weekly cases</th><th>Weekly pallets</th><th>Validation status</th>
    </tr></thead><tbody>${plcReassignmentRows(brief.plcReassignments || s.centersReassignedPLC)}</tbody></table>
  </section>

  <section>
    <h2>Frequency Changes</h2>
    <table><thead><tr>
      <th>Center</th><th>City, State</th><th>Current frequency</th><th>Proposed frequency</th><th>Weekly cases</th><th>Weekly pallets</th><th>Validation note</th>
    </tr></thead><tbody>${frequencyChangeRows(brief.frequencyChanges || s.centersChangedFrequency)}</tbody></table>
  </section>

  <section class="page-break">
    <h2>Route Stop Sequences</h2>
    <table><thead><tr>
      <th>Proposed route name</th><th>Proposed PLC</th><th>Stop order</th><th>Center</th><th>City, State</th><th>Frequency</th><th>Weekly cases</th><th>Weekly pallets</th><th>Workbook/source one-way miles</th><th>Estimated weekly cost</th>
    </tr></thead><tbody>${routeStopSequenceRows(brief.routeStopSequences || s.proposedStopSequences)}</tbody></table>
  </section>

  <section>
    <h2>Validation Notes</h2>
    <ul class="notes">
      <li>Opportunities are directional estimates and require McKesson / RFQ validation.</li>
      <li>Current miles and proposed miles may use different basis.</li>
      <li>McKesson validation required.</li>
      <li>RFQ / contract validation required.</li>
      <li>Cold-chain and site storage validation required for frequency changes.</li>
      ${isOptimizationReport ? '<li>Portfolio opportunity totals come from the Optimization Engine visible summary when available; route rows with $0.00 current cost remain row-level estimates and are not recomputed into a separate portfolio total in this report.</li>' : ''}
    </ul>
    <p class="small">Pallets are calculated as weekly cases / 70. Capacity uses 24 pallets for a 48-ft reefer. This report is print-ready HTML; use browser Print and Save as PDF.</p>
  </section>
  </body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
