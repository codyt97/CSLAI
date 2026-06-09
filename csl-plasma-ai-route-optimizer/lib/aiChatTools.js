import { getDataSummary } from './dataSummary.js';
import { getInvoiceAudit } from './invoiceAuditMath.js';
import { getFuelSurchargeAudit } from './fuelSurchargeMath.js';
import {
  ASSUMPTIONS,
  generateDeterministicCandidates,
  getAllRecords,
  getRouteGroup,
  groupRouteRecords
} from './routeMath.js';

const DATA_USED = {
  ROUTE_KPIS: 'Route KPIs',
  CENTER_DATA: 'Center-level Data',
  INVOICE: 'Invoice Audit',
  FUEL: 'Fuel Audit',
  OPTIMIZATION: 'Optimization KPIs',
  AI_PICKUP: 'AI Pickup Group Recommendations',
  DATA_QUALITY: 'Data Quality Summary',
  CONTRACT: 'Contract Rules'
};

function clean(value) {
  return String(value || '').trim().toUpperCase();
}

function round(value, places = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const m = 10 ** places;
  return Math.round(n * m) / m;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Missing Data';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function detectTerms(question = '') {
  const q = question.toLowerCase();
  return {
    asksInvoice: /invoice|bol|audit row|linehaul|pickup date|dispute|overcharge/.test(q),
    asksFuel: /fuel|surcharge|diesel|fsc/.test(q),
    asksOptimization: /optimization|opportunity|scenario|regroup|move|candidate|actionable|exploratory|review first|\btop\b/.test(q),
    asksMileage: /mileage|miles|source miles|scenario miles|basis/.test(q),
    asksPallets: /pallet|utilization|capacity|underutilized|over 21\.6|high utilization|reefer/.test(q),
    asksPlcRelay: /plc|relay|mckesson|validation|mixed/.test(q),
    asksDataQuality: /missing|data quality|source-parsed|files|raw|generated|why can.t we call/.test(q),
    asksExecutive: /summarize|summary|bruno|viviana|top 5|present/.test(q),
    asksCompare: /compare| vs |versus/.test(q),
    asksShipmentVolume: /shipment|shipments|pickup count|pickup stops|stops per week|routes per week|shipments weekly|weekly shipments|average shipments/.test(q),
    asksDataInventory: /what data do we have|what data is available|available data|data do we have|data available/.test(q)
  };
}

export function detectRouteNames(question = '') {
  const q = clean(question);
  const routeNames = groupRouteRecords({ openOnly: true }).map((g) => clean(g.routeName));
  const detected = routeNames.filter((routeName) => q.includes(routeName));
  if (/ALLENTOWN|BUFFALO|PHILLY/.test(q)) {
    for (const routeName of ['ALLENTOWN', 'BUFFALO', 'PHILLY']) if (q.includes(routeName)) detected.push(routeName);
  }
  return unique(detected);
}

function mileageBasisForGroup(group) {
  if (!group) return { status: 'Missing Data', warning: 'Route group is missing.' };
  if (!group.workbookMiles || !group.currentPathMiles) {
    return { status: 'Missing Data', warning: 'Current source miles or route-path scenario miles are missing.' };
  }
  if (group.isRelay || group.plcMismatch) {
    return { status: 'Mixed PLC / Relay Validation', warning: 'Source miles and scenario miles are not directly comparable until McKesson validates the mixed PLC / relay pattern.' };
  }
  return { status: 'Comparable', warning: '' };
}

function trailerStatus(pallets) {
  const p = Number(pallets);
  if (!Number.isFinite(p)) return 'Missing Data';
  if (p > ASSUMPTIONS.reefer48FootMaxPallets) return 'Over Capacity';
  if (p >= ASSUMPTIONS.highUtilizationPalletThreshold) return 'High Utilization';
  if (p < ASSUMPTIONS.underutilizedPalletThreshold) return 'Underutilized';
  return 'OK';
}

