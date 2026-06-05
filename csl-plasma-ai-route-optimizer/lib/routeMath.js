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
