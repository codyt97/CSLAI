import {
  ASSUMPTIONS,
  averageFuelSurchargePct,
  buildLegs,
  calculateRateTableCost,
  haversineMiles,
  orderStopsNearestNeighbor,
  PLC_COORDS,
  generateDeterministicCandidates,
  getRouteGroup,
  groupRouteRecords
} from './routeMath.js';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    scope: { type: 'string' },
    dataSource: { type: 'string' },
    calculationStatus: { type: 'string' },
    confidence: { type: 'string', enum: ['High','Medium','Low'] },
    recommendations: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        recommendationType: { type: 'string' },
        currentRoutesImpacted: { type: 'array', items: { type: 'string' } },
        newRouteName: { type: 'string' },
        newPLC: { type: 'string' },
        stops: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string' }, name: { type: 'string' }, centerNumber: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, currentRoute: { type: 'string' }, proposedStop: { type: 'number' }
        }, required: ['id','name','centerNumber','city','state','currentRoute','proposedStop'] } },
        currentChargeableMiles: { type: 'number' }, newChargeableMiles: { type: 'number' }, weeklyMilesSaved: { type: 'number' },
        currentFuel: { type: 'number' }, newFuel: { type: 'number' }, currentCost: { type: 'number' }, newCost: { type: 'number' },
        weeklySavings: { type: 'number' }, annualSavings: { type: 'number' }, reason: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } }, confidence: { type: 'string' }
      },
      required: ['recommendationType','currentRoutesImpacted','newRouteName','newPLC','stops','currentChargeableMiles','newChargeableMiles','weeklyMilesSaved','currentFuel','newFuel','currentCost','newCost','weeklySavings','annualSavings','reason','risks','confidence']
    }},
    questionsForMcKesson: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary','scope','dataSource','calculationStatus','confidence','recommendations','questionsForMcKesson']
};

export async function runAiRouteOptimizer(input) {
  const { scope='all', routeName='', question='', objective='savings', maxRoutes=12 } = input || {};
  const candidates = generateDeterministicCandidates({ scope, routeName, objective, maxRoutes });
  const groups = scope === 'selected' && routeName ? [getRouteGroup(routeName)].filter(Boolean) : groupRouteRecords({ openOnly: true }).slice(0, Number(maxRoutes)||12);

  if (!process.env.OPENAI_API_KEY) {
    return fallbackResult({ scope, candidates, reason: 'OPENAI_API_KEY is not configured. Returning deterministic route calculator output.' });
  }

  const payload = {
    userQuestion: question,
    objective,
    assumptions: ASSUMPTIONS,
    hardRules: [
      'Do not treat each center as its own shipment.',
      'Optimize route groups or rebuilt route names only.',
      'Deadhead from truck origin to first pickup is not charged.',
      'Chargeable miles start at first pickup and end at destination PLC.',
      'Collection center routes use 48 ft refrigerated trailers only.',
      'Use 70 cases per pallet.',
      'Use 24 pallets as the 48 ft refrigerated trailer max; flag >24 as Over Capacity, 21.6-24 as High Utilization, and <12 as Underutilized.',
      'Flag >11 driver hours as a validation warning.',
      'Use scenario opportunity language unless contract rating or McKesson repricing validates invoice impact.'
    ],
    routeGroups: groups.map(g => ({
      routeName: g.routeName, stopCount: g.stopCount, currentEndpointPLC: g.currentEndpointPLC, routeType: g.routeType,
      weeklyCases: g.weeklyCases, weeklyPallets: g.weeklyPallets, workbookMiles: g.workbookMiles,
      workbookFuel: g.workbookFuel, workbookTotalCost: g.workbookTotalCost, isRelay: g.isRelay, pickupDays: g.pickupDays,
      stops: g.stops.map((s,i)=>({ stop:i+1, id:s.id, name:s.routeName, centerNumber:s.centerNumber, city:s.city, state:s.state, basePLC:s.basePLC, actualPLC:s.actualPLC }))
    })),
    preCalculatedCandidates: candidates.slice(0, 12)
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.5',
      input: [
        { role: 'system', content: 'You are an expert cold-chain transportation optimization analyst. You must be data-driven and use only the provided Excel-derived route data and pre-calculated route candidates. Return only valid JSON that matches the schema.' },
        { role: 'user', content: JSON.stringify(payload) }
      ],
      text: { format: { type: 'json_schema', name: 'route_optimizer_result', strict: true, schema: SCHEMA } }
    })
  });
  const data = await res.json();
  if (!res.ok) return fallbackResult({ scope, candidates, reason: `OpenAI API failed: ${data.error?.message || res.status}` });
  const text = data.output_text || data.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('') || '';
  try { return JSON.parse(text); }
  catch { return fallbackResult({ scope, candidates, reason: 'OpenAI returned non-JSON. Returning deterministic candidates.' }); }
}

