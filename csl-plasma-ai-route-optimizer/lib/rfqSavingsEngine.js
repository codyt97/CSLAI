import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const records = require('./data/records.json');
const plcCoordsRaw = require('./data/plcCoords.json');
const PLC_COORDS = normalizePlcCoords(plcCoordsRaw);


function normalizePlcCoords(raw) {
  return {
    'Dallas PLC': raw?.['Dallas PLC'] || { lat: 32.7767, lng: -96.7970, name: 'Dallas PLC' },
    'Whitestown PLC': raw?.['Whitestown PLC'] || { lat: 39.9973, lng: -86.3458, name: 'Whitestown PLC' }
  };
}

function haversineMiles(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return 0;
  const radiusMiles = 3958.7613;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusMiles * Math.asin(Math.sqrt(h));
}

function routeEndpointForRecord(record) {
  return validPlc(record.actualPLC) || validPlc(record.basePLC) || 'Dallas PLC';
}

function nearestNeighborMiles(stops, endpointPLC) {
  const points = stops.filter((stop) => stop.hasCoords && typeof stop.lat === 'number' && typeof stop.lng === 'number');
  const destination = PLC_COORDS[endpointPLC] || PLC_COORDS['Dallas PLC'];
  if (!points.length || !destination) return 0;
  let remaining = [...points];
  let current = remaining.reduce((best, stop) => (!best || haversineMiles(stop, destination) > haversineMiles(best, destination) ? stop : best), null);
  const ordered = [];
  while (current) {
    ordered.push(current);
    remaining = remaining.filter((stop) => stop.id !== current.id);
    current = remaining.reduce((best, stop) => (!best || haversineMiles(current, stop) < haversineMiles(current, best) ? stop : best), null);
  }
  let miles = 0;
  for (let i = 1; i < ordered.length; i += 1) miles += haversineMiles(ordered[i - 1], ordered[i]) * 1.18;
  miles += haversineMiles(ordered.at(-1), destination) * 1.18;
  return miles;
}

function groupRouteRecords({ openOnly = true } = {}) {
  const groups = new Map();
  for (const record of records) {
    if (openOnly && String(record.centerStatus || '').toUpperCase() !== 'OPEN') continue;
    const routeName = record.routeNameMckesson;
    if (!routeName || routeName === '#N/A') continue;
    if (!groups.has(routeName)) groups.set(routeName, []);
    groups.get(routeName).push(record);
  }
  return [...groups.entries()].map(([routeName, stops]) => {
    const weeklyCases = sum(stops, (stop) => stop.weeklyCases || 0);
    const weeklyLiters = sum(stops, (stop) => stop.weeklyLiters || 0);
    const workbookTotalCost = sum(stops, (stop) => stop.totalRouteCost || stop.sumBilledWeekly || 0);
    const workbookMiles = sum(stops, (stop) => stop.weeklyMiles || 0);
    const plcCounts = stops.reduce((acc, stop) => {
      const plc = routeEndpointForRecord(stop);
      acc[plc] = (acc[plc] || 0) + 1;
      return acc;
    }, {});
    const endpointPLC = Object.entries(plcCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Dallas PLC';
    return {
      routeName,
      stops,
      stopCount: stops.length,
      currentEndpointPLC: endpointPLC,
      weeklyCases,
      weeklyLiters,
      currentPathMiles: round(nearestNeighborMiles(stops, endpointPLC), 2),
      workbookMiles,
      workbookTotalCost
    };
  });
}

export const RFQ_BASELINE = Object.freeze({
  weeklyCost: 364011.36,
  monthlyCost: 1456045.44,
  annualCost: 17472545.31,
  activeCenterCount: 296,
  routeCount: 29,
  source: 'Validated active RFQ baseline: Center Status OPEN + assigned McKesson route + visible/non-hidden Excel row.'
});

export const RFQ_ASSUMPTIONS = Object.freeze({
  casesPerPallet: 70,
  reefer48MaxPallets: 24,
  currentEquipment: '48-foot reefer trailer',
  savingsLanguage: 'All savings are estimated RFQ opportunities and require carrier validation.',
  equipmentOptions: [
    { name: '48-foot reefer', palletCapacity: 24, estimatedWeeklyCostReductionPct: 0, serviceRisk: 'Low' },
    { name: '26-foot reefer truck', palletCapacity: 18, estimatedWeeklyCostReductionPct: 0.08, serviceRisk: 'Low-Medium' },
    { name: '20-foot reefer / box truck', palletCapacity: 12, estimatedWeeklyCostReductionPct: 0.14, serviceRisk: 'Medium' },
    { name: '16-foot reefer / box truck', palletCapacity: 8, estimatedWeeklyCostReductionPct: 0.18, serviceRisk: 'Medium' },
    { name: 'Reefer sprinter / cargo van', palletCapacity: 6, estimatedWeeklyCostReductionPct: 0.25, serviceRisk: 'Medium-High' },
    { name: 'LTL / pooled reefer', palletCapacity: 6, estimatedWeeklyCostReductionPct: 0.3, serviceRisk: 'High' }
  ],
  lowVolumeCenterWeeklyPalletThreshold: 0.5,
  plcMoveMinimumMilesSaved: 50,
  resequencingAssumedSavingsPct: 0.04,
  fuelSurchargePctFallback: 0.24056947933800188
});

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function money(value) {
  return round(value, 2);
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + (Number(typeof field === 'function' ? field(row) : row[field]) || 0), 0);
}

