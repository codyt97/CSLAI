import records from './data/records.json' assert { type: 'json' };
import rateTable from './data/rateTable.json' assert { type: 'json' };
import plcCoordsRaw from './data/plcCoords.json' assert { type: 'json' };
import routeOriginPayload from './data/routeOrigins.json' assert { type: 'json' };

export const ASSUMPTIONS = {
  deadheadCharged: false, 
  chargeStartsAt: 'first pickup',
  collectionTrailer: '48 ft specialized refrigerated trailer',
  shuttleTrailer: '53 ft trailer for Kankakee/facility-to-facility shuttle only',
  casesPerPallet: 70,
  k3BasketSizeInches: '24 x 20 x 7',
  standardCaseSizeInches: '13.63 x 10.5 x 12',
  k3BasketsPerPallet: 20,
  k3CasesPerPallet: 56,
  palletWarningThreshold: 18,
  driverHourLimit: 11,
  defaultSpeedMph: Number(process.env.DEFAULT_AVERAGE_TRUCK_SPEED_MPH || 55)
};


export function contractRules() {
  const dedicatedRate = Number(rateTable?.dedicatedRatePerMile || rateTable?.dedicatedTransportationRatePerMile || 3.34);
  return {
    chargeStartsAt: ASSUMPTIONS.chargeStartsAt,
    deadheadCharged: ASSUMPTIONS.deadheadCharged,
    fuelSurchargePct: averageFuelSurchargePct(),
    linehaulFormula: `chargeable miles × $${dedicatedRate}/mile`,
    fuelFormula: `linehaul × ${(averageFuelSurchargePct()*100).toFixed(2)}% fuel surcharge`,
    trailerRule: ASSUMPTIONS.collectionTrailer,
    palletRule: `${ASSUMPTIONS.casesPerPallet} cases = 1 pallet`,
    minimumCharge: rateTable?.minimumChargeWeightLbs ? `${rateTable.minimumChargeWeightLbs} lb minimum charge weight` : 'No explicit minimum charge found in loaded Rate Table data',
    accessorialRules: 'Storage, other/accessorial, detention, layover, toll, stop-charge, and special-handling costs are used only when present in the workbook/rate data; no unlisted charge is invented.',
    source: rateTable?.sourceSheet || 'Rate Table'
  };
}

export const PLC_COORDS = normalizePlcCoords(plcCoordsRaw);
export const ROUTE_ORIGINS = routeOriginPayload.routeOrigins || {};
export const ORIGIN_DETAILS = routeOriginPayload.originDetails || {};

function normalizePlcCoords(raw) {
  const out = {};
  for (const [name, val] of Object.entries(raw || {})) {
    if (val && typeof val.lat === 'number' && typeof val.lng === 'number') out[name] = val;
  }
  out['Dallas PLC'] ||= { lat: 32.7767, lng: -96.7970, name: 'Dallas PLC' };
  out['Whitestown PLC'] ||= { lat: 39.9973, lng: -86.3458, name: 'Whitestown PLC' };
  return out;
}

export function getAllRecords() { return records; }
export function cleanRouteName(name) { return String(name || '').trim().toUpperCase(); }
export function isOpenCenter(r) { return String(r.centerStatus || '').toUpperCase() === 'OPEN'; }
export function isValidRouteRecord(r) { return r && r.routeNameMckesson && r.routeNameMckesson !== '#N/A' && r.hasCoords && r.lat && r.lng; }
export function routeEndpointForRecord(r) { return String(r.routeType || '').toLowerCase() === 'relay' ? r.actualPLC : r.basePLC; }
export function originForRouteName(routeName) {
  const key = cleanRouteName(routeName);
  const originName = ROUTE_ORIGINS[key];
  return originName ? ORIGIN_DETAILS[originName] : null;
}
export function firstPickupDay(r) {
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  for (const d of days) if (r[d]) return d;
  return '';
}

export function scheduleForStop(r) {
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  return days.map(day => ({ day, value: String(r?.[day] || r?.pickupDays?.[day] || '').trim() })).filter(x => x.value);
}
export function stopScheduleSummary(r) {
  const schedule = scheduleForStop(r);
  return {
    pickupDay: schedule.map(x => `${x.day}:${x.value}`).join(', ') || firstPickupDay(r) || 'Not scheduled',
    pickupTimeWindow: r.pickupHours || '',
    weekA: r.weekPatternA || '',
    weekB: r.weekPatternB || '',
    currentRouteName: r.routeNameMckesson || r.mckessonRoute || '',
    currentPLC: routeEndpointForRecord(r),
    cases: round(r.weeklyCases, 2),
    pallets: round((Number(r.weeklyCases)||0) / ASSUMPTIONS.casesPerPallet, 2),
    nonCslPickupDayFlag: Boolean(r.nonCslPickupDayFlag || r.nonCSLPickupDayFlag || r.notCslPickupDay)
  };
}
export function routeScheduleSummary(stops) {
  const pickupDays = unique(stops.flatMap(s => scheduleForStop(s).map(x => `${x.day}:${x.value}`)).filter(Boolean));
  const timeWindows = unique(stops.map(s => s.pickupHours).filter(Boolean));
  const weekCadence = unique(stops.map(s => [s.weekPatternA ? 'A' : '', s.weekPatternB ? 'B' : ''].filter(Boolean).join('/')).filter(Boolean));
  return { pickupDays, timeWindows, weekCadence };
}

