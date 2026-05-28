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
  const pallets = cases / ASSUMPTIONS.casesPerPallet;
  const linehaul = sum(stops.map(s => s.linehaulCost));
  const fuel = sum(stops.map(s => s.fuelSurchargeDollar));
  const totalCost = sum(stops.map(s => s.totalRouteCost || s.sumBilledWeekly));
  const miles = sum(stops.map(s => s.weeklyMiles));
  return {
    routeName,
    routeKey: cleanRouteName(routeName),
    stops: orderStopsNearestNeighbor(stops, endpointPLC),
    stopCount: stops.length,
    currentEndpointPLC: endpointPLC,
    basePLC: mostCommon(baseCounts),
    actualPLC: mostCommon(actualCounts),
    routeType,
    origin,
    weeklyCases: round(cases, 2),
    weeklyPallets: round(pallets, 2),
    weeklyLiters: round(sum(stops.map(s => s.weeklyLiters)), 2),
    workbookMiles: round(miles, 2),
    workbookLinehaul: round(linehaul, 2),
    workbookFuel: round(fuel, 2),
    workbookTotalCost: round(totalCost, 2),
    workbookCostPerCase: cases ? round(totalCost / cases, 2) : 0,
    weekPatterns: unique(stops.map(s => [s.weekPatternA ? 'A' : '', s.weekPatternB ? 'B' : ''].filter(Boolean).join('/')).filter(Boolean)),
    pickupDays: unique(stops.map(firstPickupDay).filter(Boolean)),
    isRelay: stops.some(s => String(s.routeType).toLowerCase() === 'relay' || s.plcChanged),
    plcMismatch: stops.some(s => s.basePLC !== s.actualPLC && s.basePLC !== '#N/A' && s.actualPLC !== '#N/A'),
    palletWarning: pallets > ASSUMPTIONS.palletWarningThreshold
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
export function buildLegs({ stops, destinationPLC, origin = null, roadFactor = 1.18 }) {
  const ordered = orderStopsNearestNeighbor(stops, destinationPLC);
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
export function calculateRateTableCost({ chargeableMiles, weeklyCases, pricingMethod = 'dedicated', fuelPct = null }) {
  const dedicated = Number(rateTable?.dedicatedRatePerMile || 3.34);
  const averageFuelPct = fuelPct ?? averageFuelSurchargePct();
  let linehaul = chargeableMiles * dedicated;
  let rateSource = `Rate Table dedicated transportation rate: $${dedicated}/mile`;
  // Commodity matrix support can be added from rateTable ranges later. Dedicated rate is safest for route-level planning.
  if (pricingMethod === 'simple') rateSource = 'Simple $/mile override fallback';
  const fuel = linehaul * averageFuelPct;
  const totalCost = linehaul + fuel;
  const pallets = weeklyCases / ASSUMPTIONS.casesPerPallet;
  const driverHours = chargeableMiles / ASSUMPTIONS.defaultSpeedMph;
  return {
    linehaul: round(linehaul,2), fuel: round(fuel,2), totalCost: round(totalCost,2),
    fuelPct: round(averageFuelPct*100,2), pallets: round(pallets,2), casesPerPallet: ASSUMPTIONS.casesPerPallet,
    trailer: ASSUMPTIONS.collectionTrailer,
    over18PalletWarning: pallets > ASSUMPTIONS.palletWarningThreshold,
    driverHours: round(driverHours,2), over11HourDriverWarning: driverHours > ASSUMPTIONS.driverHourLimit,
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
export function compareScenario({ routeGroup, proposedPLC, roadFactor = 1.18 }) {
  const origin = routeGroup.origin;
  const proposed = buildLegs({ stops: routeGroup.stops, destinationPLC: proposedPLC, origin, roadFactor });
  const proposedCost = calculateRateTableCost({ chargeableMiles: proposed.chargeableMiles, weeklyCases: routeGroup.weeklyCases });
  const currentCost = {
    chargeableMiles: routeGroup.workbookMiles, linehaul: routeGroup.workbookLinehaul, fuel: routeGroup.workbookFuel,
    totalCost: routeGroup.workbookTotalCost, pallets: routeGroup.weeklyPallets,
    driverHours: round(routeGroup.workbookMiles / ASSUMPTIONS.defaultSpeedMph, 2)
  };
  const weeklySavings = round((currentCost.totalCost || 0) - proposedCost.totalCost, 2);
  return {
    current: currentCost,
    proposed: { ...proposed, ...proposedCost, endpointPLC: proposedPLC },
    savings: { weeklyMilesSaved: round((currentCost.chargeableMiles || 0) - proposed.chargeableMiles, 2), weeklyCostSaved: weeklySavings, annualCostSaved: round(weeklySavings*52, 2) }
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
    const plcOptions = unique([recommended, g.currentEndpointPLC, 'Dallas PLC', 'Whitestown PLC']).filter(Boolean);
    for (const plc of plcOptions) {
      const cmp = compareScenario({ routeGroup: g, proposedPLC: plc, roadFactor });
      const type = plc === g.currentEndpointPLC ? 'Keep / Validate Current Route' : (g.isRelay ? 'Relay PLC Validation' : 'Full Route PLC Rebuild');
      candidates.push({
        recommendationType: type,
        currentRoutesImpacted: [g.routeName],
        newRouteName: `${cleanRouteName(g.routeName)}_${plc.includes('Dallas')?'DALLAS':'WHITESTOWN'}_REBUILD`,
        newPLC: plc,
        stops: g.stops.map((s,i)=>({ id:s.id, name:s.routeName, centerNumber:s.centerNumber, city:s.city, state:s.state, currentRoute:s.routeNameMckesson, proposedStop:i+1 })),
        currentChargeableMiles: cmp.current.chargeableMiles,
        newChargeableMiles: cmp.proposed.chargeableMiles,
        currentFuel: cmp.current.fuel,
        newFuel: cmp.proposed.fuel,
        currentCost: cmp.current.totalCost,
        newCost: cmp.proposed.totalCost,
        weeklySavings: cmp.savings.weeklyCostSaved,
        annualSavings: cmp.savings.annualCostSaved,
        weeklyMilesSaved: cmp.savings.weeklyMilesSaved,
        reason: `Route-level comparison for ${g.routeName}; deadhead excluded from cost; chargeable miles start at first pickup and end at ${plc}.`,
        risks: validationRisks(g, cmp.proposed),
        confidence: 'Medium',
        calculationBasis: 'Fallback road-mile estimate unless actual Geoapify route loaded by calculate-route API',
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