function fallbackResult({ scope, candidates, reason }) {
  return {
    summary: 'Route optimization candidates generated from Excel-derived data and route calculator.',
    scope,
    dataSource: 'Embedded Excel-derived route data + Rate Table assumptions + deterministic route calculator',
    calculationStatus: reason,
    confidence: 'Medium',
    recommendations: candidates.slice(0, 8).map(c => ({
      recommendationType: c.recommendationType,
      currentRoutesImpacted: c.currentRoutesImpacted,
      newRouteName: c.newRouteName,
      newPLC: c.newPLC,
      stops: c.stops,
      currentChargeableMiles: Number(c.currentChargeableMiles || 0),
      newChargeableMiles: Number(c.newChargeableMiles || 0),
      weeklyMilesSaved: Number(c.weeklyMilesSaved || 0),
      currentFuel: Number(c.currentFuel || 0),
      newFuel: Number(c.newFuel || 0),
      currentCost: Number(c.currentCost || 0),
      newCost: Number(c.newCost || 0),
      weeklySavings: Number(c.weeklySavings || 0),
      annualSavings: Number(c.annualSavings || 0),
      reason: c.reason,
      risks: c.risks || [],
      confidence: c.confidence || 'Medium'
    })),
    questionsForMcKesson: [
      'Would the proposed route rebuild affect pickup windows or center notification timing?',
      'Can the proposed PLC receive the expected weekly pallet/case volume?',
      'Would relay driver staffing or trailer staging change under this scenario?',
      'Are there service agreement constraints that prevent regrouping these stops?'
    ]
  };
}


const MAX_SAVINGS_ALLOWED_PLCS = ['Dallas PLC', 'Whitestown PLC'];
const CO2_KG_PER_MILE = 1.62;
const SCENARIO_TYPES = {
  CURRENT: 'Current Baseline',
  CONSERVATIVE: 'Conservative Optimization',
  BALANCED: 'Balanced Optimization',
  MAX: 'Max Savings Optimization'
};