export function routeKpiSummary(group) {
  if (!group) return null;
  const mileageBasis = mileageBasisForGroup(group);
  return {
    routeName: group.routeName,
    stopCount: group.stopCount,
    currentEndpointPLC: group.currentEndpointPLC,
    basePLC: group.basePLC,
    actualPLC: group.actualPLC,
    routeType: group.routeType,
    isRelay: Boolean(group.isRelay),
    plcMismatch: Boolean(group.plcMismatch),
    weeklyCases: group.weeklyCases,
    weeklyPallets: group.weeklyPallets,
    trailerStatus: trailerStatus(group.weeklyPallets),
    currentWeeklyCost: group.workbookTotalCost,
    costPerCase: group.weeklyCases ? round(group.workbookTotalCost / group.weeklyCases, 2) : null,
    currentSourceMiles: group.workbookMiles,
    proposedScenarioMiles: group.currentPathMiles,
    mileageBasisStatus: mileageBasis.status,
    mileageWarning: mileageBasis.warning,
    validationWarnings: unique([
      group.isRelay || group.plcMismatch ? 'Mixed PLC / Relay Validation; requires McKesson validation.' : '',
      group.weeklyPallets > ASSUMPTIONS.reefer48FootMaxPallets ? 'Needs Capacity Review: over 24-pallet 48 ft reefer capacity.' : '',
      group.weeklyPallets >= ASSUMPTIONS.highUtilizationPalletThreshold && group.weeklyPallets <= ASSUMPTIONS.reefer48FootMaxPallets ? 'High Utilization: at or above 21.6 pallets.' : '',
      group.weeklyPallets < ASSUMPTIONS.underutilizedPalletThreshold ? 'Underutilized: below 12 pallets.' : '',
      mileageBasis.warning
    ]),
    centers: group.stops.slice(0, 30).map((stop) => ({
      centerNumber: stop.centerNumber || stop.id,
      centerName: stop.routeName,
      city: stop.city,
      state: stop.state,
      basePLC: stop.basePLC,
      actualPLC: stop.actualPLC,
      weeklyCases: round(stop.weeklyCases || 0, 2),
      weeklyPallets: round((Number(stop.weeklyCases) || 0) / ASSUMPTIONS.casesPerPallet, 2)
    }))
  };
}

function portfolioSummary(groups) {
  const totalCost = groups.reduce((sum, g) => sum + (Number(g.workbookTotalCost) || 0), 0);
  const totalCases = groups.reduce((sum, g) => sum + (Number(g.weeklyCases) || 0), 0);
  return {
    routeCount: groups.length,
    totalCurrentWeeklyCost: round(totalCost, 2),
    totalWeeklyCases: round(totalCases, 2),
    portfolioCostPerCase: totalCases ? round(totalCost / totalCases, 2) : null,
    highUtilizationRoutes: groups.filter((g) => g.weeklyPallets >= ASSUMPTIONS.highUtilizationPalletThreshold && g.weeklyPallets <= ASSUMPTIONS.reefer48FootMaxPallets).map(routeKpiSummary),
    underutilizedRoutes: groups.filter((g) => g.weeklyPallets < ASSUMPTIONS.underutilizedPalletThreshold).map(routeKpiSummary),
    overCapacityRoutes: groups.filter((g) => g.weeklyPallets > ASSUMPTIONS.reefer48FootMaxPallets).map(routeKpiSummary),
    mixedPlcRelayRoutes: groups.filter((g) => g.isRelay || g.plcMismatch).map(routeKpiSummary)
  };
}

