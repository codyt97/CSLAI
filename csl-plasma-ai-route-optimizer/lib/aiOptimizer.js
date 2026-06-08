import { generateNetworkCandidates, groupRouteRecords, ASSUMPTIONS, contractRules } from './routeMath.js';

const MIX_ENTRY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { plc: { type: 'string' }, centerCount: { type: 'number' }, centerPct: { type: 'number' }, cases: { type: 'number' }, pallets: { type: 'number' }, weeklyCost: { type: 'number' }, annualCost: { type: 'number' } },
  required: ['plc','centerCount','centerPct','cases','pallets','weeklyCost','annualCost']
};
const MIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    Dallas: MIX_ENTRY_SCHEMA,
    Whitestown: MIX_ENTRY_SCHEMA,
    totals: { type: 'object', additionalProperties: false, properties: { centerCount: { type: 'number' }, cases: { type: 'number' }, pallets: { type: 'number' }, weeklyCost: { type: 'number' }, annualCost: { type: 'number' } }, required: ['centerCount','cases','pallets','weeklyCost','annualCost'] }
  },
  required: ['Dallas','Whitestown','totals']
};
const MOVED_CENTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { id: { type: 'string' }, centerNumber: { type: 'string' }, centerName: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, currentRoute: { type: 'string' }, currentPLC: { type: 'string' }, proposedPLC: { type: 'string' }, proposedGroup: { type: 'string' } },
  required: ['id','centerNumber','centerName','city','state','currentRoute','currentPLC','proposedPLC','proposedGroup']
};
const PROPOSED_GROUP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    proposedGroupName: { type: 'string' }, proposedPLC: { type: 'string' }, pickupDay: { type: 'string' }, weekAB: { type: 'string' }, pickupTimeWindow: { type: 'string' },
    centersIncluded: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, centerNumber: { type: 'string' }, centerName: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, currentRoute: { type: 'string' }, currentPLC: { type: 'string' } }, required: ['id','centerNumber','centerName','city','state','currentRoute','currentPLC'] } },
    routeSequence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { stop: { type: 'number' }, id: { type: 'string' }, centerNumber: { type: 'string' }, centerName: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } }, required: ['stop','id','centerNumber','centerName','lat','lng'] } },
    reasonForGrouping: { type: 'string' }, riskNotes: { type: 'array', items: { type: 'string' } },
    savingsProof: { type: 'object', additionalProperties: false, properties: { currentTotalChargedMiles: { type: 'number' }, proposedChargedMiles: { type: 'number' }, currentWeeklyCost: { type: 'number' }, proposedWeeklyCost: { type: 'number' }, weeklySavings: { type: 'number' }, annualSavings: { type: 'number' }, centerCount: { type: 'number' }, pallets: { type: 'number' }, trailerUtilizationPct: { type: 'number' }, costPerPallet: { type: 'number' }, costPerMile: { type: 'number' }, formulaUsed: { type: 'string' }, contractRuleUsed: { type: 'string' }, scheduleRuleUsed: { type: 'string' }, savingsStatus: { type: 'string' } }, required: ['currentTotalChargedMiles','proposedChargedMiles','currentWeeklyCost','proposedWeeklyCost','weeklySavings','annualSavings','centerCount','pallets','trailerUtilizationPct','costPerPallet','costPerMile','formulaUsed','contractRuleUsed','scheduleRuleUsed','savingsStatus'] }
  },
  required: ['proposedGroupName','proposedPLC','pickupDay','weekAB','pickupTimeWindow','centersIncluded','routeSequence','reasonForGrouping','riskNotes','savingsProof']
};

