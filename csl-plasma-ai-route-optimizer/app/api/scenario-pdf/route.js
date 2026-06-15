import { buildCurrentNetworkBaseline, buildScenarioBriefData } from '../../../lib/aiOptimizer.js';

const ACTIVE_RFQ_BASELINE = {
  activeCenters: 296,
  weeklyCost: 364011.36,
  monthlyCost: 1456045.44,
  annualCost: 17472545.31,
  annualizationWeeks: 48,
  monthlyMultiplier: 4,
  annualMonths: 12,
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

function pctOrUnavailable(value, total) {
  const v = Number(value);
  const t = Number(total);
  return Number.isFinite(v) && Number.isFinite(t) && t > 0 ? `${num(v / t * 100)}%` : 'Unavailable';
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

function normalizeFrequency(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'W' || raw === 'WEEKLY') return 'Weekly (W)';
  if (raw === 'BW' || raw === 'BI-WEEKLY' || raw === 'BIWEEKLY' || raw === 'BI WEEKLY') return 'Bi-Weekly (BW)';
  return raw ? unavailable(value) : 'Unavailable';
}

function currentPlcForRoute(row, routeLookup) {
  if (routeLookup.has(row.route)) return routeLookup.get(row.route).currentEndpointPLC;
  const source = [...routeLookup.values()].find((route) => String(row.route || '').startsWith(route.routeName));
  return source?.currentEndpointPLC || 'Current baseline PLC review needed';
}

function routeRows(routeComparison, routeLookup) {
  return (routeComparison || []).map((row) => {
    const weeklyOpportunity = opportunity(row.currentCost, row.proposedCost);
    const cases = Number(row.currentCases || row.proposedCases || 0);
    const pallets = palletsFromCases(cases);
    const utilization = pallets / ACTIVE_RFQ_BASELINE.reefer48FootPallets * 100;
    const proposedOnly = (Number(row.currentCost) || 0) <= 0 || (Number(row.currentMiles) || 0) <= 0;
    const proposedRouteLabel = `${row.route} / ${row.plc || 'Scenario PLC review needed'}${proposedOnly ? ' — Proposed-only grouping' : ''}`;
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
  if (node && proposedFrequency && proposedFrequency !== node.currentPickupFrequency) statuses.push('Review needed');
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
        proposedPLC: route.proposedPLC || freqChange?.proposedPLC || 'Review needed',
        currentRoute: node?.currentRoute || freqChange?.currentRoute || 'Unavailable',
        proposedRoute: route.routeName || freqChange?.proposedRoute || 'Review needed',
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
  if (!changed.length) return '<tr><td colspan="8">No PLC reassignment details available for this scenario output.</td></tr>';
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
      ${td('Frequency change requires operational review')}
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
        ${td(route.proposedPLC || 'Review needed')}
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

function distributionSplitRows(nodes = [], assignmentDetails = [], routeComparison = []) {
  const currentCounts = new Map();
  const proposedCounts = new Map();
  const deltaByPlc = new Map();
  for (const node of nodes || []) {
    const plc = unavailable(node.currentPLC);
    currentCounts.set(plc, (currentCounts.get(plc) || 0) + 1);
  }
  for (const row of assignmentDetails || []) {
    const plc = unavailable(row.proposedPLC);
    proposedCounts.set(plc, (proposedCounts.get(plc) || 0) + 1);
  }
  for (const row of routeComparison || []) {
    const plc = unavailable(row.plc);
    const delta = Number(row.currentCost) - Number(row.proposedCost);
    if (Number.isFinite(delta)) deltaByPlc.set(plc, (deltaByPlc.get(plc) || 0) + delta);
  }
  const plcs = [...new Set([...currentCounts.keys(), ...proposedCounts.keys(), ...deltaByPlc.keys()])].filter(Boolean).sort();
  const currentTotal = [...currentCounts.values()].reduce((a, v) => a + v, 0);
  const proposedTotal = [...proposedCounts.values()].reduce((a, v) => a + v, 0);
  if (!plcs.length) return '<tr><td colspan="6">Unavailable</td></tr>';
  return plcs.map((plc) => {
    const current = currentCounts.get(plc);
    const proposed = proposedCounts.get(plc);
    const delta = deltaByPlc.has(plc) ? deltaByPlc.get(plc) : null;
    return `<tr>
      ${td(plc)}
      ${td(Number.isFinite(current) ? num(current) : 'Unavailable')}
      ${td(Number.isFinite(current) ? pctOrUnavailable(current, currentTotal) : 'Unavailable')}
      ${td(Number.isFinite(proposed) ? num(proposed) : 'Unavailable')}
      ${td(Number.isFinite(proposed) ? pctOrUnavailable(proposed, proposedTotal) : 'Unavailable')}
      ${td(delta === null ? 'Unavailable' : money(delta), 'money')}
    </tr>`;
  }).join('');
}

function pickupFrequencyRows(nodes = [], assignmentDetails = []) {
  const labels = ['Weekly (W)', 'Bi-Weekly (BW)'];
  const currentCounts = new Map(labels.map((label) => [label, 0]));
  const proposedCounts = new Map(labels.map((label) => [label, 0]));
  for (const node of nodes || []) {
    const label = normalizeFrequency(node.currentPickupFrequency);
    if (currentCounts.has(label)) currentCounts.set(label, currentCounts.get(label) + 1);
  }
  for (const row of assignmentDetails || []) {
    const label = normalizeFrequency(row.pickupFrequency);
    if (proposedCounts.has(label)) proposedCounts.set(label, proposedCounts.get(label) + 1);
  }
  return labels.map((label) => {
    const current = currentCounts.get(label);
    const proposed = proposedCounts.get(label);
    return `<tr>${td(label)}${td(num(current))}${td(num(proposed))}${td(num(proposed - current))}</tr>`;
  }).join('');
}

function allFrequencyChangeRows(rows = []) {
  const changed = (rows || []).filter((row) => row && row.currentPickupFrequency !== row.proposedPickupFrequency);
  if (!changed.length) return '<tr><td colspan="5">No frequency changes in this scenario.</td></tr>';
  return changed.map((row) => {
    const weeklyCases = Number(row.currentWeeklyCases || row.proposedWeeklyCases);
    const delta = Number.isFinite(Number(row.weeklyScenarioSavings))
      ? Number(row.weeklyScenarioSavings)
      : Number.isFinite(Number(row.currentWeeklyCost)) && Number.isFinite(Number(row.proposedWeeklyCost))
        ? Number(row.currentWeeklyCost) - Number(row.proposedWeeklyCost)
        : null;
    return `<tr>
      ${td(`${row.centerNumber || ''} ${row.centerName || ''}`.trim() || 'Unavailable')}
      ${td(unavailable(row.city))}
      ${td(Number.isFinite(weeklyCases) ? num(weeklyCases) : 'Unavailable')}
      ${td(`${unavailable(row.currentPickupFrequency)} → ${unavailable(row.proposedPickupFrequency)}`)}
      ${td(delta === null ? 'Unavailable' : money(delta), 'money')}
    </tr>`;
  }).join('');
}

function rerouteGroupBlocks(routeStopSequences = [], routeComparison = [], nodes = []) {
  if (!routeStopSequences.length) return '<p class="small">No reroute group details available for this scenario.</p>';
  const nodeLookup = baselineNodeLookup(nodes);
  const comparisonByRoute = new Map((routeComparison || []).map((row) => [row.route, row]));
  return routeStopSequences.map((route) => {
    const comparison = comparisonByRoute.get(route.routeName) || {};
    const stops = route.stops || [];
    const enriched = stops.map((stop) => {
      const node = nodeLookup.get(centerKey(stop.centerNumber)) || nodeLookup.get(centerKey(stop.centerName));
      const weeklyCases = Number(stop.casesWeek ?? node?.weeklyCases ?? 0);
      return { stop, node, weeklyCases };
    });
    const currentRoutes = [...new Set(enriched.map((row) => row.node?.currentRoute).filter(Boolean))];
    const currentPlcs = [...new Set(enriched.map((row) => row.node?.currentPLC).filter(Boolean))];
    const weeklyCases = Number(comparison.proposedCases ?? enriched.reduce((a, row) => a + (Number(row.weeklyCases) || 0), 0));
    const weeklyPallets = palletsFromCases(weeklyCases);
    const currentWeeklyCost = Number(comparison.currentCost);
    const proposedWeeklyCost = Number(comparison.proposedCost);
    const weeklyOpportunity = Number.isFinite(currentWeeklyCost) && Number.isFinite(proposedWeeklyCost) ? currentWeeklyCost - proposedWeeklyCost : null;
    const details = enriched.map(({ stop, node, weeklyCases: stopCases }) => `<tr>
      ${td(`${stop.centerNumber || node?.centerNumber || ''} ${stop.centerName || node?.centerName || ''}`.trim() || 'Unavailable')}
      ${td(`${unavailable(stop.city || node?.city)}, ${unavailable(stop.state || node?.state)}`)}
      ${td(unavailable(node?.currentRoute))}
      ${td(unavailable(route.routeName))}
      ${td(unavailable(node?.currentPLC))}
      ${td(unavailable(route.proposedPLC))}
      ${td(unavailable(node?.currentPickupFrequency))}
      ${td(unavailable(stop.frequency || node?.currentPickupFrequency))}
      ${td(num(stopCases))}
      ${td(num(palletsFromCases(stopCases)))}
      ${td(numOrMessage(Number(stop.oneWayMiles), 'Unavailable'))}
      ${td(moneyOrMessage(Number(stop.costWeek), 'Unavailable'), 'money')}
    </tr>`).join('');
    return `<div class="group-block keep-together">
      <h3>${esc(route.routeName || 'Unavailable')}</h3>
      <table><tbody>
        <tr><th>Proposed route group name</th>${td(route.routeName || 'Unavailable')}<th>Proposed PLC</th>${td(route.proposedPLC || 'Unavailable')}</tr>
        <tr><th>Current route(s) impacted</th>${td(currentRoutes.length ? currentRoutes.join(', ') : 'Unavailable')}<th>Current PLC(s)</th>${td(currentPlcs.length ? currentPlcs.join(', ') : 'Unavailable')}</tr>
        <tr><th>Center count</th>${td(num(stops.length))}<th>Weekly cases</th>${td(num(weeklyCases))}</tr>
        <tr><th>Weekly pallets = cases / 70</th>${td(num(weeklyPallets))}<th>Workbook Allocated Source Miles</th>${td(numOrMessage(Number(comparison.currentMiles), 'Unavailable'))}</tr>
        <tr><th>Scenario Routed Miles</th>${td(numOrMessage(Number(comparison.proposedMiles), 'Unavailable'))}<th>Current weekly cost</th>${td(moneyOrMessage(currentWeeklyCost, 'Unavailable'), 'money')}</tr>
        <tr><th>Proposed weekly cost</th>${td(moneyOrMessage(proposedWeeklyCost, 'Unavailable'), 'money')}<th>Weekly opportunity</th>${td(weeklyOpportunity === null ? 'Unavailable' : money(weeklyOpportunity), 'money')}</tr>
        <tr><th>Annual opportunity = weekly opportunity × 48</th>${td(weeklyOpportunity === null ? 'Unavailable' : money(weeklyOpportunity * ACTIVE_RFQ_BASELINE.annualizationWeeks), 'money')}<th>48-ft capacity = 24 pallets</th>${td('Applied')}</tr>
      </tbody></table>
      <table><thead><tr><th>Center</th><th>City, State</th><th>Current route</th><th>Proposed route</th><th>Current PLC</th><th>Proposed PLC</th><th>Current frequency</th><th>Proposed frequency</th><th>Weekly cases</th><th>Weekly pallets</th><th>One-way miles</th><th>Estimated stop-level cost allocation</th></tr></thead><tbody>${details || '<tr><td colspan="12">Unavailable</td></tr>'}</tbody></table>
    </div>`;
  }).join('');
}

function calculationValue(value, formatter = money) {
  return Number.isFinite(value) ? formatter(value) : 'Unavailable';
}

function calculationMethodRows(report) {
  const baselineWeekly = Number(ACTIVE_RFQ_BASELINE.weeklyCost);
  const currentWeekly = Number(report.currentWeeklyCost);
  const proposedWeekly = Number(report.proposedWeeklyCost);
  const proposedMiles = Number(report.proposedWeeklyMiles);
  const impliedRate = Number.isFinite(proposedWeekly) && Number.isFinite(proposedMiles) && proposedMiles > 0 ? proposedWeekly / proposedMiles : NaN;
  const weeklyOpportunity = Number(report.weeklyOpportunity);
  const weeklyCases = Number(report.weeklyCases);
  const weeklyPallets = Number.isFinite(Number(report.weeklyPallets)) ? Number(report.weeklyPallets) : (Number.isFinite(weeklyCases) ? palletsFromCases(weeklyCases) : NaN);
  const rows = [
    ['Annual Baseline Cost = Weekly Baseline Cost × 4 weeks × 12 months', `${money(baselineWeekly)} × ${ACTIVE_RFQ_BASELINE.monthlyMultiplier} × ${ACTIVE_RFQ_BASELINE.annualMonths} = ${money(ACTIVE_RFQ_BASELINE.annualCost)}`],
    ['Current Annual Cost = Active RFQ Weekly Baseline Cost × 48', Number.isFinite(currentWeekly) ? `${money(currentWeekly)} × ${ACTIVE_RFQ_BASELINE.annualizationWeeks} = ${money(ACTIVE_RFQ_BASELINE.annualCost)}` : 'Unavailable'],
    ['Proposed Visible Annual Cost = Proposed Visible Weekly Cost × 48', Number.isFinite(proposedWeekly) ? `${money(proposedWeekly)} × ${ACTIVE_RFQ_BASELINE.annualizationWeeks} = ${money(proposedWeekly * ACTIVE_RFQ_BASELINE.annualizationWeeks)}` : 'Unavailable'],
    ['Current Weekly Cost = Active RFQ Excel subtotal from AQ342', calculationValue(currentWeekly)],
    ['Proposed Visible Weekly Cost = Sum of visible Optimization Engine proposed weekly costs', calculationValue(proposedWeekly)],
    ['Proposed Weekly Cost basis', "Proposed visible weekly cost is the sum of proposed weekly costs from the Optimization Engine visible scenario table. Directional proposed route cost is based on scenario routed miles and implied scenario cost assumptions, then summed to the visible proposed weekly cost."],
    ['Implied Scenario $/Mile = Proposed Visible Weekly Cost ÷ Scenario Routed Miles', Number.isFinite(impliedRate) ? `${money(proposedWeekly)} ÷ ${num(proposedMiles)} = ${money(impliedRate)} per mile` : 'Unavailable'],
    ['Proposed Visible Weekly Cost = Scenario Routed Miles × Implied Scenario $/Mile', Number.isFinite(impliedRate) ? `${num(proposedMiles)} × ${money(impliedRate)} = ${money(proposedWeekly)}` : 'Unavailable'],
    ['Weekly Opportunity = Active RFQ Weekly Baseline Cost - Proposed Visible Weekly Cost', Number.isFinite(currentWeekly) && Number.isFinite(proposedWeekly) && Number.isFinite(weeklyOpportunity) ? `${money(currentWeekly)} - ${money(proposedWeekly)} = ${money(weeklyOpportunity)}` : 'Unavailable'],
    ['Annual Opportunity = Weekly Opportunity × 48', Number.isFinite(weeklyOpportunity) ? `${money(weeklyOpportunity)} × ${ACTIVE_RFQ_BASELINE.annualizationWeeks} = ${money(weeklyOpportunity * ACTIVE_RFQ_BASELINE.annualizationWeeks)}` : 'Unavailable'],
    ['Weekly Pallets = Weekly Cases ÷ 70', Number.isFinite(weeklyCases) ? `${num(weeklyCases)} ÷ 70 = ${num(palletsFromCases(weeklyCases))}` : 'Unavailable'],
    ['Estimated 48-ft Trailer Equivalents = Total Weekly Pallets ÷ 24', Number.isFinite(weeklyPallets) ? `${num(weeklyPallets)} ÷ 24 = ${num(weeklyPallets / ACTIVE_RFQ_BASELINE.reefer48FootPallets)}` : 'Unavailable'],
    ['Route Pallet Utilization = Route Weekly Pallets ÷ 24', 'Shown per route as route weekly pallets ÷ 24-pallet 48-ft capacity.']
  ];
  return rows.map(([label, value]) => `<tr>${td(label)}${td(value)}</tr>`).join('');
}

function optimizationTotals(searchParams) {
  if (searchParams.get('source') !== 'optimization') return null;
  if (searchParams.get('totalsAvailable') !== 'true') return { available: false };

  const currentWeeklyCost = ACTIVE_RFQ_BASELINE.weeklyCost;
  const proposedWeeklyCost = paramNumber(searchParams, 'proposedWeeklyCost');
  const weeklyOpportunity = proposedWeeklyCost === null ? null : currentWeeklyCost - proposedWeeklyCost;
  const annualOpportunity = weeklyOpportunity === null ? null : weeklyOpportunity * ACTIVE_RFQ_BASELINE.annualizationWeeks;
  const currentAnnualCost = ACTIVE_RFQ_BASELINE.annualCost;
  const proposedAnnualCost = paramNumber(searchParams, 'proposedAnnualCost') ?? (proposedWeeklyCost === null ? null : proposedWeeklyCost * ACTIVE_RFQ_BASELINE.annualizationWeeks);
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
    table{width:100%;border-collapse:collapse;font-size:11px;margin:8px 0 16px}th,td{border:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}th{background:#eef2ff;color:#1e3a8a}.money{text-align:right;white-space:nowrap}.notes li{margin-bottom:5px}.small{font-size:11px;color:var(--muted)}.page-break{break-before:page}.keep-together,.group-block{break-inside:avoid;page-break-inside:avoid}.group-block{margin:12px 0 18px}.group-block h3{font-size:13px;margin:10px 0 4px;color:#1e3a8a}
    @media print{body{margin:16mm}.print-button{display:none}.page-break{break-before:page}.keep-together{break-inside:avoid;page-break-inside:avoid}a{color:inherit;text-decoration:none}}
  </style></head><body>
  <button class="print-button" onclick="window.print()">Print / Save as PDF</button>

  <header>
    <h1>${esc(scenarioName)}</h1>
    <div class="small">Generated date: ${esc(generatedAt)}</div>
    <div class="status">Directional estimate</div>
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
      <tr><td>Weekly miles</td><td>${numOrMessage(report.currentWeeklyMiles, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${numOrMessage(report.proposedWeeklyMiles, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>Directional estimate — mileage basis differs and needs review</td></tr>
      <tr><td>Weekly cases</td><td>${numOrMessage(report.weeklyCases, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${numOrMessage(report.proposedWeeklyCases, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${isOptimizationReport ? 'Matches Optimization Engine visible route universe when available' : num(Number(s.deltaTotals?.weeklyCases) || 0)}</td></tr>
      <tr><td>Weekly pallets</td><td>${numOrMessage(report.weeklyPallets, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>${numOrMessage(report.proposedWeeklyPallets, isOptimizationReport ? TOTALS_UNAVAILABLE : 'Unavailable')}</td><td>Pallets use cases / 70</td></tr>
      <tr><td>Weekly opportunity</td><td></td><td></td><td class="money">${esc(report.weeklyOpportunityDisplay)}</td></tr>
      <tr><td>Annual opportunity</td><td></td><td></td><td class="money">${esc(report.opportunityDisplay)}</td></tr>
    </tbody></table>
  </section>

  <section class="keep-together">
    <h2>Calculation Method</h2>
    <table><thead><tr><th>Formula</th><th>Report values used</th></tr></thead><tbody>${calculationMethodRows(report)}</tbody></table>
  </section>

  <section class="keep-together">
    <h2>Distribution centers · Volume & cost split</h2>
    <table><thead><tr><th>PLC</th><th>Current centers</th><th>Current %</th><th>Proposed centers</th><th>Proposed %</th><th>Δ $/wk</th></tr></thead><tbody>${distributionSplitRows(baseline.nodes, assignmentDetails, s.routeComparison)}</tbody></table>
  </section>

  <section class="keep-together">
    <h2>Pickup frequency · centers</h2>
    <table><thead><tr><th>Frequency</th><th>Current</th><th>Proposed</th><th>Δ</th></tr></thead><tbody>${pickupFrequencyRows(baseline.nodes, assignmentDetails)}</tbody></table>
  </section>

  <section>
    <h2>Route-by-Route Comparison</h2>
    <p class="small">Rows marked Proposed-only / paired route impact are new proposed route groupings. Their negative row opportunity should not be read as standalone savings or cost increase. Portfolio opportunity comes from the Current vs Proposed visible totals.</p>
    <table><thead><tr>
      <th>Route name</th><th>Current PLC</th><th>Proposed route / PLC</th><th>Workbook Allocated Source Miles</th><th>Scenario Routed Miles</th><th>Current weekly cost</th><th>Proposed weekly cost</th><th>Weekly opportunity</th><th>Annual opportunity</th><th>Weekly cases</th><th>Weekly pallets</th><th>Pallet utilization using 24-pallet 48-ft capacity</th>
    </tr></thead><tbody>${routeRows(s.routeComparison, routeLookup) || '<tr><td colspan="12">No route comparison rows available.</td></tr>'}</tbody></table>
  </section>

  <section class="page-break">
    <h2>Center-to-PLC / Route Assignment Detail</h2>
    <p class="small">Which plasma center goes where. Weekly pallets are calculated as weekly cases / 70. Missing proposed fields are shown as Unavailable or Review needed.</p>
    <table><thead><tr>
      <th>Center name</th><th>Center ID</th><th>City</th><th>State</th><th>Current PLC</th><th>Proposed PLC</th><th>Current route / McKesson route</th><th>Proposed route</th><th>Pickup frequency</th><th>Weekly cases</th><th>Weekly pallets = weekly cases / 70</th><th>Assignment status</th>
    </tr></thead><tbody>${assignmentDetailRows(assignmentDetails)}</tbody></table>
  </section>

  <section class="page-break">
    <h2>PLC Reassignments</h2>
    <table><thead><tr>
      <th>Center</th><th>City, State</th><th>From PLC</th><th>To PLC</th><th>Current route</th><th>Proposed route</th><th>Weekly cases</th><th>Weekly pallets</th>
    </tr></thead><tbody>${plcReassignmentRows(brief.plcReassignments || s.centersReassignedPLC)}</tbody></table>
  </section>

  <section>
    <h2>Frequency changes · all centers</h2>
    <table><thead><tr>
      <th>Center</th><th>City</th><th>Cases/wk</th><th>From → To</th><th>Δ $/wk</th>
    </tr></thead><tbody>${allFrequencyChangeRows(brief.frequencyChanges || s.centersChangedFrequency)}</tbody></table>
  </section>

  <section class="page-break">
    <h2>Reroute group breakdown</h2>
    ${rerouteGroupBlocks(brief.routeStopSequences || s.proposedStopSequences, s.routeComparison, baseline.nodes)}
  </section>

  <section class="page-break">
    <h2>Route Stop Sequences</h2>
    <p class="small">Stop-level cost allocation is directional and may not sum exactly to route-level proposed weekly cost. Use route-level proposed weekly cost for portfolio comparison.</p>
    <table><thead><tr>
      <th>Proposed route name</th><th>Proposed PLC</th><th>Stop order</th><th>Center</th><th>City, State</th><th>Frequency</th><th>Weekly cases</th><th>Weekly pallets</th><th>PLC → stop one-way miles</th><th>Estimated stop-level cost allocation</th>
    </tr></thead><tbody>${routeStopSequenceRows(brief.routeStopSequences || s.proposedStopSequences)}</tbody></table>
  </section>
  </body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