function topOptimizationCandidates(routeName = '') {
  const candidates = generateDeterministicCandidates({
    scope: routeName ? 'selected' : 'all',
    routeName,
    maxRoutes: routeName ? 1 : 30
  });
  return candidates.slice(0, 12).map((candidate, index) => ({
    rank: index + 1,
    route: candidate.currentRoutesImpacted?.[0],
    recommendationType: candidate.recommendationType,
    proposedGroup: candidate.newRouteName,
    currentWeeklyCost: candidate.currentCost,
    proposedWeeklyCost: candidate.newCost,
    weeklyOpportunity: candidate.weeklySavings,
    annualOpportunity: candidate.annualSavings,
    currentSourceMiles: candidate.currentChargeableMiles,
    proposedScenarioMiles: candidate.newChargeableMiles,
    confidence: candidate.confidence,
    warnings: candidate.risks || [],
    bucket: candidate.weeklySavings <= 0
      ? 'Keep Current / Infeasible'
      : (candidate.risks || []).length
        ? 'Needs Validation / Exploratory Scenarios'
        : 'Actionable Candidates'
  }));
}

function pickupRecommendationSummary(routeName = '') {
  const scenarios = topOptimizationCandidates(routeName);
  const actionable = scenarios.filter((s) => s.bucket === 'Actionable Candidates');
  const exploratory = scenarios.filter((s) => s.bucket === 'Needs Validation / Exploratory Scenarios');
  const keepCurrent = scenarios.filter((s) => s.bucket === 'Keep Current / Infeasible');
  return {
    note: 'These are compact deterministic optimization scenarios for AI chat grounding. Scenario miles are not confirmed billing miles.',
    actionableCount: actionable.length,
    exploratoryCount: exploratory.length,
    keepCurrentCount: keepCurrent.length,
    topScenarios: scenarios,
    validationPolicy: [
      'Weekly opportunity must be positive before a scenario is recommended.',
      'Mixed PLC / relay routes require McKesson validation and low-confidence treatment.',
      'Over 24 pallets requires capacity review.',
      'Driver time over 11 hours requires driver-time validation.',
      'Use scenario opportunity or operational opportunity, not validated invoice impact.'
    ]
  };
}

function invoiceSummary() {
  const audit = getInvoiceAudit();
  return {
    totalRows: audit.totalRows,
    totalLinehaul: round(audit.totalLinehaul, 2),
    totalFuelSurcharge: round(audit.totalFuelSurcharge, 2),
    totalCost: round(audit.totalCost, 2),
    status: audit.status,
    explanation: audit.explanation,
    rowsNeedingReview: audit.rowsNeedingReview,
    zeroLinehaulRows: audit.zeroLinehaulRows,
    zeroFuelRows: audit.zeroFuelRows,
    missingRouteRows: audit.missingRouteRows,
    missingPlcRows: audit.missingPlcRows,
    hasInvoiceAndPickupDates: (audit.rows || []).some((row) => row.invoiceDate || row.pickupDate),
    sampleRowsNeedingReview: (audit.rows || [])
      .filter((row) => row.status !== 'OK')
      .slice(0, 8)
      .map((row) => ({
        routeName: row.routeName,
        centerNumber: row.centerNumber,
        centerName: row.centerName,
        invoiceDate: row.invoiceDate,
        pickupDate: row.pickupDate,
        invoiceDisputeDeadline: row.invoiceDisputeDeadline,
        overchargeUnderchargeDeadline: row.overchargeUnderchargeDeadline,
        linehaul: row.linehaul,
        fuelSurcharge: row.fuelSurcharge,
        totalCost: row.totalCost,
        status: row.status,
        explanation: row.explanation
      }))
  };
}