const NETWORK_SCENARIO_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' },
    scenarioType: { type: 'string' },
    description: { type: 'string' },
    currentNetworkCost: { type: 'number' },
    proposedNetworkCost: { type: 'number' },
    currentAnnualCost: { type: 'number' },
    proposedAnnualCost: { type: 'number' },
    savings: { type: 'number' },
    annualSavings: { type: 'number' },
    savingsPct: { type: 'number' },
    affectedRoutes: { type: 'array', items: { type: 'string' } },
    affectedCenters: { type: 'array', items: { type: 'string' } },
    currentDistributionMix: MIX_SCHEMA,
    proposedDistributionMix: MIX_SCHEMA,
    centersMovedDallasToWhitestown: { type: 'array', items: MOVED_CENTER_SCHEMA },
    centersMovedWhitestownToDallas: { type: 'array', items: MOVED_CENTER_SCHEMA },
    totalReassignmentSavings: { type: 'number' },
    proposedRouteGroups: { type: 'array', items: PROPOSED_GROUP_SCHEMA },
    operationalRisk: { type: 'string' },
    confidence: { type: 'string' },
    formulaUsed: { type: 'string' },
    contractRuleUsed: { type: 'string' },
    scheduleRuleUsed: { type: 'string' },
    finalStatus: { type: 'string', enum: ['Recommended','Not Recommended','Needs Contract Validation','Rejected Scenario'] },
    costDifference: { type: 'number' },
    costDeltaLabel: { type: 'string' },
    rejectionReason: { type: 'string' }
  },
  required: ['id','scenarioType','description','currentNetworkCost','proposedNetworkCost','currentAnnualCost','proposedAnnualCost','savings','annualSavings','savingsPct','affectedRoutes','affectedCenters','currentDistributionMix','proposedDistributionMix','centersMovedDallasToWhitestown','centersMovedWhitestownToDallas','totalReassignmentSavings','proposedRouteGroups','operationalRisk','confidence','formulaUsed','contractRuleUsed','scheduleRuleUsed','finalStatus','costDifference','costDeltaLabel','rejectionReason']
};

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    scope: { type: 'string' },
    dataSource: { type: 'string' },
    calculationStatus: { type: 'string' },
    confidence: { type: 'string', enum: ['High','Medium','Low'] },
    currentNetworkCost: { type: 'number' },
    currentAnnualCost: { type: 'number' },
    networkScenarios: { type: 'array', items: NETWORK_SCENARIO_SCHEMA },
    recommendations: { type: 'array', items: NETWORK_SCENARIO_SCHEMA },
    leadershipSummary: { type: 'string' },
    questionsForMcKesson: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary','scope','dataSource','calculationStatus','confidence','currentNetworkCost','currentAnnualCost','networkScenarios','recommendations','leadershipSummary','questionsForMcKesson']
};