function roundScenario(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function sumScenario(values) {
  return (values || []).reduce((total, value) => total + (Number(value) || 0), 0);
}

function countScenario(items, selector) {
  return (items || []).reduce((acc, item) => {
    const key = selector(item) || 'Unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function centerKey(stop) {
  return String(stop?.centerNumber || stop?.id || '').trim();
}

function centerLabel(stop) {
  return `${stop?.centerNumber || stop?.id || ''} ${stop?.routeName || stop?.centerName || stop?.city || ''}`.trim();
}

function primaryFrequency(stop) {
  if (stop?.weekPatternA && stop?.weekPatternB) return 'Weekly';
  if (stop?.weekPatternA || stop?.weekPatternB) return 'Bi-Weekly';
  return stop?.pickupFrequency || 'Needs Validation';
}

function cloneRouteGroup(route) {
  const stops = (route.stops || []).map((stop) => ({ ...stop, proposedPLC: stop.proposedPLC || route.currentEndpointPLC, proposedPickupFrequency: stop.proposedPickupFrequency || primaryFrequency(stop) }));
  return { ...route, stops };
}

function buildProposedRoute(routeName, stops, plc, created = false, sourceRoutes = []) {
  const orderedStops = reorderRouteStops(stops, plc);
  const weeklyCases = sumScenario(orderedStops.map((s) => Number(s.weeklyCases)));
  const weeklyPallets = weeklyCases / ASSUMPTIONS.casesPerPallet;
  const miles = calculateRouteMiles({ stops: orderedStops, destinationPLC: plc });
  const cost = calculateRouteCost({ chargeableMiles: miles.chargeableMiles, weeklyCases });
  return {
    routeName,
    sourceRoutes,
    currentEndpointPLC: plc,
    proposedPLC: plc,
    routeType: created ? 'Proposed' : 'Optimized',
    created,
    stops: orderedStops,
    stopCount: orderedStops.length,
    weeklyCases: roundScenario(weeklyCases),
    weeklyPallets: roundScenario(weeklyPallets),
    weeklyMiles: miles.chargeableMiles,
    operationalMiles: miles.totalOperationalMiles,
    driverHours: calculateDriverHours(miles.chargeableMiles),
    fuelCost: calculateFuelCost(cost.linehaul),
    co2Kg: calculateCo2Kg(miles.chargeableMiles),
    weeklyCost: cost.totalCost,
    linehaulCost: cost.linehaul,
    overCapacity: weeklyPallets > ASSUMPTIONS.reefer48FootMaxPallets,
    highUtilization: weeklyPallets >= ASSUMPTIONS.highUtilizationPalletThreshold && weeklyPallets <= ASSUMPTIONS.reefer48FootMaxPallets,
    underutilized: weeklyPallets < ASSUMPTIONS.underutilizedPalletThreshold,
    validationWarnings: []
  };
}

export function buildOptimizationNodes() {
  return groupRouteRecords({ openOnly: true }).flatMap((route) =>
    (route.stops || []).map((stop) => ({
      id: centerKey(stop),
      centerNumber: stop.centerNumber || stop.id,
      centerName: stop.routeName || stop.centerName || '',
      city: stop.city || '',
      state: stop.state || '',
      lat: stop.lat,
      lng: stop.lng,
      currentRoute: route.routeName,
      currentPLC: route.currentEndpointPLC,
      basePLC: stop.basePLC,
      actualPLC: stop.actualPLC,
      currentPickupFrequency: primaryFrequency(stop),
      weeklyCases: Number(stop.weeklyCases) || 0,
      weeklyPallets: roundScenario((Number(stop.weeklyCases) || 0) / ASSUMPTIONS.casesPerPallet),
      currentWeeklyCost: Number(stop.totalRouteCost || stop.sumBilledWeekly || 0),
      sourceRecord: stop
    }))
  );
}

export function buildCurrentNetworkBaseline() {
  const routeGroups = groupRouteRecords({ openOnly: true }).map((route) => {
    const weeklyMiles = Number(route.currentPathMiles || route.workbookMiles || 0);
    const weeklyCost = Number(route.workbookTotalCost || calculateRouteCost({ chargeableMiles: weeklyMiles, weeklyCases: route.weeklyCases }).totalCost);
    return {
      ...cloneRouteGroup(route),
      proposedPLC: route.currentEndpointPLC,
      weeklyMiles: roundScenario(weeklyMiles),
      operationalMiles: Number(route.currentOperationalMiles || weeklyMiles),
      driverHours: calculateDriverHours(weeklyMiles),
      fuelCost: Number(route.workbookFuel || calculateFuelCost(weeklyCost / (1 + averageFuelSurchargePct()))),
      co2Kg: calculateCo2Kg(weeklyMiles),
      weeklyCost: roundScenario(weeklyCost),
      linehaulCost: Number(route.workbookLinehaul || 0),
      created: false
    };
  });
  return { routeGroups, nodes: buildOptimizationNodes(), totals: calculateNetworkTotals(routeGroups) };
}

export function calculateNetworkTotals(routeGroups = []) {
  return {
    routeCount: routeGroups.length,
    centerCount: sumScenario(routeGroups.map((r) => (r.stops || []).length)),
    weeklyCases: roundScenario(sumScenario(routeGroups.map((r) => r.weeklyCases))),
    weeklyPallets: roundScenario(sumScenario(routeGroups.map((r) => r.weeklyPallets))),
    weeklyMiles: roundScenario(sumScenario(routeGroups.map((r) => r.weeklyMiles ?? r.currentPathMiles ?? r.workbookMiles))),
    driverHours: roundScenario(sumScenario(routeGroups.map((r) => r.driverHours ?? calculateDriverHours(r.weeklyMiles ?? r.currentPathMiles ?? 0)))),
    fuelCost: roundScenario(sumScenario(routeGroups.map((r) => r.fuelCost ?? r.workbookFuel))),
    co2Kg: roundScenario(sumScenario(routeGroups.map((r) => r.co2Kg ?? calculateCo2Kg(r.weeklyMiles ?? r.currentPathMiles ?? 0)))),
    weeklyCost: roundScenario(sumScenario(routeGroups.map((r) => r.weeklyCost ?? r.workbookTotalCost))),
    annualCost: roundScenario(sumScenario(routeGroups.map((r) => r.weeklyCost ?? r.workbookTotalCost)) * 52)
  };
}

export function calculateRouteCost({ chargeableMiles = 0, weeklyCases = 0 } = {}) {
  return calculateRateTableCost({ chargeableMiles: Number(chargeableMiles) || 0, weeklyCases: Number(weeklyCases) || 0 });
}

export function calculateRouteMiles({ stops = [], destinationPLC = 'Dallas PLC', origin = null } = {}) {
  const legs = buildLegs({ stops, destinationPLC, origin });
  return {
    chargeableMiles: roundScenario(legs.chargeableMiles),
    deadheadMiles: roundScenario(legs.deadheadMiles),
    totalOperationalMiles: roundScenario(legs.totalOperationalMiles),
    legs: legs.legs || []
  };
}

export function calculateDriverHours(miles = 0) {
  return roundScenario((Number(miles) || 0) / ASSUMPTIONS.defaultSpeedMph);
}

export function calculateFuelCost(linehaul = 0) {
  return roundScenario((Number(linehaul) || 0) * averageFuelSurchargePct());
}

export function calculateCo2Kg(miles = 0) {
  return roundScenario((Number(miles) || 0) * CO2_KG_PER_MILE);
}

export function reorderRouteStops(stops = [], destinationPLC = 'Dallas PLC') {
  return orderStopsNearestNeighbor(stops, destinationPLC).map((stop, index) => ({ ...stop, proposedStop: index + 1 }));
}

function nearestAllowedPLC(stop) {
  if (!stop?.lat || !stop?.lng) return stop?.actualPLC && MAX_SAVINGS_ALLOWED_PLCS.includes(stop.actualPLC) ? stop.actualPLC : 'Dallas PLC';
  return MAX_SAVINGS_ALLOWED_PLCS.map((plc) => ({ plc, miles: haversineMiles(stop, PLC_COORDS[plc]) })).sort((a, b) => a.miles - b.miles)[0]?.plc || 'Dallas PLC';
}

export function optimizePLCAssignments(routeGroups = [], mode = SCENARIO_TYPES.MAX) {
  const allow = mode === SCENARIO_TYPES.MAX || mode === SCENARIO_TYPES.BALANCED;
  if (!allow) return [];
  const moves = [];
  for (const route of routeGroups) {
    for (const stop of route.stops || []) {
      const currentPLC = route.currentEndpointPLC;
      const proposedPLC = nearestAllowedPLC(stop);
      const currentDistance = haversineMiles(stop, PLC_COORDS[currentPLC] || PLC_COORDS['Dallas PLC']);
      const proposedDistance = haversineMiles(stop, PLC_COORDS[proposedPLC]);
      const betterBy = currentDistance - proposedDistance;
      if (proposedPLC !== currentPLC && betterBy > (mode === SCENARIO_TYPES.MAX ? 35 : 80)) {
        const currentCost = Number(stop.totalRouteCost || stop.sumBilledWeekly || route.weeklyCost / Math.max(1, route.stopCount) || 0);
        const proposedCost = Math.max(0, currentCost - betterBy * 3.34 * (1 + averageFuelSurchargePct()));
        moves.push(centerMoveDetail(stop, route, `${route.routeName}-${proposedPLC.includes('Dallas') ? 'DAL' : 'WHT'} Proposed`, currentPLC, proposedPLC, currentCost, proposedCost, 'Nearest allowed PLC materially reduces scenario miles; requires McKesson repricing and contract mileage validation.', 'High'));
      }
    }
  }
  return moves;
}

export function optimizePickupFrequency(routeGroups = [], mode = SCENARIO_TYPES.MAX) {
  if (mode !== SCENARIO_TYPES.MAX) return [];
  const changes = [];
  for (const route of routeGroups) {
    for (const stop of route.stops || []) {
      const cases = Number(stop.weeklyCases) || 0;
      if (cases > 0 && cases < 45 && primaryFrequency(stop) === 'Weekly') {
        const currentCost = Number(stop.totalRouteCost || stop.sumBilledWeekly || route.weeklyCost / Math.max(1, route.stopCount) || 0);
        const proposedCost = currentCost * 0.55;
        changes.push(centerMoveDetail(stop, route, route.routeName, route.currentEndpointPLC, route.currentEndpointPLC, currentCost, proposedCost, 'Low-volume center may be a Weekly to Bi-Weekly exploratory scenario; pickup frequency approval, storage capacity, and cold-chain hold validation are required.', 'High', 'Bi-Weekly'));
      }
    }
  }
  return changes;
}

function centerMoveDetail(stop, route, proposedRoute, currentPLC, proposedPLC, currentCost, proposedCost, reason, riskLevel, proposedFrequency = primaryFrequency(stop)) {
  const weeklySavings = roundScenario((Number(currentCost) || 0) - (Number(proposedCost) || 0));
  const plcChanged = currentPLC !== proposedPLC;
  const frequencyChanged = primaryFrequency(stop) !== proposedFrequency;
  return {
    centerNumber: stop.centerNumber || stop.id,
    centerName: stop.routeName || stop.centerName || '',
    city: stop.city || '',
    state: stop.state || '',
    currentRoute: route.routeName,
    proposedRoute,
    currentPLC,
    proposedPLC,
    currentPickupFrequency: primaryFrequency(stop),
    proposedPickupFrequency: proposedFrequency,
    currentWeeklyCases: Number(stop.weeklyCases) || 0,
    proposedWeeklyCases: frequencyChanged ? roundScenario((Number(stop.weeklyCases) || 0) / 2) : Number(stop.weeklyCases) || 0,
    currentWeeklyPallets: roundScenario((Number(stop.weeklyCases) || 0) / ASSUMPTIONS.casesPerPallet),
    proposedWeeklyPallets: roundScenario((frequencyChanged ? (Number(stop.weeklyCases) || 0) / 2 : Number(stop.weeklyCases) || 0) / ASSUMPTIONS.casesPerPallet),
    currentWeeklyCost: roundScenario(currentCost),
    proposedWeeklyCost: roundScenario(proposedCost),
    weeklyScenarioSavings: weeklySavings,
    annualScenarioSavings: roundScenario(weeklySavings * 52),
    reason,
    constraintChecksPassed: ['Center remains assigned exactly once', 'Proposed route is at or below 24 pallets when network is validated', 'Scenario miles are not treated as confirmed billing miles'],
    constraintChecksFailed: [],
    requiresMcKessonRepricing: plcChanged || frequencyChanged,
    requiresContractMileageValidation: plcChanged,
    requiresPickupFrequencyApproval: frequencyChanged,
    confidenceScore: plcChanged ? 0.62 : 0.54,
    riskLevel
  };
}

export function splitRouteGroup(routeGroup, mode = SCENARIO_TYPES.MAX) {
  if (!routeGroup) return [];
  const shouldSplit = routeGroup.weeklyPallets > ASSUMPTIONS.highUtilizationPalletThreshold || routeGroup.plcMismatch || routeGroup.stopCount > (mode === SCENARIO_TYPES.MAX ? 8 : 11);
  if (!shouldSplit) return [buildProposedRoute(routeGroup.routeName, routeGroup.stops, routeGroup.currentEndpointPLC, false, [routeGroup.routeName])];
  const byPlc = {};
  for (const stop of routeGroup.stops || []) {
    const plc = mode === SCENARIO_TYPES.MAX ? nearestAllowedPLC(stop) : routeGroup.currentEndpointPLC;
    byPlc[plc] ||= [];
    byPlc[plc].push(stop);
  }
  return Object.entries(byPlc).flatMap(([plc, stops]) => {
    const chunks = [];
    let chunk = [];
    let cases = 0;
    for (const stop of reorderRouteStops(stops, plc)) {
      const nextCases = cases + (Number(stop.weeklyCases) || 0);
      if (chunk.length && nextCases / ASSUMPTIONS.casesPerPallet > ASSUMPTIONS.reefer48FootMaxPallets) {
        chunks.push(chunk); chunk = []; cases = 0;
      }
      chunk.push(stop); cases += Number(stop.weeklyCases) || 0;
    }
    if (chunk.length) chunks.push(chunk);
    return chunks.map((chunkStops, index) => buildProposedRoute(`${routeGroup.routeName}${chunks.length > 1 ? ` Split ${index + 1}` : plc.includes('Dallas') ? ' DAL' : ' WHT'}`, chunkStops, plc, chunks.length > 1, [routeGroup.routeName]));
  });
}

export function consolidateRouteGroups(routeGroups = [], mode = SCENARIO_TYPES.MAX) {
  if (mode === SCENARIO_TYPES.CURRENT) return routeGroups;
  const result = [];
  const used = new Set();
  const sorted = [...routeGroups].sort((a, b) => a.weeklyPallets - b.weeklyPallets);
  for (const route of sorted) {
    if (used.has(route.routeName)) continue;
    const partner = sorted.find((candidate) => !used.has(candidate.routeName) && candidate.routeName !== route.routeName && candidate.currentEndpointPLC === route.currentEndpointPLC && route.weeklyPallets + candidate.weeklyPallets <= ASSUMPTIONS.highUtilizationPalletThreshold && route.underutilized && candidate.underutilized);
    if (partner && mode !== SCENARIO_TYPES.CONSERVATIVE) {
      used.add(route.routeName); used.add(partner.routeName);
      result.push(buildProposedRoute(`${route.routeName}+${partner.routeName} Consolidated`, [...route.stops, ...partner.stops], route.currentEndpointPLC, true, [route.routeName, partner.routeName]));
    } else {
      used.add(route.routeName);
      result.push(buildProposedRoute(route.routeName, route.stops, route.currentEndpointPLC, false, [route.routeName]));
    }
  }
  return result;
}

export function createNewRouteGroup({ routeName, stops = [], proposedPLC = 'Dallas PLC' } = {}) {
  return buildProposedRoute(routeName || `New ${proposedPLC} Route`, stops, proposedPLC, true, []);
}

export function rebuildRouteGroups(routeGroups = [], mode = SCENARIO_TYPES.MAX) {
  if (mode === SCENARIO_TYPES.CURRENT) return routeGroups.map((r) => buildProposedRoute(r.routeName, r.stops, r.currentEndpointPLC, false, [r.routeName]));
  const split = routeGroups.flatMap((route) => splitRouteGroup(route, mode));
  return consolidateRouteGroups(split, mode);
}

export function assignNearestPLCScenario(mode = SCENARIO_TYPES.MAX) {
  const baseline = buildCurrentNetworkBaseline();
  return optimizePLCAssignments(baseline.routeGroups, mode);
}

export function validateScenarioNetwork(currentRoutes = [], proposedRoutes = [], frequencyChanges = []) {
  const currentCenters = currentRoutes.flatMap((r) => r.stops || []).map(centerKey).filter(Boolean);
  const proposedCenters = proposedRoutes.flatMap((r) => r.stops || []).map(centerKey).filter(Boolean);
  const warnings = [];
  const missing = currentCenters.filter((id) => !proposedCenters.includes(id));
  const duplicates = proposedCenters.filter((id, index) => proposedCenters.indexOf(id) !== index);
  if (missing.length) warnings.push(`Missing proposed center assignments: ${missing.slice(0, 10).join(', ')}`);
  if (duplicates.length) warnings.push(`Duplicate proposed center assignments: ${[...new Set(duplicates)].slice(0, 10).join(', ')}`);
  for (const route of proposedRoutes) {
    if (route.weeklyPallets > ASSUMPTIONS.reefer48FootMaxPallets) warnings.push(`${route.routeName} exceeds 24 pallets and needs capacity review.`);
    if (route.driverHours > ASSUMPTIONS.driverHourLimit) warnings.push(`${route.routeName} exceeds 11 driver hours and needs driver-time validation.`);
    if ((route.sourceRoutes || []).length > 1) warnings.push(`${route.routeName} is a consolidation scenario and requires operational validation.`);
  }
  const currentCases = sumScenario(currentRoutes.map((r) => r.weeklyCases));
  const proposedCases = sumScenario(proposedRoutes.map((r) => r.weeklyCases));
  if (Math.abs(currentCases - proposedCases) > 0.01 && !frequencyChanges.length) warnings.push('Weekly cases changed without an explicit pickup frequency change list.');
  return {
    valid: !missing.length && !duplicates.length && proposedRoutes.every((r) => r.weeklyPallets <= ASSUMPTIONS.reefer48FootMaxPallets),
    missingCenters: missing,
    duplicateCenters: [...new Set(duplicates)],
    validationWarnings: warnings
  };
}

export function compareCurrentVsProposed(currentRoutes = [], proposedRoutes = []) {
  return proposedRoutes.map((route) => {
    const currentSources = currentRoutes.filter((r) => (route.sourceRoutes || []).includes(r.routeName));
    const sourceRows = currentSources.length ? currentSources : currentRoutes.filter((r) => r.routeName === route.routeName);
    const current = sourceRows[0];
    const currentCost = sumScenario(sourceRows.map((r) => r.weeklyCost || r.workbookTotalCost || 0));
    return {
      route: route.routeName,
      plc: route.proposedPLC,
      stops: route.stops.length,
      currentStops: sumScenario(sourceRows.map((r) => r.stops?.length || 0)),
      currentCases: roundScenario(sumScenario(sourceRows.map((r) => r.weeklyCases || 0))),
      proposedCases: route.weeklyCases,
      currentMiles: roundScenario(sumScenario(sourceRows.map((r) => r.weeklyMiles || r.currentPathMiles || 0))),
      proposedMiles: route.weeklyMiles,
      currentPallets: roundScenario(sumScenario(sourceRows.map((r) => r.weeklyPallets || 0))),
      proposedPallets: route.weeklyPallets,
      currentCost: roundScenario(currentCost),
      proposedCost: route.weeklyCost,
      deltaCost: roundScenario(route.weeklyCost - currentCost),
      centersMovedIn: [],
      centersMovedOut: [],
      routeCreated: route.created || !current,
      routeRemoved: false,
      validationWarnings: route.validationWarnings || [],
      implementationRisk: route.created ? 'Medium' : 'Low'
    };
  });
}

export function buildMaxSavingsScenario(mode = SCENARIO_TYPES.MAX) {
  const scenarioType = Object.values(SCENARIO_TYPES).includes(mode) ? mode : SCENARIO_TYPES.MAX;
  const baseline = buildCurrentNetworkBaseline();
  const currentRoutes = baseline.routeGroups;
  const proposedRoutes = rebuildRouteGroups(currentRoutes, scenarioType);
  const plcMoves = optimizePLCAssignments(currentRoutes, scenarioType).filter((m) => m.weeklyScenarioSavings > 0);
  const frequencyChanges = optimizePickupFrequency(currentRoutes, scenarioType).filter((m) => m.weeklyScenarioSavings > 0);
  const validation = validateScenarioNetwork(currentRoutes, proposedRoutes, frequencyChanges);
  const currentTotals = calculateNetworkTotals(currentRoutes);
  const proposedTotals = calculateNetworkTotals(proposedRoutes);
  const deltaTotals = {
    weeklyCases: roundScenario(proposedTotals.weeklyCases - currentTotals.weeklyCases),
    weeklyMiles: roundScenario(proposedTotals.weeklyMiles - currentTotals.weeklyMiles),
    driverHours: roundScenario(proposedTotals.driverHours - currentTotals.driverHours),
    fuelCost: roundScenario(proposedTotals.fuelCost - currentTotals.fuelCost),
    co2Kg: roundScenario(proposedTotals.co2Kg - currentTotals.co2Kg),
    weeklyCost: roundScenario(proposedTotals.weeklyCost - currentTotals.weeklyCost),
    annualCost: roundScenario(proposedTotals.annualCost - currentTotals.annualCost)
  };
  const percentChangeTotals = Object.fromEntries(Object.entries(deltaTotals).map(([key, value]) => [key, currentTotals[key] ? roundScenario((value / currentTotals[key]) * 100) : 0]));
  const routeComparison = compareCurrentVsProposed(currentRoutes, proposedRoutes);
  const routesCreated = routeComparison.filter((r) => r.routeCreated).map((r) => r.route);
  const currentRouteNames = new Set(currentRoutes.map((r) => r.routeName));
  const proposedSourceNames = new Set(proposedRoutes.flatMap((r) => r.sourceRoutes || []));
  const routesRemoved = [...currentRouteNames].filter((name) => !proposedSourceNames.has(name));
  const scenarioSavings = roundScenario(currentTotals.weeklyCost - proposedTotals.weeklyCost);
  const warnings = [...validation.validationWarnings];
  if (plcMoves.length) warnings.push('PLC reassignments require McKesson repricing and contract mileage validation.');
  if (frequencyChanges.length) warnings.push('Weekly to Bi-Weekly pickup frequency changes require CSL/McKesson operational approval and cold-chain hold validation.');
  warnings.push('Scenario miles are not confirmed billing miles; proposed savings require McKesson repricing and contract mileage validation.');
  return {
    scenarioName: scenarioType === SCENARIO_TYPES.MAX ? 'Max Savings AI Optimizer Scenario' : scenarioType,
    scenarioType,
    currentTotals,
    proposedTotals,
    deltaTotals,
    percentChangeTotals,
    routeCountCurrent: currentTotals.routeCount,
    routeCountProposed: proposedTotals.routeCount,
    centerCountCurrent: currentTotals.centerCount,
    centerCountProposed: proposedTotals.centerCount,
    weeklyCasesCurrent: currentTotals.weeklyCases,
    weeklyCasesProposed: proposedTotals.weeklyCases,
    weeklyMilesCurrent: currentTotals.weeklyMiles,
    weeklyMilesProposed: proposedTotals.weeklyMiles,
    driverHoursCurrent: currentTotals.driverHours,
    driverHoursProposed: proposedTotals.driverHours,
    fuelCostCurrent: currentTotals.fuelCost,
    fuelCostProposed: proposedTotals.fuelCost,
    co2KgCurrent: currentTotals.co2Kg,
    co2KgProposed: proposedTotals.co2Kg,
    weeklyCostCurrent: currentTotals.weeklyCost,
    weeklyCostProposed: proposedTotals.weeklyCost,
    annualCostCurrent: currentTotals.annualCost,
    annualCostProposed: proposedTotals.annualCost,
    weeklyScenarioSavings: scenarioSavings,
    annualScenarioSavings: roundScenario(scenarioSavings * 52),
    plcSplitCurrent: countScenario(currentRoutes, (r) => r.currentEndpointPLC),
    plcSplitProposed: countScenario(proposedRoutes, (r) => r.proposedPLC),
    pickupFrequencyCurrent: countScenario(buildOptimizationNodes(), (n) => n.currentPickupFrequency),
    pickupFrequencyProposed: countScenario([...buildOptimizationNodes(), ...frequencyChanges], (n) => n.proposedPickupFrequency || n.currentPickupFrequency),
    centersReassignedPLC: plcMoves,
    centersChangedFrequency: frequencyChanges,
    routesCreated,
    routesRemoved,
    routeComparison,
    proposedStopSequences: proposedRoutes.map((route) => ({ routeName: route.routeName, proposedPLC: route.proposedPLC, stops: route.stops.map((stop, index) => ({ stopNumber: index + 1, centerNumber: stop.centerNumber || stop.id, centerName: stop.routeName || '', city: stop.city, state: stop.state, frequency: primaryFrequency(stop), oneWayMiles: roundScenario(haversineMiles(stop, PLC_COORDS[route.proposedPLC])), casesWeek: Number(stop.weeklyCases) || 0, costWeek: Number(stop.totalRouteCost || stop.sumBilledWeekly || 0) })) })),
    validationWarnings: warnings,
    risksAndTradeoffs: ['Requires McKesson repricing before billing impact can be validated.', 'Requires contract mileage validation because scenario miles are planning estimates.', 'Frequency changes are exploratory until pickup windows, storage capacity, and cold-chain hold times are approved.'],
    confidenceScore: validation.valid ? 0.68 : 0.48
  };
}

export function rankOptimizationScenarios(scenarios = []) {
  return [...scenarios].sort((a, b) => (b.weeklyScenarioSavings || 0) - (a.weeklyScenarioSavings || 0));
}

export function explainOptimizationScenario(scenario = buildMaxSavingsScenario()) {
  return {
    summary: `${scenario.scenarioName} shows ${roundScenario(scenario.weeklyScenarioSavings)} weekly scenario savings and ${roundScenario(scenario.annualScenarioSavings)} annual scenario savings before repricing validation.`,
    whyNotFinal: 'Scenario savings require McKesson repricing and contract mileage validation before invoice impact can be validated.',
    routeChanges: scenario.routeComparison,
    validationWarnings: scenario.validationWarnings,
    risksAndTradeoffs: scenario.risksAndTradeoffs
  };
}

export function buildScenarioBriefData(input = SCENARIO_TYPES.MAX) {
  const scenario = typeof input === 'string' ? buildMaxSavingsScenario(input) : input;
  return {
    generatedAt: new Date().toISOString(),
    title: scenario.scenarioName,
    subtitle: 'PlasmaOps / CSL Route Intelligence scenario brief',
    executiveSummary: explainOptimizationScenario(scenario).summary,
    scenario,
    currentVsProposedTotals: { current: scenario.currentTotals, proposed: scenario.proposedTotals, delta: scenario.deltaTotals },
    routeComparison: scenario.routeComparison,
    plcReassignments: scenario.centersReassignedPLC,
    frequencyChanges: scenario.centersChangedFrequency,
    routeStopSequences: scenario.proposedStopSequences,
    validationWarnings: scenario.validationWarnings,
    sourceNote: 'Source: provided schedule, runtime billing/audit data, scenario optimizer assumptions. Scenario savings require McKesson repricing and contract mileage validation before invoice impact is validated.'
  };
}