function fuelSummary() {
  const audit = getFuelSurchargeAudit({ dieselAverage: 3.70 });
  return {
    dieselAverage: audit.dieselAverage,
    expectedFuelSurchargePercent: audit.expectedFuelSurchargePercent,
    actualFuelSurchargePercent: audit.actualFuelSurchargePercent,
    variancePercent: audit.variancePercent,
    totalLinehaul: round(audit.totalLinehaul, 2),
    totalFuelSurcharge: round(audit.totalFuelSurcharge, 2),
    status: audit.status,
    explanation: audit.explanation,
    zeroFuelWithLinehaulRows: audit.zeroFuelWithLinehaulRows,
    missingLinehaulRows: audit.missingLinehaulRows,
    abnormalFuelPercentRows: audit.abnormalFuelPercentRows,
    sampleRowsNeedingReview: (audit.rows || [])
      .filter((row) => row.status !== 'OK')
      .slice(0, 8)
      .map((row) => ({
        routeName: row.routeName,
        centerNumber: row.centerNumber,
        centerName: row.centerName,
        linehaul: row.linehaul,
        fuelSurcharge: row.fuelSurcharge,
        actualFuelSurchargePercent: row.actualFuelSurchargePercent,
        expectedFuelSurchargePercent: row.expectedFuelSurchargePercent,
        status: row.status,
        explanation: row.explanation
      }))
  };
}

function dataQualitySummary() {
  const summary = getDataSummary();
  return {
    generatedAt: summary.generatedAt,
    files: (summary.files || []).map((file) => ({
      fileName: file.fileName,
      sourceStatus: file.sourceStatus,
      recordCount: file.recordCount,
      warning: file.warning
    })),
    warnings: summary.dataQuality?.sampleRecords || []
  };
}


function fileSummaryByName(summary, fileName) {
  return (summary.files || []).find((file) => file.fileName === fileName) || {};
}

function scheduleActivitySummary() {
  const summary = getDataSummary();
  const groups = groupRouteRecords({ openOnly: true });
  const invoice = getInvoiceAudit();
  const weekA = fileSummaryByName(summary, 'weekAStops.json');
  const weekB = fileSummaryByName(summary, 'weekBStops.json');
  const scheduled = fileSummaryByName(summary, 'scheduledCenters.json');
  return {
    trueShipmentCountAvailable: false,
    limitation: 'True shipment count per week is not directly available unless each BOL row represents one shipment and billing/pickup dates are grouped by week.',
    weekAScheduledStops: Number(weekA.recordCount) || 0,
    weekBScheduledStops: Number(weekB.recordCount) || 0,
    scheduledCenters: Number(scheduled.recordCount) || 0,
    routeGroupCount: groups.length,
    invoiceBillingRows: invoice.totalRows,
    invoiceBillingRowsLabel: 'valid invoice audit billing rows, not necessarily weekly shipments',
    sourceStatuses: {
      weekAStops: weekA.sourceStatus || 'missing',
      weekBStops: weekB.sourceStatus || 'missing',
      scheduledCenters: scheduled.sourceStatus || 'missing',
      billingFY26: invoice.sourceStatus?.billingFY26 || 'missing'
    }
  };
}

function dataInventorySummary() {
  const summary = getDataSummary();
  return {
    availableData: [
      'Route schedules and pickup stop records for Week A and Week B.',
      'Open/scheduled center data with route, PLC, city/state, cases, liters, and pallet calculations.',
      'Route-level KPIs including current weekly cost, weekly cases, Cost / Case, source miles, scenario miles, mileage basis, and utilization status.',
      'Billing rows used by invoice audit, including linehaul, fuel surcharge, BOL total, invoice date, pickup date, dispute deadline, and overcharge deadline where present.',
      'Fuel surcharge audit summary and review rows.',
      'Optimization scenario candidates and AI pickup regrouping recommendation buckets.',
      'Contract assumptions/rules already embedded in runtime JSON and code, including 70 cases per pallet and 24-pallet 48-ft reefer max.'
    ],
    missingForTrueShipmentPerWeek: [
      'A confirmed shipment identifier/count by week.',
      'A rule confirming whether each BOL row equals one shipment.',
      'Billing or pickup dates grouped into weekly shipment periods.',
      'McKesson/contract validation before treating scenario opportunities as invoice impact.'
    ],
    fileStatuses: (summary.files || []).map((file) => ({ fileName: file.fileName, sourceStatus: file.sourceStatus, recordCount: file.recordCount }))
  };
}