export async function runAiRouteOptimizer(input) {
  const { question='', objective='savings', maxRoutes=20 } = input || {};
  const networkScenarios = generateNetworkCandidates({ maxScenarios: 20 });
  const groups = groupRouteRecords({ openOnly: true });
  const currentNetworkCost = networkScenarios[0]?.currentNetworkCost || groups.reduce((a,g)=>a+(Number(g.workbookTotalCost)||0),0);
  const currentAnnualCost = currentNetworkCost * 52;

  if (!process.env.OPENAI_API_KEY) {
    return fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason: 'OPENAI_API_KEY is not configured. Returning deterministic network-wide optimizer scenarios.' });
  }

  const payload = {
    userQuestion: question,
    objective,
    scope: 'network-wide McKesson plasma pickup network',
    contractLogic: contractRules(),
    assumptions: ASSUMPTIONS,
    hardRules: [
      'Optimize the entire McKesson plasma center transportation network simultaneously; do not optimize one route at a time.',
      'Generate and rank candidate transportation networks: consolidation, splitting, stop reassignment, PLC reassignment, merging, pickup-day balancing, and trailer utilization balancing.',
      'Validate contract rules, pickup schedules, Week A/B cadence, and pickup time windows for every candidate network.',
      'Do not move a center to a day it is not scheduled for or mix Week A and Week B incorrectly.',
      'Do not recommend PLC switch unless the route/centers are eligible under the supplied contract/screening logic.',
      'Do not count deadhead as savings unless the contract says deadhead is charged.',
      'Rank the top 20 scenarios by proven network savings; no savings label unless proposed total network contract cost is lower than current total network contract cost.',
      'Use truck-valid miles when available; otherwise label mileage as estimated.',
      'AI may suggest proposed route groups, but deterministic math must calculate savings proof for every group.',
      'Return proposed route groups with group name, PLC, centers, pickup day, Week A/B, route sequence, grouping reason, and risk notes.'
    ],
    currentNetwork: {
      routeCount: groups.length,
      stopCount: groups.reduce((a,g)=>a+g.stopCount,0),
      weeklyCost: currentNetworkCost,
      annualCost: currentAnnualCost,
      centerLevelData: centerLevelData(groups),
      routeGroups: groups.map(g => ({
        routeName: g.routeName, currentEndpointPLC: g.currentEndpointPLC, routeType: g.routeType, stopCount: g.stopCount,
        weeklyCases: g.weeklyCases, routePalletEstimate: g.routePalletEstimate, currentRoutePathMiles: g.workbookMiles,
        workbookFuel: g.workbookFuel, workbookTotalCost: g.workbookTotalCost, isRelay: g.isRelay, plcMismatch: g.plcMismatch,
        pickupDays: g.pickupDays, weekPatterns: g.weekPatterns, schedule: g.schedule
      }))
    },
    preCalculatedNetworkScenarios: networkScenarios.slice(0, Number(maxRoutes)||20)
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.5',
      input: [
        { role: 'system', content: 'You are a network-wide McKesson cold-chain transportation optimizer. Analyze the full plasma pickup network, not individual routes. Suggest full proposed route groups from center-level data, but use the provided deterministic savings proof for costs. Return only valid JSON matching the schema.' },
        { role: 'user', content: JSON.stringify(payload) }
      ],
      text: { format: { type: 'json_schema', name: 'network_optimizer_result', strict: true, schema: SCHEMA } }
    })
  });
  const data = await res.json();
  if (!res.ok) return fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason: `OpenAI API failed: ${data.error?.message || res.status}` });
  const text = data.output_text || data.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('') || '';
  try {
    const parsed = JSON.parse(text);
    const deterministicScenarios = networkScenarios.slice(0, Number(maxRoutes)||20).map(scenarioForOutput);
    const savingsCandidates = deterministicScenarios.filter(s => s.proposedNetworkCost < s.currentNetworkCost);
    return {
      ...parsed,
      scope: 'network-wide',
      currentNetworkCost: Number(currentNetworkCost || 0),
      currentAnnualCost: Number(currentAnnualCost || 0),
      networkScenarios: deterministicScenarios,
      recommendations: savingsCandidates,
      calculationStatus: `${parsed.calculationStatus || 'OpenAI route-group narrative received.'} Deterministic backend math owns all costs, distribution mix, savings proof, and final status labels.`
    };
  }
  catch { return fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason: 'OpenAI returned non-JSON. Returning deterministic network-wide scenarios.' }); }
}


function centerLevelData(groups) {
  return groups.flatMap(g => (g.stops || []).map(stop => ({
    centerName: stop.routeName || stop.centerName || '',
    centerNumber: stop.centerNumber || '',
    city: stop.city || '',
    state: stop.state || '',
    latitude: Number(stop.lat) || 0,
    longitude: Number(stop.lng) || 0,
    currentPLC: String(stop.routeType || '').toLowerCase() === 'relay' ? (stop.actualPLC || g.currentEndpointPLC || '') : (stop.basePLC || g.currentEndpointPLC || ''),
    routeName: stop.routeNameMckesson || g.routeName || '',
    pickupDay: g.schedule?.pickupDays?.join('; ') || g.pickupDays?.join(', ') || '',
    pickupTimeWindow: stop.pickupHours || '',
    weekA: stop.weekPatternA || '',
    weekB: stop.weekPatternB || '',
    cases: Number(stop.weeklyCases) || 0,
    pallets: (Number(stop.weeklyCases) || 0) / ASSUMPTIONS.casesPerPallet,
    currentMiles: Number(stop.weeklyMiles) || 0,
    currentCost: Number(stop.totalRouteCost) || 0,
    contractRules: contractRules()
  })));
}

