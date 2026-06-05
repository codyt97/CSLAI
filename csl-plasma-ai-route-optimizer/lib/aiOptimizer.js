import { generateNetworkCandidates, groupRouteRecords, ASSUMPTIONS, contractRules } from './routeMath.js';

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
    operationalRisk: { type: 'string' },
    confidence: { type: 'string' },
    formulaUsed: { type: 'string' },
    contractRuleUsed: { type: 'string' },
    scheduleRuleUsed: { type: 'string' },
    finalStatus: { type: 'string', enum: ['Recommended','Not Recommended','Needs Contract Validation'] }
  },
  required: ['id','scenarioType','description','currentNetworkCost','proposedNetworkCost','currentAnnualCost','proposedAnnualCost','savings','annualSavings','savingsPct','affectedRoutes','affectedCenters','operationalRisk','confidence','formulaUsed','contractRuleUsed','scheduleRuleUsed','finalStatus']
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
      'Use truck-valid miles when available; otherwise label mileage as estimated.'
    ],
    currentNetwork: {
      routeCount: groups.length,
      stopCount: groups.reduce((a,g)=>a+g.stopCount,0),
      weeklyCost: currentNetworkCost,
      annualCost: currentAnnualCost,
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
        { role: 'system', content: 'You are a network-wide McKesson cold-chain transportation optimizer. Analyze the full plasma pickup network, not individual routes. Return only valid JSON matching the schema.' },
        { role: 'user', content: JSON.stringify(payload) }
      ],
      text: { format: { type: 'json_schema', name: 'network_optimizer_result', strict: true, schema: SCHEMA } }
    })
  });
  const data = await res.json();
  if (!res.ok) return fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason: `OpenAI API failed: ${data.error?.message || res.status}` });
  const text = data.output_text || data.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('') || '';
  try { return JSON.parse(text); }
  catch { return fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason: 'OpenAI returned non-JSON. Returning deterministic network-wide scenarios.' }); }
}

function scenarioForOutput(s) {
  return {
    id: s.id,
    scenarioType: s.scenarioType,
    description: s.description,
    currentNetworkCost: Number(s.currentNetworkCost || 0),
    proposedNetworkCost: Number(s.proposedNetworkCost || 0),
    currentAnnualCost: Number(s.currentAnnualCost || 0),
    proposedAnnualCost: Number(s.proposedAnnualCost || 0),
    savings: Number(s.savings || 0),
    annualSavings: Number(s.annualSavings || 0),
    savingsPct: Number(s.savingsPct || 0),
    affectedRoutes: s.affectedRoutes || [],
    affectedCenters: s.affectedCenters || [],
    operationalRisk: s.operationalRisk || '',
    confidence: s.confidence || 'Medium',
    formulaUsed: s.formulaUsed || '',
    contractRuleUsed: typeof s.contractRuleUsed === 'string' ? s.contractRuleUsed : JSON.stringify(s.contractRuleUsed || contractRules()),
    scheduleRuleUsed: s.scheduleRuleUsed || '',
    finalStatus: s.savings > 0 ? 'Recommended' : 'Not Recommended'
  };
}

function fallbackResult({ networkScenarios, currentNetworkCost, currentAnnualCost, reason }) {
  const scenarios = networkScenarios.slice(0, 20).map(scenarioForOutput);
  return {
    summary: 'Network-wide McKesson optimizer generated candidate transportation networks across all open plasma centers.',
    scope: 'network-wide',
    dataSource: 'Embedded Excel-derived route data + Rate Table assumptions + deterministic network-wide optimizer',
    calculationStatus: reason,
    confidence: 'Medium',
    currentNetworkCost: Number(currentNetworkCost || 0),
    currentAnnualCost: Number(currentAnnualCost || 0),
    networkScenarios: scenarios,
    recommendations: scenarios,
    leadershipSummary: `Top ${scenarios.length} network scenarios compare current total network cost against proposed total network cost across consolidation, splitting, PLC reassignment, pickup-day balancing, and trailer-utilization balancing.` ,
    questionsForMcKesson: [
      'Confirm whether any deadhead, toll, detention, layover, stop, accessorial, or special-handling charges apply beyond the loaded Rate Table/workbook data.',
      'Confirm route/center eligibility before any PLC reassignment.',
      'Confirm proposed network scenarios preserve pickup windows and Week A / Week B cadence.',
      'Confirm PLC receiving capacity and route staffing for any consolidated or merged network scenario.'
    ]
  };
}