export function groupRouteRecords({ openOnly = true } = {}) {
  const groups = new Map();
  for (const r of records) {
    if (!isValidRouteRecord(r)) continue;
    if (openOnly && !isOpenCenter(r)) continue;
    const routeName = String(r.routeNameMckesson || '').trim();
    if (!groups.has(routeName)) groups.set(routeName, []);
    groups.get(routeName).push(r);
  }
  return [...groups.entries()].map(([routeName, stops]) => summarizeRouteGroup(routeName, stops));
}
export function getRouteGroup(routeName, { openOnly = true } = {}) {
  const rn = cleanRouteName(routeName);
  const stops = records.filter(r => isValidRouteRecord(r) && cleanRouteName(r.routeNameMckesson) === rn && (!openOnly || isOpenCenter(r)));
  if (!stops.length) return null;
  return summarizeRouteGroup(stops[0].routeNameMckesson, stops);
}
export function summarizeRouteGroup(routeName, stops) {
  const endpointCounts = countBy(stops.map(routeEndpointForRecord));
  const endpointPLC = mostCommon(endpointCounts) || stops[0]?.actualPLC || stops[0]?.basePLC || '#N/A';
  const baseCounts = countBy(stops.map(s => s.basePLC));
  const actualCounts = countBy(stops.map(s => s.actualPLC));
  const routeTypeCounts = countBy(stops.map(s => s.routeType));
  const routeType = mostCommon(routeTypeCounts) || 'Base';
  const origin = originForRouteName(routeName);
  const cases = sum(stops.map(s => s.weeklyCases));
  const routePalletEstimate = cases / ASSUMPTIONS.casesPerPallet;
  const workbookPalletAllocation = sum(stops.map(s => s.weeklyPallets));
  const linehaul = sum(stops.map(s => s.linehaulCost));
  const fuel = sum(stops.map(s => s.fuelSurchargeDollar));
  const totalCost = sum(stops.map(s => s.totalRouteCost || s.sumBilledWeekly));
  const workbookAllocatedMiles = sum(stops.map(s => s.weeklyMiles));
  const orderedStops = orderStopsNearestNeighbor(stops, endpointPLC);
  const currentRoutePath = buildLegs({ stops: orderedStops, destinationPLC: endpointPLC, origin, preserveOrder: true });
  return {
    routeName,
    routeKey: cleanRouteName(routeName),
    stops: orderedStops,
    stopCount: stops.length,
    currentEndpointPLC: endpointPLC,
    basePLC: mostCommon(baseCounts),
    actualPLC: mostCommon(actualCounts),
    routeType,
    origin,
    weeklyCases: round(cases, 2),
    routePalletEstimate: round(routePalletEstimate, 2),
    weeklyPallets: round(routePalletEstimate, 2),
    workbookPalletAllocation: round(workbookPalletAllocation, 2),
    palletCalculationBasis: `Route pallet estimate = total route cases / ${ASSUMPTIONS.casesPerPallet} cases per pallet`,
    weeklyLiters: round(sum(stops.map(s => s.weeklyLiters)), 2),
    workbookAllocatedMiles: round(workbookAllocatedMiles, 2),
    currentRoutePath,
    workbookMiles: currentRoutePath.chargeableMiles,
    workbookLinehaul: round(linehaul, 2),
    workbookFuel: round(fuel, 2),
    workbookTotalCost: round(totalCost, 2),
    workbookCostPerCase: cases ? round(totalCost / cases, 2) : 0,
    weekPatterns: unique(stops.map(s => [s.weekPatternA ? 'A' : '', s.weekPatternB ? 'B' : ''].filter(Boolean).join('/')).filter(Boolean)),
    pickupDays: unique(stops.map(firstPickupDay).filter(Boolean)),
    schedule: routeScheduleSummary(stops),
    isRelay: stops.some(s => String(s.routeType).toLowerCase() === 'relay' || s.plcChanged),
    plcMismatch: stops.some(s => s.basePLC !== s.actualPLC && s.basePLC !== '#N/A' && s.actualPLC !== '#N/A'),
    palletWarning: routePalletEstimate > ASSUMPTIONS.palletWarningThreshold
  };
}
function countBy(arr) { const o = {}; for (const v of arr) o[v || ''] = (o[v || ''] || 0) + 1; return o; }
function mostCommon(counts) { return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || ''; }
function sum(arr) { return arr.reduce((a,b)=>a+(Number(b)||0),0); }
function unique(arr) { return [...new Set(arr)]; }
function round(n, d=2){ const m = 10**d; return Math.round((Number(n)||0)*m)/m; }
export function haversineMiles(a,b){
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return 0;
  const R=3958.7613, toRad=x=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
export function orderStopsNearestNeighbor(stops, endpointPLC) {
  const pts = stops.filter(s => s.hasCoords && typeof s.lat === 'number' && typeof s.lng === 'number');
  if (!pts.length) return [];
  const end = PLC_COORDS[endpointPLC] || PLC_COORDS['Dallas PLC'];
  let remaining = [...pts];
  let current = remaining.reduce((best, s) => !best || haversineMiles(s, end) > haversineMiles(best, end) ? s : best, null);
  const ordered=[];
  while (current) {
    ordered.push(current);
    remaining = remaining.filter(s => s.id !== current.id);
    current = remaining.reduce((best,s)=> !best || haversineMiles(current, s) < haversineMiles(current, best) ? s : best, null);
  }
  return ordered;
}
export function buildLegs({ stops, destinationPLC, origin = null, roadFactor = 1.18, preserveOrder = false }) {
  const ordered = preserveOrder ? (stops || []).filter(s => s?.hasCoords && typeof s.lat === 'number' && typeof s.lng === 'number') : orderStopsNearestNeighbor(stops, destinationPLC);
  const dest = PLC_COORDS[destinationPLC];
  const legs=[];
  if (!ordered.length || !dest) return { legs, chargeableMiles: 0, deadheadMiles: 0, totalOperationalMiles: 0 };
  const first = ordered[0];
  if (origin && typeof origin.lat === 'number') {
    const miles = haversineMiles(origin, first) * roadFactor;
    legs.push({ step: 0, from: origin.name || 'Truck Origin', to: stopLabel(first), miles: round(miles, 2), charged: false, legType: 'deadhead' });
  }
  let prev = first;
  for (let i=1; i<ordered.length; i++) {
    const miles = haversineMiles(prev, ordered[i]) * roadFactor;
    legs.push({ step: i, from: stopLabel(prev), to: stopLabel(ordered[i]), miles: round(miles, 2), charged: true, legType: 'pickup-to-pickup' });
    prev = ordered[i];
  }
  const finalMiles = haversineMiles(prev, dest) * roadFactor;
  legs.push({ step: ordered.length, from: stopLabel(prev), to: destinationPLC, miles: round(finalMiles, 2), charged: true, legType: 'pickup-to-plc' });
  const chargeableMiles = round(sum(legs.filter(l=>l.charged).map(l=>l.miles)), 2);
  const deadheadMiles = round(sum(legs.filter(l=>!l.charged).map(l=>l.miles)), 2);
  return { legs, chargeableMiles, deadheadMiles, totalOperationalMiles: round(chargeableMiles + deadheadMiles, 2) };
}
export function stopLabel(s){ return `${s.routeName || s.centerNumber || s.id} (${s.city || ''}, ${s.state || ''})`; }
export function calculateRateTableCost({ chargeableMiles, weeklyCases, pricingMethod = 'dedicated', fuelPct = null, storage = 0, otherCharges = 0 }) {
  const dedicated = Number(rateTable?.dedicatedRatePerMile || rateTable?.dedicatedTransportationRatePerMile || 3.34);
  const averageFuelPct = fuelPct ?? averageFuelSurchargePct();
  let linehaul = chargeableMiles * dedicated;
  let rateSource = `Rate Table dedicated transportation rate: $${dedicated}/mile`;
  // Commodity matrix support can be added from rateTable ranges later. Dedicated rate is safest for route-level planning.
  if (pricingMethod === 'simple') rateSource = 'Simple $/mile override fallback';
  const fuel = linehaul * averageFuelPct;
  const totalCost = linehaul + fuel + (Number(storage)||0) + (Number(otherCharges)||0);
  const routePalletEstimate = weeklyCases / ASSUMPTIONS.casesPerPallet;
  const driverHours = chargeableMiles / ASSUMPTIONS.defaultSpeedMph;
  return {
    linehaul: round(linehaul,2), fuel: round(fuel,2), storage: round(storage,2), otherCharges: round(otherCharges,2), totalCost: round(totalCost,2),
    fuelPct: round(averageFuelPct*100,2), pallets: round(routePalletEstimate,2), routePalletEstimate: round(routePalletEstimate,2), casesPerPallet: ASSUMPTIONS.casesPerPallet, palletCalculationBasis: `Route pallet estimate = total route cases / ${ASSUMPTIONS.casesPerPallet} cases per pallet`,
    trailer: ASSUMPTIONS.collectionTrailer,
    over18PalletWarning: routePalletEstimate > ASSUMPTIONS.palletWarningThreshold,
    driverHours: round(driverHours,2), over11HourDriverWarning: driverHours > ASSUMPTIONS.driverHourLimit,
    formulaUsed: `(${round(chargeableMiles,2)} chargeable miles × $${dedicated}/mile) + ${round(averageFuelPct*100,2)}% fuel surcharge + workbook accessorials`,
    contractRuleUsed: contractRules(),
    rateSource
  };
}
export function averageFuelSurchargePct(){
  const vals = records.map(r => Number(r.fuelSurchargePct)).filter(v => Number.isFinite(v) && v > 0);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0.2406;
}
export function distanceToPLC(stop, plcName){ return haversineMiles(stop, PLC_COORDS[plcName]); }
export function recommendedPLCForStops(stops){
  const dallas=sum(stops.map(s=>distanceToPLC(s,'Dallas PLC')));
  const white=sum(stops.map(s=>distanceToPLC(s,'Whitestown PLC')));
  return dallas <= white ? 'Dallas PLC' : 'Whitestown PLC';
}
export function plcSwitchEligible(routeGroup, proposedPLC) {
  return proposedPLC === routeGroup.currentEndpointPLC || routeGroup.isRelay || routeGroup.plcMismatch;
}
export function compareScenario({ routeGroup, proposedPLC, roadFactor = 1.18 }) {
  const origin = routeGroup.origin;
  const proposed = buildLegs({ stops: routeGroup.stops, destinationPLC: proposedPLC, origin, roadFactor });
  const proposedCost = calculateRateTableCost({ chargeableMiles: proposed.chargeableMiles, weeklyCases: routeGroup.weeklyCases });
  const currentCost = {
    chargeableMiles: routeGroup.workbookMiles,
    linehaul: routeGroup.workbookLinehaul,
    fuel: routeGroup.workbookFuel,
    storage: round(sum(routeGroup.stops.map(s => s.storageFeeDollar)), 2),
    otherCharges: round(sum(routeGroup.stops.map(s => s.otherChargesDollar)), 2),
    totalCost: routeGroup.workbookTotalCost,
    pallets: routeGroup.weeklyPallets,
    driverHours: round(routeGroup.workbookMiles / ASSUMPTIONS.defaultSpeedMph, 2),
    formulaUsed: 'Workbook current contract total = SUM(linehaulCost + fuelSurchargeDollar + storageFeeDollar + otherChargesDollar); charged miles use ordered first-pickup-to-PLC path.',
    contractRuleUsed: contractRules()
  };
  const weeklySavings = round((currentCost.totalCost || 0) - proposedCost.totalCost, 2);
  const eligible = plcSwitchEligible(routeGroup, proposedPLC);
  const scheduleRule = 'Proposed rebuild keeps each center on its current pickup day, pickup time window, and Week A / Week B cadence; no day/cadence move is modeled.';
  const savingsProven = weeklySavings > 0 && eligible;
  const finalStatus = !eligible ? 'Needs Contract Validation' : (savingsProven ? 'Recommended' : 'Not Recommended');
  return {
    current: currentCost,
    proposed: { ...proposed, ...proposedCost, endpointPLC: proposedPLC },
    eligibility: { plcSwitchEligible: eligible, reason: eligible ? 'Current PLC retained or route has relay/base-vs-actual mismatch eligibility.' : 'PLC switch not recommended because route is not flagged relay or PLC-mismatch eligible.' },
    schedule: { feasible: true, ruleUsed: scheduleRule, pickupDays: routeGroup.schedule?.pickupDays || routeGroup.pickupDays, timeWindows: routeGroup.schedule?.timeWindows || [], weekCadence: routeGroup.weekPatterns },
    savings: {
      weeklyMilesSaved: round((currentCost.chargeableMiles || 0) - proposed.chargeableMiles, 2),
      weeklyCostSaved: savingsProven ? weeklySavings : 0,
      annualCostSaved: savingsProven ? round(weeklySavings * 52, 2) : 0,
      savingsProven,
      formulaUsed: `weekly savings = current contract cost ${round(currentCost.totalCost,2)} - proposed contract cost ${round(proposedCost.totalCost,2)}; annual savings = positive weekly savings × 52`,
      finalStatus
    }
  };
}
export function generateDeterministicCandidates({ scope='all', routeName='', objective='savings', maxRoutes=12, roadFactor=1.18 } = {}) {
  let groups = groupRouteRecords({ openOnly: true });
  if (scope === 'selected' && routeName) groups = groups.filter(g => cleanRouteName(g.routeName) === cleanRouteName(routeName));
  if (scope === 'relay') groups = groups.filter(g => g.isRelay || g.plcMismatch || ['ALLENTOWN','BUFFALO','PHILLY'].includes(cleanRouteName(g.routeName)));
  groups = groups.slice(0, Number(maxRoutes)||12);
  const candidates=[];
  for (const g of groups) {
    const recommended = recommendedPLCForStops(g.stops);
    const plcOptions = unique([g.currentEndpointPLC, ...(g.isRelay || g.plcMismatch ? [recommended, 'Dallas PLC', 'Whitestown PLC'] : [])]).filter(Boolean);
    for (const plc of plcOptions) {
      const cmp = compareScenario({ routeGroup: g, proposedPLC: plc, roadFactor });
      const type = plc === g.currentEndpointPLC ? 'Keep / Validate Current Route' : (g.isRelay ? 'Relay PLC Validation' : 'Full Route PLC Rebuild');
      candidates.push({
        recommendationType: type,
        currentRoutesImpacted: [g.routeName],
        newRouteName: `${cleanRouteName(g.routeName)}_${plc.includes('Dallas')?'DALLAS':'WHITESTOWN'}_REBUILD`,
        newPLC: plc,
        stops: g.stops.map((s,i)=>({ id:s.id, name:s.routeName, centerNumber:s.centerNumber, city:s.city, state:s.state, currentRoute:s.routeNameMckesson, proposedStop:i+1, ...stopScheduleSummary(s) })),
        currentChargeableMiles: cmp.current.chargeableMiles,
        newChargeableMiles: cmp.proposed.chargeableMiles,
        currentFuel: cmp.current.fuel,
        newFuel: cmp.proposed.fuel,
        currentCost: cmp.current.totalCost,
        newCost: cmp.proposed.totalCost,
        weeklySavings: cmp.savings.weeklyCostSaved,
        annualSavings: cmp.savings.annualCostSaved,
        weeklyMilesSaved: cmp.savings.weeklyMilesSaved,
        currentPLC: g.currentEndpointPLC,
        proposedPLC: plc,
        pickupDayTimeWindow: cmp.schedule.pickupDays?.join('; ') || '',
        weekAB: cmp.schedule.weekCadence?.join('/') || '',
        formulaUsed: cmp.savings.formulaUsed,
        contractRuleUsed: `charge starts at ${ASSUMPTIONS.chargeStartsAt}; deadhead charged=${ASSUMPTIONS.deadheadCharged}; linehaul/fuel from Rate Table; ${ASSUMPTIONS.collectionTrailer}; ${ASSUMPTIONS.casesPerPallet} cases = 1 pallet`,
        scheduleRuleUsed: cmp.schedule.ruleUsed,
        finalStatus: cmp.savings.finalStatus,
        reason: `Contract-aware route comparison for ${g.routeName}; deadhead excluded from cost; chargeable miles start at first pickup and end at ${plc}. ${cmp.savings.finalStatus === 'Recommended' ? 'Proposed total contract cost is lower.' : 'Not labeled as savings unless proposed contract cost is lower and route is eligible.'}`,
        risks: validationRisks(g, cmp.proposed),
        confidence: 'Medium',
        calculationBasis: 'Contract-aware comparison: current/proposed costs use chargeable first-pickup-to-PLC miles, Rate Table linehaul, fuel surcharge, accessorials when present, and existing pickup day/time/cadence constraints. Fallback road-mile estimate unless actual truck route is loaded.',
        routeGroup: g
      });
    }
  }
  return candidates.sort((a,b)=>b.weeklySavings-a.weeklySavings).slice(0, 20);
}
export function validationRisks(routeGroup, proposed) {
  const risks=[];
  if (routeGroup.isRelay) risks.push('Relay route: validate Dallas/Whitestown volume need and relay staffing before change.');
  if (proposed.over18PalletWarning) risks.push('Over 18-pallet caution threshold for 48 ft refrigerated collection route.');
  if (proposed.over11HourDriverWarning) risks.push('Estimated drive time exceeds 11-hour driver limit; validate split/team/relay need.');
  if (!routeGroup.origin) risks.push('Truck origin not mapped for this route; deadhead visibility may be missing.');
  if (!routeGroup.weeklyCases) risks.push('Weekly case volume missing or zero.');
  return risks;
}

function scheduleKeyForStop(stop) {
  const days = scheduleForStop(stop).map(x => `${x.day}:${x.value}`).sort().join('|') || 'unscheduled';
  const week = [stop.weekPatternA ? 'A' : '', stop.weekPatternB ? 'B' : ''].filter(Boolean).join('/') || 'A/B';
  return `${days}||${week}||${stop.pickupHours || ''}`;
}
function routeScheduleKey(stops) { return unique((stops || []).map(scheduleKeyForStop)).sort().join(' + '); }
function routePallets(stops) { return sum((stops || []).map(s => s.weeklyCases)) / ASSUMPTIONS.casesPerPallet; }
function routeCases(stops) { return sum((stops || []).map(s => s.weeklyCases)); }
function routeEndpointForStops(stops, fallback='Dallas PLC') {
  const counts = countBy((stops || []).map(routeEndpointForRecord));
  return mostCommon(counts) || fallback;
}
function proposedRouteCost(route, roadFactor=1.18) {
  const endpointPLC = route.endpointPLC || routeEndpointForStops(route.stops || []);
  const legs = buildLegs({ stops: route.stops || [], destinationPLC: endpointPLC, origin: originForRouteName(route.routeName), roadFactor });
  const cases = routeCases(route.stops);
  const storage = round(sum((route.stops || []).map(s => s.storageFeeDollar)), 2);
  const otherCharges = round(sum((route.stops || []).map(s => s.otherChargesDollar)), 2);
  const cost = calculateRateTableCost({ chargeableMiles: legs.chargeableMiles, weeklyCases: cases, storage, otherCharges });
  return { ...route, endpointPLC, cases: round(cases,2), pallets: round(cases / ASSUMPTIONS.casesPerPallet,2), legs, cost };
}
function currentNetworkBaseline(groups) {
  const linehaul = round(sum(groups.map(g => g.workbookLinehaul)), 2);
  const fuel = round(sum(groups.map(g => g.workbookFuel)), 2);
  const storage = round(sum(groups.flatMap(g => g.stops || []).map(s => s.storageFeeDollar)), 2);
  const otherCharges = round(sum(groups.flatMap(g => g.stops || []).map(s => s.otherChargesDollar)), 2);
  const accessorials = round(storage + otherCharges, 2);
  const stopCharges = 0;
  const totalCost = round(sum(groups.map(g => g.workbookTotalCost)), 2);
  return {
    routeCount: groups.length,
    stopCount: sum(groups.map(g => g.stopCount)),
    chargedMiles: round(sum(groups.map(g => g.workbookMiles)),2),
    fuel,
    surcharge: fuel,
    linehaul,
    storage,
    stopCharges,
    accessorials,
    otherCharges,
    totalCost,
    annualCost: round(totalCost*52,2),
    pallets: round(sum(groups.map(g => g.routePalletEstimate)),2),
    cases: round(sum(groups.map(g => g.weeklyCases)),2),
    costBreakdown: { linehaul, fuel, surcharge: fuel, stopCharges, accessorials, storage, otherCharges, totalCost }
  };
}

function blankDistributionEntry(plc) {
  return { plc, centerCount: 0, centerPct: 0, cases: 0, pallets: 0, weeklyCost: 0, annualCost: 0 };
}
function normalizeDistributionName(plc) {
  return String(plc || '').toLowerCase().includes('whitestown') ? 'Whitestown PLC' : 'Dallas PLC';
}
function finalizeDistributionMix(mix) {
  const totalCenters = sum(Object.values(mix).map(v => v.centerCount));
  const totalCases = sum(Object.values(mix).map(v => v.cases));
  const totalPallets = sum(Object.values(mix).map(v => v.pallets));
  const totalWeeklyCost = sum(Object.values(mix).map(v => v.weeklyCost));
  for (const entry of Object.values(mix)) {
    entry.centerPct = totalCenters ? round((entry.centerCount / totalCenters) * 100, 2) : 0;
    entry.cases = round(entry.cases, 2);
    entry.pallets = round(entry.pallets, 2);
    entry.weeklyCost = round(entry.weeklyCost, 2);
    entry.annualCost = round(entry.weeklyCost * 52, 2);
  }
  return { Dallas: mix['Dallas PLC'], Whitestown: mix['Whitestown PLC'], totals: { centerCount: totalCenters, cases: round(totalCases, 2), pallets: round(totalPallets, 2), weeklyCost: round(totalWeeklyCost, 2), annualCost: round(totalWeeklyCost * 52, 2) } };
}
function currentDistributionMix(groups) {
  const mix = { 'Dallas PLC': blankDistributionEntry('Dallas PLC'), 'Whitestown PLC': blankDistributionEntry('Whitestown PLC') };
  for (const g of groups) {
    const costPerCase = g.weeklyCases ? g.workbookTotalCost / g.weeklyCases : 0;
    for (const stop of g.stops || []) {
      const plc = normalizeDistributionName(routeEndpointForRecord(stop));
      const cases = Number(stop.weeklyCases) || 0;
      mix[plc].centerCount += 1;
      mix[plc].cases += cases;
      mix[plc].pallets += cases / ASSUMPTIONS.casesPerPallet;
      mix[plc].weeklyCost += costPerCase ? cases * costPerCase : Number(stop.totalRouteCost) || 0;
    }
  }
  return finalizeDistributionMix(mix);
}
function proposedDistributionMix(pricedRoutes) {
  const mix = { 'Dallas PLC': blankDistributionEntry('Dallas PLC'), 'Whitestown PLC': blankDistributionEntry('Whitestown PLC') };
  for (const route of pricedRoutes) {
    const plc = normalizeDistributionName(route.endpointPLC);
    const routeCases = Number(route.cases) || routeCasesForStops(route.stops || []);
    const costPerCase = routeCases ? (Number(route.cost?.totalCost) || 0) / routeCases : 0;
    for (const stop of route.stops || []) {
      const cases = Number(stop.weeklyCases) || 0;
      mix[plc].centerCount += 1;
      mix[plc].cases += cases;
      mix[plc].pallets += cases / ASSUMPTIONS.casesPerPallet;
      mix[plc].weeklyCost += costPerCase ? cases * costPerCase : 0;
    }
  }
  return finalizeDistributionMix(mix);
}
function routeCasesForStops(stops) { return sum((stops || []).map(s => s.weeklyCases)); }
function distributionChange(currentMix, proposedMix) {
  const entry = key => ({
    centerCount: (proposedMix[key]?.centerCount || 0) - (currentMix[key]?.centerCount || 0),
    centerPct: round((proposedMix[key]?.centerPct || 0) - (currentMix[key]?.centerPct || 0), 2),
    cases: round((proposedMix[key]?.cases || 0) - (currentMix[key]?.cases || 0), 2),
    pallets: round((proposedMix[key]?.pallets || 0) - (currentMix[key]?.pallets || 0), 2),
    weeklyCost: round((proposedMix[key]?.weeklyCost || 0) - (currentMix[key]?.weeklyCost || 0), 2),
    annualCost: round((proposedMix[key]?.annualCost || 0) - (currentMix[key]?.annualCost || 0), 2)
  });
  return { Dallas: entry('Dallas'), Whitestown: entry('Whitestown') };
}
function centersMovedByDistribution(pricedRoutes) {
  const dallasToWhitestown = [], whitestownToDallas = [];
  for (const route of pricedRoutes) {
    const proposedPLC = normalizeDistributionName(route.endpointPLC);
    for (const stop of route.stops || []) {
      const currentPLC = normalizeDistributionName(routeEndpointForRecord(stop));
      if (currentPLC === proposedPLC) continue;
      const row = {
        id: stop.id || '',
        centerNumber: stop.centerNumber || '',
        centerName: stop.routeName || stop.centerName || stop.name || '',
        city: stop.city || '',
        state: stop.state || '',
        currentRoute: stop.routeNameMckesson || '',
        currentPLC,
        proposedPLC,
        proposedGroup: route.routeName || ''
      };
      if (currentPLC === 'Dallas PLC' && proposedPLC === 'Whitestown PLC') dallasToWhitestown.push(row);
      if (currentPLC === 'Whitestown PLC' && proposedPLC === 'Dallas PLC') whitestownToDallas.push(row);
    }
  }
  return { dallasToWhitestown, whitestownToDallas };
}
function routeValidationSignals(route, validation) {
  const missingTime = (route.stops || []).some(s => !s.pickupHours);
  const truckMilesEstimated = !(route.legs?.truckValidMiles === true);
  const routeRisks = validation.risks.filter(r => String(r).startsWith(`${route.routeName}:`));
  if (missingTime) routeRisks.push(`${route.routeName}: pickup time window missing for at least one center.`);
  if (truckMilesEstimated) routeRisks.push(`${route.routeName}: truck-valid 48 ft refrigerated mileage is not loaded; miles are estimated.`);
  return { missingTimeWindow: missingTime, truckMilesEstimated, risks: unique(routeRisks) };
}
function proposedRouteGroup(route, validation, groups=[]) {
  const currentRouteNames = unique((route.stops || []).map(s => cleanRouteName(s.routeNameMckesson)).filter(Boolean));
  const currentGroups = groups.filter(g => currentRouteNames.includes(cleanRouteName(g.routeName)));
  const currentCost = round(sum(currentGroups.map(g => g.workbookTotalCost)), 2);
  const currentMiles = round(sum(currentGroups.map(g => g.workbookMiles)), 2);
  const proposedCost = Number(route.cost?.totalCost) || 0;
  const weeklySavingsRaw = round(currentCost - proposedCost, 2);
  const signals = routeValidationSignals(route, validation);
  const validationBlocked = signals.missingTimeWindow || signals.truckMilesEstimated || signals.risks.length;
  const savingsStatus = validationBlocked ? 'Needs Validation' : (weeklySavingsRaw > 0 ? 'Recommended' : 'Not Recommended');
  const orderedStops = route.legs?.legs?.length ? (route.stops || []) : (route.stops || []);
  return {
    proposedGroupName: route.routeName,
    proposedPLC: route.endpointPLC,
    centersIncluded: (route.stops || []).map(s => ({ id: s.id || '', centerNumber: s.centerNumber || '', centerName: s.routeName || s.centerName || '', city: s.city || '', state: s.state || '', currentRoute: s.routeNameMckesson || '', currentPLC: routeEndpointForRecord(s) })),
    pickupDay: unique((route.stops || []).flatMap(s => scheduleForStop(s).map(x => `${x.day}:${x.value}`))).join('; ') || 'Not scheduled',
    weekAB: unique((route.stops || []).map(s => [s.weekPatternA ? 'A' : '', s.weekPatternB ? 'B' : ''].filter(Boolean).join('/')).filter(Boolean)).join(', ') || 'A/B',
    pickupTimeWindow: unique((route.stops || []).map(s => s.pickupHours).filter(Boolean)).join(', ') || 'Missing',
    routeSequence: orderedStops.map((s, i) => ({ stop: i + 1, id: s.id || '', centerNumber: s.centerNumber || '', centerName: s.routeName || s.centerName || '', lat: s.lat, lng: s.lng })),
    reasonForGrouping: `Grouped as a full route-group candidate by PLC (${route.endpointPLC}), schedule key (${routeScheduleKey(route.stops)}), and ${ASSUMPTIONS.collectionTrailer} pallet utilization.`,
    riskNotes: signals.risks,
    savingsProof: {
      currentTotalChargedMiles: currentMiles,
      proposedChargedMiles: route.legs.chargeableMiles,
      currentWeeklyCost: currentCost,
      proposedWeeklyCost: round(proposedCost, 2),
      weeklySavings: validationBlocked || weeklySavingsRaw <= 0 ? 0 : weeklySavingsRaw,
      annualSavings: validationBlocked || weeklySavingsRaw <= 0 ? 0 : round(weeklySavingsRaw * 52, 2),
      centerCount: (route.stops || []).length,
      pallets: route.pallets,
      trailerUtilizationPct: round((route.pallets / ASSUMPTIONS.palletWarningThreshold) * 100, 2),
      costPerPallet: route.pallets ? round(proposedCost / route.pallets, 2) : 0,
      costPerMile: route.legs.chargeableMiles ? round(proposedCost / route.legs.chargeableMiles, 2) : 0,
      formulaUsed: `weekly savings = current group workbook cost ${currentCost} - proposed contract cost ${round(proposedCost, 2)}; proposed cost = (${route.legs.chargeableMiles} charged miles × rate/mile) + fuel + workbook accessorials when present; annual savings = weekly savings × 52`,
      contractRuleUsed: `Charge begins at first pickup; deadhead excluded unless contract changes; ${ASSUMPTIONS.casesPerPallet} cases = 1 pallet; ${ASSUMPTIONS.collectionTrailer}.`,
      scheduleRuleUsed: 'No center is moved off its scheduled pickup day, pickup window, or Week A/B cadence in this proposed route group.',
      savingsStatus
    }
  };
}
function validateNetworkRoutes(routes) {
  const risks = [];
  let contractValid = true, scheduleValid = true, timeWindowValid = true, weekCadenceValid = true;
  for (const route of routes) {
    const schedules = unique((route.stops || []).map(scheduleKeyForStop));
    if (route.requireSameSchedule !== false && schedules.length > 1) {
      scheduleValid = false; weekCadenceValid = false; timeWindowValid = false;
      risks.push(`${route.routeName}: mixed pickup day/time/Week A-B cadence; needs dispatch validation.`);
    }
    const changedEndpoint = (route.stops || []).some(s => routeEndpointForRecord(s) !== route.endpointPLC);
    if (changedEndpoint) {
      const eligible = (route.stops || []).every(s => String(s.routeType).toLowerCase() === 'relay' || s.plcChanged || s.basePLC !== s.actualPLC);
      if (!eligible) { contractValid = false; risks.push(`${route.routeName}: PLC reassignment includes non-relay/non-mismatch centers.`); }
    }
    const pallets = routePallets(route.stops || []);
    if (pallets > ASSUMPTIONS.palletWarningThreshold) risks.push(`${route.routeName}: ${round(pallets,1)} pallets exceeds ${ASSUMPTIONS.palletWarningThreshold}-pallet validation threshold.`);
  }
  return { contractValid, scheduleValid, timeWindowValid, weekCadenceValid, risks: unique(risks) };
}
function networkScenario({ id, scenarioType, description, groups, routes, roadFactor=1.18 }) {
  const baseline = currentNetworkBaseline(groups);
  const pricedRoutes = routes.map(r => proposedRouteCost(r, roadFactor));
  const validation = validateNetworkRoutes(pricedRoutes);
  const proposedLinehaul = round(sum(pricedRoutes.map(r => r.cost.linehaul)), 2);
  const proposedFuel = round(sum(pricedRoutes.map(r => r.cost.fuel)), 2);
  const proposedStorage = round(sum(pricedRoutes.map(r => r.cost.storage)), 2);
  const proposedAccessorials = round(sum(pricedRoutes.map(r => r.cost.otherCharges)), 2);
  const proposedStopCharges = 0;
  const proposedTotalCost = round(sum(pricedRoutes.map(r => r.cost.totalCost)), 2);
  const proposed = {
    routeCount: pricedRoutes.length,
    stopCount: sum(pricedRoutes.map(r => (r.stops || []).length)),
    chargedMiles: round(sum(pricedRoutes.map(r => r.legs.chargeableMiles)),2),
    fuel: proposedFuel,
    surcharge: proposedFuel,
    linehaul: proposedLinehaul,
    storage: proposedStorage,
    stopCharges: proposedStopCharges,
    accessorials: round(proposedStorage + proposedAccessorials, 2),
    otherCharges: proposedAccessorials,
    totalCost: proposedTotalCost,
    annualCost: round(proposedTotalCost*52,2),
    pallets: round(sum(pricedRoutes.map(r => r.pallets)),2),
    cases: round(sum(pricedRoutes.map(r => r.cases)),2),
    costBreakdown: { linehaul: proposedLinehaul, fuel: proposedFuel, surcharge: proposedFuel, stopCharges: proposedStopCharges, accessorials: round(proposedStorage + proposedAccessorials, 2), storage: proposedStorage, otherCharges: proposedAccessorials, totalCost: proposedTotalCost }
  };
  const currentMix = currentDistributionMix(groups);
  const proposedMix = proposedDistributionMix(pricedRoutes);
  const movedCenters = centersMovedByDistribution(pricedRoutes);
  const proposedRouteGroups = pricedRoutes.map(r => proposedRouteGroup(r, validation, groups));
  const groupSavings = round(sum(proposedRouteGroups.map(g => g.savingsProof?.weeklySavings || 0)), 2);
  const costDifference = round(proposed.totalCost - baseline.totalCost, 2);
  const weeklySavingsRaw = round(baseline.totalCost - proposed.totalCost, 2);
  const valid = validation.contractValid && validation.scheduleValid && validation.timeWindowValid && validation.weekCadenceValid;
  const estimatedMileage = true;
  const isCostIncrease = proposed.totalCost >= baseline.totalCost;
  const finalStatus = isCostIncrease ? 'Rejected Scenario' : (!valid || estimatedMileage ? 'Needs Contract Validation' : 'Recommended');
  const weeklySavings = weeklySavingsRaw > 0 ? weeklySavingsRaw : 0;
  const rejectionReason = isCostIncrease ? `Rejected because proposed total cost ${proposed.totalCost} is greater than or equal to current total cost ${baseline.totalCost}; cost increase = ${costDifference}.` : '';
  const affectedRoutes = unique(pricedRoutes.flatMap(r => (r.stops || []).map(s => s.routeNameMckesson)).filter(Boolean));
  const affectedCenters = unique(pricedRoutes.flatMap(r => (r.stops || []).map(s => s.centerNumber || s.id)).filter(Boolean));
  const mileageRisk = 'Truck-valid 48 ft refrigerated route miles are not loaded; proposed miles use estimated road-factor mileage and must be validated before recommendation status can be upgraded.';
  return {
    id, scenarioType, description,
    currentNetworkCost: baseline.totalCost,
    proposedNetworkCost: proposed.totalCost,
    costDifference,
    costDeltaLabel: costDifference > 0 ? '✗ Cost Increase' : '✓ Savings Candidate',
    rejectionReason,
    currentAnnualCost: baseline.annualCost,
    proposedAnnualCost: proposed.annualCost,
    savings: weeklySavings,
    annualSavings: round(weeklySavings * 52, 2),
    savingsPct: baseline.totalCost ? round((weeklySavings / baseline.totalCost) * 100, 2) : 0,
    affectedRoutes,
    affectedCenters,
    currentDistributionMix: currentMix,
    proposedDistributionMix: proposedMix,
    distributionChange: distributionChange(currentMix, proposedMix),
    centersMovedDallasToWhitestown: movedCenters.dallasToWhitestown,
    centersMovedWhitestownToDallas: movedCenters.whitestownToDallas,
    totalReassignmentSavings: groupSavings,
    proposedRouteGroups,
    operationalRisk: unique([...(validation.risks || []), mileageRisk]).join(' '),
    confidence: finalStatus === 'Needs Contract Validation' ? 'Low' : (weeklySavings > 0 ? 'Medium' : 'Low'),
    validation: { ...validation, truckValidMileageAvailable: false },
    baseline,
    proposed,
    routeCount: proposed.routeCount,
    routes: pricedRoutes.map(r => ({ routeName: r.routeName, endpointPLC: r.endpointPLC, stopCount: (r.stops||[]).length, chargedMiles: r.legs.chargeableMiles, totalCost: r.cost.totalCost, scheduleKey: routeScheduleKey(r.stops), centers: (r.stops||[]).map(s => s.centerNumber || s.id) })),
    formulaUsed: `weekly savings = current network weekly cost ${baseline.totalCost} - proposed network weekly cost ${proposed.totalCost}; cost difference = proposed - current = ${costDifference}; annual savings = positive weekly savings × 52; deterministic savings proof is calculated after AI/group generation, not by the AI narrative.`,
    contractRuleUsed: contractRules(),
    scheduleRuleUsed: 'Network scenarios preserve each center pickup day, pickup time window, and Week A/B cadence unless flagged in operationalRisk.',
    finalStatus
  };
}
function currentRoutesFromGroups(groups) { return groups.map(g => ({ routeName: g.routeName, endpointPLC: g.currentEndpointPLC, stops: g.stops, requireSameSchedule: false })); }
function clusterStops(stops, { prefix, endpointPLC, maxPallets=ASSUMPTIONS.palletWarningThreshold, requireSameSchedule=true }) {
  const sorted = [...stops].sort((a,b)=>scheduleKeyForStop(a).localeCompare(scheduleKeyForStop(b)) || String(a.state).localeCompare(String(b.state)) || String(a.city).localeCompare(String(b.city)));
  const routes=[]; let current=[]; let idx=1;
  for (const stop of sorted) {
    const nextPallets = routePallets([...current, stop]);
    const sameSchedule = !current.length || scheduleKeyForStop(current[0]) === scheduleKeyForStop(stop);
    if (current.length && (nextPallets > maxPallets || (requireSameSchedule && !sameSchedule))) {
      routes.push({ routeName: `${prefix}-${idx++}`, endpointPLC, stops: current, requireSameSchedule }); current=[];
    }
    current.push(stop);
  }
  if (current.length) routes.push({ routeName: `${prefix}-${idx++}`, endpointPLC, stops: current, requireSameSchedule });
  return routes;
}
function consolidationRoutes(groups, maxPallets=ASSUMPTIONS.palletWarningThreshold) {
  const buckets = new Map();
  for (const g of groups) {
    const key = `${g.currentEndpointPLC}||${routeScheduleKey(g.stops)}`;
    if (!buckets.has(key)) buckets.set(key, { endpointPLC: g.currentEndpointPLC, stops: [] });
    buckets.get(key).stops.push(...g.stops);
  }
  return [...buckets.values()].flatMap((b,i)=>clusterStops(b.stops, { prefix:`CONSOLIDATED-${i+1}-${b.endpointPLC.includes('Dallas')?'DAL':'WHT'}`, endpointPLC:b.endpointPLC, maxPallets, requireSameSchedule:true }));
}
function splitRoutes(groups, maxPallets=ASSUMPTIONS.palletWarningThreshold) {
  return groups.flatMap(g => routePallets(g.stops) > maxPallets || (g.workbookMiles / ASSUMPTIONS.defaultSpeedMph) > ASSUMPTIONS.driverHourLimit
    ? clusterStops(g.stops, { prefix:`SPLIT-${g.routeKey}`, endpointPLC:g.currentEndpointPLC, maxPallets, requireSameSchedule:false })
    : [{ routeName:g.routeName, endpointPLC:g.currentEndpointPLC, stops:g.stops, requireSameSchedule:false }]);
}
function eligiblePlcReassignmentRoutes(groups) {
  return groups.map(g => {
    const endpointPLC = (g.isRelay || g.plcMismatch) ? recommendedPLCForStops(g.stops) : g.currentEndpointPLC;
    return { routeName:`${g.routeName}-${endpointPLC.includes('Dallas')?'DAL':'WHT'}`, endpointPLC, stops:g.stops, requireSameSchedule:false };
  });
}

export function generateNetworkCandidates({ maxScenarios=20, roadFactor=1.18 } = {}) {
  const groups = groupRouteRecords({ openOnly: true });
  const scenarios = [];
  const add = (scenarioType, description, routes, idx) => scenarios.push(networkScenario({ id:`${scenarioType}-${idx}`, scenarioType, description, groups, routes, roadFactor }));
  [18,16,14,12].forEach((max, idx) => add('route consolidation', `Consolidate compatible routes across the full network by endpoint, pickup day/time, and Week A/B cadence at <=${max} pallets.`, consolidationRoutes(groups, max), idx+1));
  [18,15,12].forEach((max, idx) => add('route splitting', `Split overloaded or long route groups network-wide at <=${max} pallets while preserving current PLC and schedule.`, splitRoutes(groups, max), idx+1));
  add('PLC reassignment', 'Reassign only relay or Base/Actual mismatch routes to nearest/best PLC; all other routes remain at current PLC.', eligiblePlcReassignmentRoutes(groups), 1);
  [18,15,12].forEach((max, idx) => add('PLC reassignment + consolidation', `Apply eligible PLC reassignment, then consolidate by endpoint and schedule at <=${max} pallets.`, consolidationRoutes(eligiblePlcReassignmentRoutes(groups).map(r => summarizeRouteGroup(r.routeName, r.stops.map(s => ({...s, actualPLC:r.endpointPLC, basePLC:r.endpointPLC})))), max), idx+1));
  ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].forEach((day, idx) => {
    const dayStops = groups.flatMap(g => g.stops.filter(s => scheduleForStop(s).some(x => x.day === day)));
    if (dayStops.length) {
      const routes = currentRoutesFromGroups(groups).filter(r => !(r.stops||[]).some(s => scheduleForStop(s).some(x => x.day === day)))
        .concat(clusterStops(dayStops, { prefix:`DAY-BALANCE-${day.toUpperCase()}`, endpointPLC:routeEndpointForStops(dayStops), maxPallets:ASSUMPTIONS.palletWarningThreshold, requireSameSchedule:true }));
      add('pickup-day balancing', `Balance all ${day} eligible pickups into schedule-compatible route clusters without moving centers to unscheduled days.`, routes, idx+1);
    }
  });
  [10,12,14].forEach((min, idx) => {
    const low = groups.filter(g => g.routePalletEstimate <= min);
    const high = groups.filter(g => g.routePalletEstimate > min);
    const routes = currentRoutesFromGroups(high).concat(consolidationRoutes(low, ASSUMPTIONS.palletWarningThreshold));
    add('trailer utilization balancing', `Merge low-utilization routes at or below ${min} pallets by endpoint and schedule to improve 48 ft trailer utilization.`, routes, idx+1);
  });
  return scenarios
    .filter(s => s.validation.contractValid && s.validation.scheduleValid && s.validation.timeWindowValid && s.validation.weekCadenceValid)
    .sort((a,b)=>b.savings-a.savings || b.savingsPct-a.savingsPct)
    .slice(0, Number(maxScenarios)||20);
}