function scenarioForOutput(s) {
  const currentNetworkCost = Number(s.currentNetworkCost || 0);
  const proposedNetworkCost = Number(s.proposedNetworkCost || 0);
  const costDifference = Number(s.costDifference ?? (proposedNetworkCost - currentNetworkCost));
  const isSavingsCandidate = proposedNetworkCost < currentNetworkCost;
  const finalStatus = !isSavingsCandidate ? 'Rejected Scenario' : (s.finalStatus || (Number(s.savings || 0) > 0 ? 'Recommended' : 'Needs Contract Validation'));
  return {
    id: s.id,
    scenarioType: s.scenarioType,
    description: s.description,
    currentNetworkCost,
    proposedNetworkCost,
    costDifference,
    costDeltaLabel: s.costDeltaLabel || (isSavingsCandidate ? '✓ Savings Candidate' : '✗ Cost Increase'),
    rejectionReason: s.rejectionReason || (!isSavingsCandidate ? `Rejected because proposed total cost ${proposedNetworkCost} is greater than or equal to current total cost ${currentNetworkCost}; cost increase = ${costDifference}.` : ''),
    currentAnnualCost: Number(s.currentAnnualCost || 0),
    proposedAnnualCost: Number(s.proposedAnnualCost || 0),
    savings: isSavingsCandidate ? Number(s.savings || 0) : 0,
    annualSavings: isSavingsCandidate ? Number(s.annualSavings || 0) : 0,
    savingsPct: isSavingsCandidate ? Number(s.savingsPct || 0) : 0,
    affectedRoutes: s.affectedRoutes || [],
    affectedCenters: s.affectedCenters || [],
    currentDistributionMix: s.currentDistributionMix,
    proposedDistributionMix: s.proposedDistributionMix,
    distributionChange: s.distributionChange,
    centersMovedDallasToWhitestown: s.centersMovedDallasToWhitestown || [],
    centersMovedWhitestownToDallas: s.centersMovedWhitestownToDallas || [],
    totalReassignmentSavings: Number(s.totalReassignmentSavings || 0),
    proposedRouteGroups: s.proposedRouteGroups || [],
    operationalRisk: s.operationalRisk || '',
    confidence: s.confidence || 'Medium',
    formulaUsed: s.formulaUsed || '',
    contractRuleUsed: typeof s.contractRuleUsed === 'string' ? s.contractRuleUsed : JSON.stringify(s.contractRuleUsed || contractRules()),
    scheduleRuleUsed: s.scheduleRuleUsed || '',
    baseline: s.baseline || null,
    proposed: s.proposed || null,
    finalStatus
  };
}

function fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason }) {
  const scenarios = networkScenarios.slice(0, 20).map(scenarioForOutput);
  const savingsCandidates = scenarios.filter(s => s.proposedNetworkCost < s.currentNetworkCost);
  return {
    summary: 'Network-wide McKesson optimizer generated candidate transportation networks across all open plasma centers.',
    scope: 'network-wide',
    dataSource: 'Embedded Excel-derived route data + Rate Table assumptions + deterministic network-wide optimizer',
    calculationStatus: reason,
    confidence: 'Medium',
    currentNetworkCost: Number(currentNetworkCost || 0),
    currentAnnualCost: Number(currentAnnualCost || 0),
    networkScenarios: scenarios,
    recommendations: savingsCandidates,
    leadershipSummary: `Top ${scenarios.length} network scenarios compare current total network cost against proposed total network cost across consolidation, splitting, PLC reassignment, pickup-day balancing, and trailer-utilization balancing.` ,
    questionsForMcKesson: [
      'Confirm whether any deadhead, toll, detention, layover, stop, accessorial, or special-handling charges apply beyond the loaded Rate Table/workbook data.',
      'Confirm route/center eligibility before any PLC reassignment.',
      'Confirm proposed network scenarios preserve pickup windows and Week A / Week B cadence.',
      'Confirm PLC receiving capacity and route staffing for any consolidated or merged network scenario.'
    ]
  };
}