function safeDiv(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function normalizeRouteName(routeName) {
  return String(routeName || '').trim().toUpperCase();
}

function validPlc(plc) {
  return ['Dallas PLC', 'Whitestown PLC'].includes(plc) ? plc : '';
}

function centerPallets(record) {
  return safeDiv(Number(record.weeklyCases) || 0, RFQ_ASSUMPTIONS.casesPerPallet);
}

function routeCapacityStatus(pallets) {
  const utilization = safeDiv(pallets, RFQ_ASSUMPTIONS.reefer48MaxPallets);
  if (utilization > 1) return 'Over capacity';
  if (utilization >= 0.8) return 'High utilization';
  if (utilization >= 0.5) return 'Healthy';
  return 'Underutilized';
}

function riskForRoute({ pallets, costPerPallet, costPerMile, dataWarnings }) {
  if (dataWarnings.length || pallets > 24 || costPerPallet > 1200 || costPerMile > 5) return 'High';
  if (pallets < 12 || costPerPallet > 850 || costPerMile > 3) return 'Medium';
  return 'Low';
}

function scaleRouteCosts(routeGroups) {
  const runtimeWeeklyCost = sum(routeGroups, (route) => route.workbookTotalCost || 0);
  return runtimeWeeklyCost ? RFQ_BASELINE.weeklyCost / runtimeWeeklyCost : 1;
}

function buildRouteScorecard(routeGroups) {
  const costScale = scaleRouteCosts(routeGroups);
  return routeGroups.map((route) => {
    const weeklyCost = (route.workbookTotalCost || 0) * costScale;
    const weeklyCases = Number(route.weeklyCases) || 0;
    const weeklyLiters = Number(route.weeklyLiters) || 0;
    const weeklyPallets = safeDiv(weeklyCases, RFQ_ASSUMPTIONS.casesPerPallet);
    const currentMiles = Number(route.currentPathMiles || route.workbookMiles) || 0;
    const stopCount = Number(route.stopCount) || 0;
    const dataWarnings = [];
    if (!currentMiles) dataWarnings.push('Missing route miles; needs distance matrix / routing validation.');
    if (!weeklyCost) dataWarnings.push('Missing route cost.');
    if (!weeklyCases) dataWarnings.push('Missing weekly cases.');
    const utilization = safeDiv(weeklyPallets, RFQ_ASSUMPTIONS.reefer48MaxPallets);
    const status = routeCapacityStatus(weeklyPallets);
    const plcMix = route.stops.reduce((acc, stop) => {
      const plc = validPlc(stop.actualPLC) || 'Missing / not assigned';
      acc[plc] = (acc[plc] || 0) + 1;
      return acc;
    }, {});
    const score = {
      routeName: route.routeName,
      plcMix,
      stopCount,
      weeklyCases: round(weeklyCases, 2),
      weeklyLiters: round(weeklyLiters, 2),
      weeklyPallets: round(weeklyPallets, 2),
      currentWeeklyCost: money(weeklyCost),
      currentAnnualCost: money(weeklyCost * 48),
      currentMiles: round(currentMiles, 2),
      costPerMile: money(safeDiv(weeklyCost, currentMiles)),
      costPerStop: money(safeDiv(weeklyCost, stopCount)),
      costPerCase: money(safeDiv(weeklyCost, weeklyCases)),
      costPerLiter: money(safeDiv(weeklyCost, weeklyLiters)),
      costPerPallet: money(safeDiv(weeklyCost, weeklyPallets)),
      palletsPerStop: round(safeDiv(weeklyPallets, stopCount), 2),
      milesPerStop: round(safeDiv(currentMiles, stopCount), 2),
      trailer48UtilizationPct: round(utilization * 100, 2),
      emptyPalletCapacity: round(Math.max(0, RFQ_ASSUMPTIONS.reefer48MaxPallets - weeklyPallets), 2),
      underutilized: utilization < 0.5,
      overCapacity: utilization > 1,
      capacityStatus: status,
      routeRiskLevel: riskForRoute({ pallets: weeklyPallets, costPerPallet: safeDiv(weeklyCost, weeklyPallets), costPerMile: safeDiv(weeklyCost, currentMiles), dataWarnings }),
      dataWarnings,
      stops: route.stops
    };
    return score;
  }).sort((a, b) => a.routeName.localeCompare(b.routeName));
}

function buildBaselineKpis(routeScorecard) {
  const weeklyCost = RFQ_BASELINE.weeklyCost;
  const totalMiles = sum(routeScorecard, 'currentMiles');
  const totalCases = sum(routeScorecard, 'weeklyCases');
  const totalLiters = sum(routeScorecard, 'weeklyLiters');
  const totalPallets = sum(routeScorecard, 'weeklyPallets');
  const totalStops = RFQ_BASELINE.activeCenterCount;
  const fuelSurchargeTotal = sum(records.filter(isOpenRoutedRecord), (r) => r.fuelSurchargeDollar || 0) * safeDiv(weeklyCost, sum(records.filter(isOpenRoutedRecord), (r) => r.totalRouteCost || r.sumBilledWeekly || 0));
  return {
    weeklyCost: money(weeklyCost),
    monthlyCost: money(RFQ_BASELINE.monthlyCost),
    annualCost: money(RFQ_BASELINE.annualCost),
    routeCount: routeScorecard.length,
    activeCenterCount: RFQ_BASELINE.activeCenterCount,
    runtimeOpenRoutedCenterCount: records.filter(isOpenRoutedRecord).length,
    totalMiles: round(totalMiles, 2),
    totalCases: round(totalCases, 2),
    totalLiters: round(totalLiters, 2),
    totalPallets: round(totalPallets, 2),
    costPerMile: money(safeDiv(weeklyCost, totalMiles)),
    costPerStop: money(safeDiv(weeklyCost, totalStops)),
    costPerCase: money(safeDiv(weeklyCost, totalCases)),
    costPerLiter: money(safeDiv(weeklyCost, totalLiters)),
    costPerPallet: money(safeDiv(weeklyCost, totalPallets)),
    fuelSurchargeTotal: money(fuelSurchargeTotal),
    fuelSurchargePercentOfTotal: round(safeDiv(fuelSurchargeTotal, weeklyCost) * 100, 2)
  };
}

function isOpenRoutedRecord(record) {
  return String(record.centerStatus || '').toUpperCase() === 'OPEN' && normalizeRouteName(record.routeNameMckesson) && normalizeRouteName(record.routeNameMckesson) !== '#N/A';
}

function equipmentRecommendation(route) {
  const pallets = route.weeklyPallets;
  let option;
  let reason;
  if (pallets < 6) {
    option = RFQ_ASSUMPTIONS.equipmentOptions.find((item) => item.name === 'LTL / pooled reefer');
    reason = 'Route has fewer than 6 weekly pallets; RFQ should test small-vehicle or pooled reefer pricing.';
  } else if (pallets < 12) {
    option = RFQ_ASSUMPTIONS.equipmentOptions.find((item) => item.name === '16-foot reefer / box truck');
    reason = 'Route has 6–12 weekly pallets; RFQ should test 16-foot or 20-foot reefer pricing.';
  } else if (pallets < 18) {
    option = RFQ_ASSUMPTIONS.equipmentOptions.find((item) => item.name === '26-foot reefer truck');
    reason = 'Route has 12–18 weekly pallets; RFQ should test 26-foot reefer pricing.';
  } else if (pallets <= 24) {
    option = RFQ_ASSUMPTIONS.equipmentOptions.find((item) => item.name === '48-foot reefer');
    reason = 'Route uses most 48-foot capacity; keep 48-foot reefer unless mileage or cost is abnormal.';
  } else {
    option = RFQ_ASSUMPTIONS.equipmentOptions.find((item) => item.name === '48-foot reefer');
    reason = 'Route exceeds 24 pallets; RFQ should test split route or frequency increase rather than smaller equipment.';
  }
  const proposedUtilization = safeDiv(pallets, option.palletCapacity);
  const applicable = option.name !== RFQ_ASSUMPTIONS.equipmentOptions[0].name && proposedUtilization <= 1;
  const estimatedSavings = applicable ? route.currentWeeklyCost * option.estimatedWeeklyCostReductionPct : 0;
  return {
    routeName: route.routeName,
    currentEquipmentAssumption: RFQ_ASSUMPTIONS.currentEquipment,
    recommendedRfqEquipmentOption: option.name,
    utilizationUnderCurrent48Pct: route.trailer48UtilizationPct,
    utilizationUnderProposedEquipmentPct: round(proposedUtilization * 100, 2),
    estimatedWeeklySavingsOpportunity: money(estimatedSavings),
    estimatedAnnualSavingsOpportunity: money(estimatedSavings * 48),
    serviceRisk: option.serviceRisk,
    reason,
    constraintsChecked: ['48-foot capacity = 24 pallets', `${option.name} assumed capacity = ${option.palletCapacity} pallets`, 'Pallet conversion = 70 cases per pallet'],
    rfqValidationRequired: ['Confirm carrier equipment availability', 'Confirm chain-of-custody and temperature controls', 'Confirm route-specific pricing by equipment class']
  };
}

function frequencyCandidates(routeScorecard) {
  const openRouted = records.filter(isOpenRoutedRecord);
  return openRouted.map((record) => {
    const weeklyCases = Number(record.weeklyCases) || 0;
    const weeklyPallets = centerPallets(record);
    const twoWeekPallets = weeklyPallets * 2;
    const route = routeScorecard.find((item) => item.routeName === record.routeNameMckesson);
    const fitsRouteCapacity = route ? route.weeklyPallets + weeklyPallets <= RFQ_ASSUMPTIONS.reefer48MaxPallets : false;
    const isCandidate = weeklyPallets > 0 && weeklyPallets < RFQ_ASSUMPTIONS.lowVolumeCenterWeeklyPalletThreshold && twoWeekPallets < 1 && fitsRouteCapacity;
    const centerCost = Number(record.totalRouteCost || record.sumBilledWeekly) || 0;
    const estimatedWeeklySavings = isCandidate ? centerCost * 0.35 : 0;
    return {
      centerNumber: record.centerNumber,
      centerName: record.routeName,
      routeName: record.routeNameMckesson,
      currentWeeklyCases: round(weeklyCases, 2),
      currentWeeklyPallets: round(weeklyPallets, 2),
      estimatedTwoWeekPallets: round(twoWeekPallets, 2),
      fitsEquipmentCapacity: fitsRouteCapacity,
      possiblePickupReduction: isCandidate ? 'Candidate weekly-to-biweekly test' : 'No recommendation',
      estimatedWeeklySavingsOpportunity: money(estimatedWeeklySavings),
      estimatedAnnualSavingsOpportunity: money(estimatedWeeklySavings * 48),
      serviceQualityRisk: isCandidate ? 'Medium-High' : 'Not applicable',
      validationRequired: ['Requires operations validation', 'Confirm plasma storage limits', 'Confirm center pickup-day constraints', 'Confirm quality and compliance impacts']
    };
  }).filter((item) => item.possiblePickupReduction !== 'No recommendation').sort((a, b) => b.estimatedAnnualSavingsOpportunity - a.estimatedAnnualSavingsOpportunity).slice(0, 50);
}

function plcReassignmentCandidates(routeScorecard) {
  const byRoute = new Map(routeScorecard.map((route) => [route.routeName, route]));
  const candidates = [];
  for (const record of records.filter(isOpenRoutedRecord)) {
    if (!record.hasCoords) continue;
    const currentPLC = validPlc(record.actualPLC || record.basePLC);
    if (!currentPLC) continue;
    const alternatePLC = currentPLC === 'Dallas PLC' ? 'Whitestown PLC' : 'Dallas PLC';
    const currentMiles = haversineMiles(record, PLC_COORDS[currentPLC]) * 1.18;
    const alternateMiles = haversineMiles(record, PLC_COORDS[alternatePLC]) * 1.18;
    const mileDifference = currentMiles - alternateMiles;
    if (mileDifference < RFQ_ASSUMPTIONS.plcMoveMinimumMilesSaved) continue;
    const route = byRoute.get(record.routeNameMckesson);
    const pallets = centerPallets(record);
    const oldRoutePallets = route?.weeklyPallets || 0;
    const proposedRoute = routeScorecard.find((item) => {
      const mix = item.plcMix || {};
      return item.routeName !== record.routeNameMckesson && (mix[alternatePLC] || 0) > 0 && item.weeklyPallets + pallets <= RFQ_ASSUMPTIONS.reefer48MaxPallets;
    });
    const capacityCheck = Boolean(proposedRoute);
    const pickupDayConflictCheck = record.pickupDays ? 'Pickup day data exists; detailed conflict check needs route calendar validation.' : 'Pickup day data missing; needs schedule validation.';
    const estimatedSavings = capacityCheck ? (Number(record.totalRouteCost || record.sumBilledWeekly) || 0) * Math.min(0.2, safeDiv(mileDifference, currentMiles) * 0.5) : 0;
    candidates.push({
      centerNumber: record.centerNumber,
      centerName: record.routeName,
      currentPLC,
      alternatePLC,
      currentRoute: record.routeNameMckesson,
      proposedRoute: proposedRoute?.routeName || 'Needs route design',
      milesToCurrentPLC: round(currentMiles, 2),
      milesToAlternatePLC: round(alternateMiles, 2),
      mileDifference: round(mileDifference, 2),
      palletImpactOnOldRoute: round(-pallets, 2),
      palletImpactOnProposedRoute: round(pallets, 2),
      capacityCheck: capacityCheck ? 'Passes 24-pallet screen' : 'No obvious route with capacity found',
      pickupDayConflictCheck,
      estimatedWeeklySavingsOpportunity: money(estimatedSavings),
      estimatedAnnualSavingsOpportunity: money(estimatedSavings * 48),
      riskLevel: capacityCheck ? 'Medium' : 'High',
      validationRequired: ['Do not move solely to nearest PLC', 'Carrier lane pricing validation required', 'Operations and pickup-day validation required']
    });
  }
  return candidates.sort((a, b) => b.estimatedAnnualSavingsOpportunity - a.estimatedAnnualSavingsOpportunity).slice(0, 50);
}

function routeResequencingAnalysis(routeScorecard) {
  return routeScorecard.map((route) => {
    const abnormalMiles = route.milesPerStop > 250 || route.costPerMile > 3.5;
    const estimatedMilesSaved = abnormalMiles ? route.currentMiles * RFQ_ASSUMPTIONS.resequencingAssumedSavingsPct : 0;
    const estimatedWeeklySavings = estimatedMilesSaved * route.costPerMile;
    return {
      routeName: route.routeName,
      currentRouteMiles: route.currentMiles,
      optimizedRouteMiles: estimatedMilesSaved ? round(route.currentMiles - estimatedMilesSaved, 2) : null,
      milesSaved: round(estimatedMilesSaved, 2),
      milesSavedPct: round(safeDiv(estimatedMilesSaved, route.currentMiles) * 100, 2),
      costSavingsOpportunity: money(estimatedWeeklySavings),
      impactedStops: route.stopCount,
      riskLevel: estimatedMilesSaved ? 'Low-Medium' : 'Unknown',
      note: estimatedMilesSaved ? 'Estimated route-mile opportunity based on abnormal miles/cost screen.' : 'Needs distance matrix / routing validation.'
    };
  });
}

function recommendPricingModels(route, equipment) {
  const models = [];
  models.push('Dedicated weekly route price');
  if (route.currentMiles > 500 || route.costPerMile > 3) models.push('Rate per mile');
  if (route.stopCount > 10) models.push('Rate per stop');
  if (route.weeklyPallets > 18) models.push('Rate per pallet');
  if (route.weeklyCases > 1200) models.push('Rate per case');
  if (route.underutilized) models.push('Smaller vehicle pricing by equipment class', 'LTL / pooled reefer pricing for low-volume routes');
  models.push('Hybrid: base route fee + mileage', 'Hybrid: base route fee + stop charge', 'Hybrid: equipment type + mileage + fuel');
  return {
    routeName: route.routeName,
    recommendedPricingModelCandidates: [...new Set(models)],
    basis: {
      routeVolumePallets: route.weeklyPallets,
      miles: route.currentMiles,
      stops: route.stopCount,
      palletUtilizationPct: route.trailer48UtilizationPct,
      currentCostPerMile: route.costPerMile,
      currentCostPerPallet: route.costPerPallet,
      underutilized: route.underutilized,
      equipmentRightSizingPotential: equipment.recommendedRfqEquipmentOption
    },
    validationRequired: ['Ask carriers to bid multiple pricing structures side-by-side', 'Require fuel surcharge logic disclosure', 'Require equipment class and service assumptions']
  };
}

function buildSavingsTargets() {
  const targetAnnualCost = 11000000;
  const rates = [0.05, 0.1, 0.15, 0.2, 0.3, 0.35, 0.4];
  return {
    annualBaseline: RFQ_BASELINE.annualCost,
    targetAnnualCost,
    gapToTarget: money(RFQ_BASELINE.annualCost - targetAnnualCost),
    targetSavingsPctRequired: round(safeDiv(RFQ_BASELINE.annualCost - targetAnnualCost, RFQ_BASELINE.annualCost) * 100, 2),
    savingsTable: rates.map((rate) => ({
      savingsPct: round(rate * 100, 2),
      annualSavings: money(RFQ_BASELINE.annualCost * rate),
      annualCostAfterSavings: money(RFQ_BASELINE.annualCost * (1 - rate)),
      gapTo11MTarget: money(RFQ_BASELINE.annualCost * (1 - rate) - targetAnnualCost)
    }))
  };
}

function buildScenario(name, weeklySavings, riskLevel, confidenceLevel, counts, validationRequired) {
  const weeklyCost = Math.max(0, RFQ_BASELINE.weeklyCost - weeklySavings);
  const annualCost = weeklySavings === 0 ? RFQ_BASELINE.annualCost : weeklyCost * 48;
  const annualSavings = Math.max(0, RFQ_BASELINE.annualCost - annualCost);
  return {
    scenarioName: name,
    weeklyCostEstimate: money(weeklyCost),
    annualCostEstimate: money(annualCost),
    annualSavingsDollars: money(annualSavings),
    annualSavingsPct: round(safeDiv(annualSavings, RFQ_BASELINE.annualCost) * 100, 2),
    milesSaved: round(counts.milesSaved || 0, 2),
    routeChanges: counts.routeChanges || 0,
    centerChanges: counts.centerChanges || 0,
    equipmentChanges: counts.equipmentChanges || 0,
    frequencyChanges: counts.frequencyChanges || 0,
    plcMoves: counts.plcMoves || 0,
    riskLevel,
    confidenceLevel,
    validationRequired,
    language: 'Estimated savings / RFQ opportunity only; needs carrier validation.'
  };
}

function buildScenarios({ equipment, frequency, plcMoves, resequencing }) {
  const equipmentOpportunity = sum(equipment, 'estimatedWeeklySavingsOpportunity');
  const frequencyOpportunity = sum(frequency, 'estimatedWeeklySavingsOpportunity');
  const plcOpportunity = sum(plcMoves, 'estimatedWeeklySavingsOpportunity');
  const resequenceOpportunity = sum(resequencing, 'costSavingsOpportunity');
  const equipmentChanges = equipment.filter((item) => item.estimatedWeeklySavingsOpportunity > 0).length;
  return [
    buildScenario('Current Baseline', 0, 'Current', 'High', {}, ['No changes. Actual validated baseline.']),
    buildScenario('Conservative Savings', resequenceOpportunity * 0.4 + equipmentOpportunity * 0.35, 'Low', 'Medium', {
      milesSaved: sum(resequencing, 'milesSaved') * 0.4,
      routeChanges: resequencing.filter((r) => r.milesSaved > 0).length,
      equipmentChanges: Math.ceil(equipmentChanges * 0.35)
    }, ['Carrier route-mile validation', 'Equipment availability validation', 'No frequency or major PLC changes assumed']),
    buildScenario('Balanced Savings', resequenceOpportunity * 0.75 + equipmentOpportunity * 0.75 + plcOpportunity * 0.35 + frequencyOpportunity * 0.25, 'Medium', 'Medium-Low', {
      milesSaved: sum(resequencing, 'milesSaved') * 0.75,
      routeChanges: resequencing.filter((r) => r.milesSaved > 0).length,
      centerChanges: Math.ceil(plcMoves.length * 0.35 + frequency.length * 0.25),
      equipmentChanges: Math.ceil(equipmentChanges * 0.75),
      frequencyChanges: Math.ceil(frequency.length * 0.25),
      plcMoves: Math.ceil(plcMoves.length * 0.35)
    }, ['Carrier pricing by equipment class', 'Selected PLC moves need operations validation', 'Frequency changes require quality/storage validation']),
    buildScenario('Aggressive Savings', resequenceOpportunity + equipmentOpportunity + plcOpportunity * 0.75 + frequencyOpportunity * 0.6, 'High', 'Low', {
      milesSaved: sum(resequencing, 'milesSaved'),
      routeChanges: resequencing.filter((r) => r.milesSaved > 0).length,
      centerChanges: Math.ceil(plcMoves.length * 0.75 + frequency.length * 0.6),
      equipmentChanges,
      frequencyChanges: Math.ceil(frequency.length * 0.6),
      plcMoves: Math.ceil(plcMoves.length * 0.75)
    }, ['High operational validation burden', 'Carrier bid confirmation required', 'Temperature, pickup-day, and service-risk validation required'])
  ];
}

function buildCarrierBidScorecardTemplate(baseline) {
  return {
    fields: ['carrierName', 'pricingModel', 'weeklyCost', 'annualCost', 'costPerMile', 'costPerStop', 'costPerCase', 'costPerPallet', 'fuelSurchargeLogic', 'equipmentType', 'routeCoverage', 'serviceCompliance', 'risk', 'annualSavingsVsCurrent', 'score'],
    scoringGuidance: {
      cost: 'Compare annual cost and unit costs against current validated baseline.',
      service: 'Score route coverage, pickup-day compliance, chain-of-custody, and temperature controls.',
      risk: 'Penalize unclear fuel surcharge logic, insufficient equipment, or missing route coverage.'
    },
    exampleBlankCarrier: {
      carrierName: '',
      pricingModel: '',
      weeklyCost: null,
      annualCost: null,
      costPerMile: null,
      costPerStop: null,
      costPerCase: null,
      costPerPallet: null,
      fuelSurchargeLogic: '',
      equipmentType: '',
      routeCoverage: '',
      serviceCompliance: '',
      risk: '',
      annualSavingsVsCurrent: null,
      score: null,
      currentAnnualBaselineForComparison: baseline.annualCost
    }
  };
}

function buildExecutiveSummary({ baseline, routes, equipment, scenarios, savingsTargets }) {
  const underutilized = routes.filter((route) => route.underutilized).sort((a, b) => a.trailer48UtilizationPct - b.trailer48UtilizationPct).slice(0, 10);
  const overCapacity = routes.filter((route) => route.overCapacity).sort((a, b) => b.trailer48UtilizationPct - a.trailer48UtilizationPct);
  const highRisk = routes.filter((route) => route.routeRiskLevel === 'High').slice(0, 10);
  const bestScenario = [...scenarios].sort((a, b) => b.annualSavingsDollars - a.annualSavingsDollars)[0];
  return {
    validatedCurrentBaseline: `Current validated baseline is ${money(baseline.weeklyCost)} weekly / ${money(baseline.annualCost)} annual across ${baseline.activeCenterCount} active centers and ${baseline.routeCount} routes.`,
    biggestCostDrivers: routes.slice().sort((a, b) => b.currentAnnualCost - a.currentAnnualCost).slice(0, 5).map((route) => ({ routeName: route.routeName, annualCost: route.currentAnnualCost, costPerPallet: route.costPerPallet, utilizationPct: route.trailer48UtilizationPct })),
    topSavingsLevers: ['RFQ equipment right-sizing for underutilized 48-foot routes', 'Carrier bid models by equipment class and route profile', 'Route resequencing after distance-matrix validation', 'Selective low-risk PLC moves only where capacity and schedule checks pass', 'Limited frequency tests for low-volume centers with operations validation'],
    topUnderutilizedRoutes: underutilized.map((route) => ({ routeName: route.routeName, utilizationPct: route.trailer48UtilizationPct, weeklyPallets: route.weeklyPallets, currentWeeklyCost: route.currentWeeklyCost })),
    overCapacityRoutes: overCapacity.map((route) => ({ routeName: route.routeName, utilizationPct: route.trailer48UtilizationPct, weeklyPallets: route.weeklyPallets, risk: route.routeRiskLevel })),
    highRiskRoutes: highRisk.map((route) => ({ routeName: route.routeName, risk: route.routeRiskLevel, warnings: route.dataWarnings })),
    bestRfqPricingStructuresToRequest: ['Dedicated weekly route price', 'Rate per mile', 'Hybrid: equipment type + mileage + fuel', 'Smaller vehicle pricing by equipment class', 'LTL / pooled reefer pricing for low-volume routes'],
    estimatedSavingsRange: `${scenarios[1].annualSavingsPct}% to ${bestScenario.annualSavingsPct}% in modeled scenarios; not guaranteed and needs carrier validation.`,
    gapTo11MTarget: savingsTargets.gapToTarget,
    targetCaution: bestScenario.annualCostEstimate <= 11000000 ? 'Modeled scenario reaches the $11M target, but requires carrier validation.' : 'Modeled scenarios do not prove the $11M target is achievable; additional carrier pricing concessions would be required.',
    mustValidateWithCarriers: ['Actual route pricing model', 'Fuel surcharge basis', '48-foot vs smaller reefer availability', 'LTL/pooled reefer feasibility', 'Pickup-day and center service constraints', 'PLC reassignment feasibility']
  };
}

export function buildRfqSavingsAnalysis(options = {}) {
  const routeGroups = groupRouteRecords({ openOnly: true });
  const routeScorecard = buildRouteScorecard(routeGroups);
  const baselineKpis = buildBaselineKpis(routeScorecard);
  const equipmentRightSizing = routeScorecard.map(equipmentRecommendation);
  const pickupFrequencyOptimization = frequencyCandidates(routeScorecard);
  const plcReassignmentAnalysis = plcReassignmentCandidates(routeScorecard);
  const resequencingAnalysis = routeResequencingAnalysis(routeScorecard);
  const pricingModelRecommendations = routeScorecard.map((route) => recommendPricingModels(route, equipmentRightSizing.find((item) => item.routeName === route.routeName)));
  const savingsTargets = buildSavingsTargets();
  const savingsScenarios = buildScenarios({ equipment: equipmentRightSizing, frequency: pickupFrequencyOptimization, plcMoves: plcReassignmentAnalysis, resequencing: resequencingAnalysis });
  const carrierBidScorecard = buildCarrierBidScorecardTemplate(baselineKpis);
  const dataQualityWarnings = [
    baselineKpis.runtimeOpenRoutedCenterCount !== RFQ_BASELINE.activeCenterCount ? `Runtime JSON has ${baselineKpis.runtimeOpenRoutedCenterCount} open routed records; validated active visible baseline uses ${RFQ_BASELINE.activeCenterCount}. Financial KPIs use validated baseline and route costs are proportionally reconciled.` : '',
    ...routeScorecard.flatMap((route) => route.dataWarnings.map((warning) => `${route.routeName}: ${warning}`))
  ].filter(Boolean);
  const executiveSummary = buildExecutiveSummary({ baseline: baselineKpis, routes: routeScorecard, equipment: equipmentRightSizing, scenarios: savingsScenarios, savingsTargets });

  return {
    generatedAt: new Date().toISOString(),
    engineVersion: 'rfq-savings-engine-v1',
    actualDataSources: ['lib/data/records.json', 'lib/data/rateTable.json', 'lib/data/routeOrigins.json', 'lib/data/plcCoords.json'],
    assumptions: { ...RFQ_ASSUMPTIONS, ...(options.assumptions || {}) },
    baselineKpis,
    routeKpiScorecard: routeScorecard.map(({ stops, ...route }) => route),
    equipmentRightSizingAnalysis: equipmentRightSizing,
    pickupFrequencyOptimization,
    plcReassignmentAnalysis,
    routeResequencingAnalysis: resequencingAnalysis,
    rfqPricingModelRecommendations: pricingModelRecommendations,
    savingsTargets,
    savingsScenarios,
    carrierBidScorecard,
    executiveSummary,
    dataQualityWarnings
  };
}