function centerMatches(routeNames) {
  if (!routeNames.length) return [];
  return getAllRecords()
    .filter((record) => routeNames.includes(clean(record.routeNameMckesson || record.mckessonRoute)))
    .slice(0, 80)
    .map((record) => ({
      centerNumber: record.centerNumber || record.id,
      centerName: record.routeName,
      routeName: record.routeNameMckesson || record.mckessonRoute,
      city: record.city,
      state: record.state,
      basePLC: record.basePLC,
      actualPLC: record.actualPLC,
      weeklyCases: round(record.weeklyCases || 0, 2),
      weeklyPallets: round((Number(record.weeklyCases) || 0) / ASSUMPTIONS.casesPerPallet, 2),
      centerStatus: record.centerStatus
    }));
}

function collectWarnings(context) {
  const warnings = [];
  for (const route of context.routes || []) warnings.push(...(route.validationWarnings || []).map((warning) => `${route.routeName}: ${warning}`));
  if (context.invoiceAudit?.status && context.invoiceAudit.status !== 'OK') warnings.push(`Invoice audit status is ${context.invoiceAudit.status}: ${context.invoiceAudit.explanation}`);
  if (context.fuelAudit?.status && context.fuelAudit.status !== 'OK') warnings.push(`Fuel audit status is ${context.fuelAudit.status}: ${context.fuelAudit.explanation}`);
  if (context.aiPickupRecommendations?.actionableCount === 0 && context.aiPickupRecommendations?.exploratoryCount > 0) warnings.push('No actionable regrouping candidates under current constraints; exploratory scenarios require validation.');
  return unique(warnings).slice(0, 12);
}

export function buildAiChatContext({ question = '', routeName = '', mode = '' } = {}) {
  const terms = detectTerms(question);
  const routeNames = unique([clean(routeName), ...detectRouteNames(question)]).filter(Boolean);
  const includePortfolio = !routeNames.length || terms.asksExecutive || terms.asksCompare || terms.asksOptimization || terms.asksPallets || terms.asksPlcRelay;
  const groups = groupRouteRecords({ openOnly: true });
  const selectedGroups = routeNames.length ? routeNames.map((name) => getRouteGroup(name)).filter(Boolean) : [];
  const context = {
    question,
    mode,
    assumptions: ASSUMPTIONS,
    detectedRouteNames: routeNames,
    dataUsed: [],
    routes: selectedGroups.map(routeKpiSummary),
    formulaReference: {
      costPerCase: 'Current Weekly Cost / Weekly Cases',
      portfolioCostPerCase: 'Total Current Weekly Cost / Total Weekly Cases',
      actualFuelSurchargePercent: 'Total Fuel Surcharge / Total Linehaul × 100',
      pallets: 'Weekly Cases / 70'
    }
  };

  if (includePortfolio) {
    context.portfolio = portfolioSummary(groups);
    context.dataUsed.push(DATA_USED.ROUTE_KPIS);
    if (!terms.asksShipmentVolume || terms.asksOptimization) context.dataUsed.push(DATA_USED.OPTIMIZATION);
  }
  if (selectedGroups.length) context.dataUsed.push(DATA_USED.ROUTE_KPIS, DATA_USED.CENTER_DATA);
  if (terms.asksShipmentVolume) {
    context.scheduleActivity = scheduleActivitySummary();
    context.dataUsed.push(DATA_USED.ROUTE_KPIS, DATA_USED.INVOICE, DATA_USED.DATA_QUALITY);
  }
  if (terms.asksDataInventory) {
    context.dataInventory = dataInventorySummary();
    context.scheduleActivity ||= scheduleActivitySummary();
    context.dataUsed.push(DATA_USED.ROUTE_KPIS, DATA_USED.CENTER_DATA, DATA_USED.INVOICE, DATA_USED.FUEL, DATA_USED.OPTIMIZATION, DATA_USED.AI_PICKUP, DATA_USED.DATA_QUALITY, DATA_USED.CONTRACT);
  }
  if (terms.asksInvoice || terms.asksExecutive || terms.asksDataQuality) {
    context.invoiceAudit = invoiceSummary();
    context.dataUsed.push(DATA_USED.INVOICE);
  }
  if (terms.asksFuel || terms.asksInvoice || terms.asksExecutive) {
    context.fuelAudit = fuelSummary();
    context.dataUsed.push(DATA_USED.FUEL);
  }
  if (terms.asksOptimization || terms.asksExecutive || /actionable|exploratory|move|regroup/i.test(question)) {
    context.aiPickupRecommendations = pickupRecommendationSummary(routeNames[0]);
    context.dataUsed.push(DATA_USED.AI_PICKUP);
  }
  if (terms.asksDataQuality || terms.asksExecutive || /source-parsed|missing|files|bruno|viviana/i.test(question)) {
    context.dataQuality = dataQualitySummary();
    context.dataUsed.push(DATA_USED.DATA_QUALITY, DATA_USED.CONTRACT);
  }
  if (routeNames.length) context.centers = centerMatches(routeNames);

  context.dataUsed = unique(context.dataUsed);
  context.warnings = collectWarnings(context);
  return context;
}

export function deterministicAnswer(context) {
  const q = (context.question || '').toLowerCase();
  const lines = [];

  if (context.scheduleActivity && /shipment|pickup count|pickup stops|stops per week|routes per week|shipments weekly|weekly shipments|average shipments/.test(q)) {
    const s = context.scheduleActivity;
    lines.push(`True shipment count per week is not directly available from the current app data unless each BOL row represents one shipment and the billing or pickup date can be grouped by week.`);
    lines.push(`Closest available proxies:`);
    lines.push(`- Week A scheduled pickup stops: ${s.weekAScheduledStops.toLocaleString()}.`);
    lines.push(`- Week B scheduled pickup stops: ${s.weekBScheduledStops.toLocaleString()}.`);
    lines.push(`- Route groups: ${s.routeGroupCount.toLocaleString()}.`);
    lines.push(`- Scheduled centers: ${s.scheduledCenters.toLocaleString()}.`);
    lines.push(`- Invoice audit billing rows: ${s.invoiceBillingRows.toLocaleString()} valid billing rows. These are billing rows, not necessarily weekly shipments.`);
    lines.push(`Do not use cases, pallets, route count, or cost as a shipment count.`);
  } else if (context.dataInventory && /what data|available data|data do we have|data is available/.test(q)) {
    lines.push('The current app has these data areas available:');
    for (const item of context.dataInventory.availableData) lines.push(`- ${item}`);
    lines.push('For a true shipment/week calculation, the missing items are:');
    for (const item of context.dataInventory.missingForTrueShipmentPerWeek) lines.push(`- ${item}`);
  } else if (/can we call|confirmed|actual benefit|guaranteed/.test(q)) {
    lines.push('No. Use “operational opportunity” or “scenario opportunity,” not validated invoice impact. Contract rating or McKesson repricing is required before treating any route-mile or regrouping scenario as invoice impact.');
  } else if (context.routes?.length) {
    for (const route of context.routes) {
      lines.push(`**${route.routeName}** has ${route.stopCount} stops, ${round(route.weeklyCases, 2).toLocaleString()} weekly cases, ${round(route.weeklyPallets, 2)} pallets, and ${money(route.currentWeeklyCost)} current weekly cost.`);
      lines.push(`Cost / Case = Current Weekly Cost / Weekly Cases = ${money(route.currentWeeklyCost)} / ${round(route.weeklyCases, 2).toLocaleString()} = ${route.costPerCase == null ? 'Missing Data' : money(route.costPerCase)}.`);
      lines.push(`Mileage Basis: ${route.mileageBasisStatus}${route.mileageWarning ? ` — ${route.mileageWarning}` : ''}`);
      if (route.validationWarnings.length) lines.push(`Warnings: ${route.validationWarnings.join(' ')}`);
    }
  } else if (/invoice/.test(q) && context.invoiceAudit) {
    lines.push(`Invoice audit reviewed ${context.invoiceAudit.totalRows.toLocaleString()} rows with ${money(context.invoiceAudit.totalLinehaul)} linehaul, ${money(context.invoiceAudit.totalFuelSurcharge)} fuel surcharge, and ${money(context.invoiceAudit.totalCost)} BOL total cost.`);
    lines.push(`Status: ${context.invoiceAudit.status}. ${context.invoiceAudit.explanation}`);
    lines.push(context.invoiceAudit.hasInvoiceAndPickupDates ? 'Invoice Date and Pickup Date fields are available in the audit rows.' : 'Invoice Date or Pickup Date is missing from the available audit rows.');
  } else if (/fuel/.test(q) && context.fuelAudit) {
    lines.push(`Fuel audit status is ${context.fuelAudit.status}. Actual Fuel Surcharge % = Total Fuel Surcharge / Total Linehaul × 100 = ${money(context.fuelAudit.totalFuelSurcharge)} / ${money(context.fuelAudit.totalLinehaul)} × 100 = ${context.fuelAudit.actualFuelSurchargePercent}%.`);
    lines.push(context.fuelAudit.explanation);
  } else if (/zero actionable|actionable/.test(q) && context.aiPickupRecommendations) {
    lines.push(`There are ${context.aiPickupRecommendations.actionableCount} actionable candidates in the compact AI chat scenario set. Scenarios move to exploratory or keep-current when they require McKesson validation, driver-time validation, capacity review, or when weekly opportunity is not positive.`);
  } else {
    lines.push('Here are the top grounded findings from the current app data:' );
    if (context.portfolio) {
      lines.push(`Portfolio Cost / Case = Total Current Weekly Cost / Total Weekly Cases = ${money(context.portfolio.totalCurrentWeeklyCost)} / ${context.portfolio.totalWeeklyCases.toLocaleString()} = ${money(context.portfolio.portfolioCostPerCase)}.`);
      lines.push(`Mixed PLC / relay routes visible in context: ${context.portfolio.mixedPlcRelayRoutes.slice(0, 8).map((r) => r.routeName).join(', ') || 'None'}.`);
      lines.push(`Underutilized routes include: ${context.portfolio.underutilizedRoutes.slice(0, 8).map((r) => `${r.routeName} (${round(r.weeklyPallets, 2)} pallets)`).join(', ') || 'None'}.`);
    }
    if (context.invoiceAudit) lines.push(`Invoice audit linehaul total is ${money(context.invoiceAudit.totalLinehaul)}.`);
    if (context.fuelAudit) lines.push(`Fuel audit status is ${context.fuelAudit.status} with actual fuel surcharge percent ${context.fuelAudit.actualFuelSurchargePercent}%.`);
  }

  lines.push('\n**Data used**');
  for (const item of context.dataUsed || []) lines.push(`- ${item}`);
  if (context.warnings?.length) {
    lines.push('\n**Warnings**');
    for (const warning of context.warnings.slice(0, 6)) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}

export function suggestedFollowups(context) {
  const route = context.detectedRouteNames?.[0];
  return unique([
    route ? `Show ${route} cost per case formula.` : 'Which routes should we review first?',
    route ? `What validation is needed for ${route}?` : 'Which routes are underutilized?',
    'Why can’t we call this invoice impact yet?',
    'What does the fuel surcharge audit show?',
    'How many pickup stops per week?',
    'Summarize the invoice audit findings.'
  ]).slice(0, 5);
}

export { DATA_USED, money };
