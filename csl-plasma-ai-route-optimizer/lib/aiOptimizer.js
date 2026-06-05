import { generateDeterministicCandidates, groupRouteRecords, getRouteGroup, ASSUMPTIONS, contractRules } from './routeMath.js';

const STOP_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, centerNumber: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' },
    currentRoute: { type: 'string' }, proposedStop: { type: 'number' }, pickupDay: { type: 'string' }, pickupTimeWindow: { type: 'string' },
    weekA: { type: 'string' }, weekB: { type: 'string' }, currentPLC: { type: 'string' }, cases: { type: 'number' }, pallets: { type: 'number' },
    nonCslPickupDayFlag: { type: 'boolean' }
  },
  required: ['id','name','centerNumber','city','state','currentRoute','proposedStop','pickupDay','pickupTimeWindow','weekA','weekB','currentPLC','cases','pallets','nonCslPickupDayFlag']
};

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
        recommendationType: { type: 'string' }, currentRoutesImpacted: { type: 'array', items: { type: 'string' } },
        newRouteName: { type: 'string' }, currentPLC: { type: 'string' }, proposedPLC: { type: 'string' }, newPLC: { type: 'string' },
        pickupDayTimeWindow: { type: 'string' }, weekAB: { type: 'string' }, stops: { type: 'array', items: STOP_SCHEMA },
        currentChargeableMiles: { type: 'number' }, newChargeableMiles: { type: 'number' }, weeklyMilesSaved: { type: 'number' },
        currentFuel: { type: 'number' }, newFuel: { type: 'number' }, currentCost: { type: 'number' }, newCost: { type: 'number' },
        weeklySavings: { type: 'number' }, annualSavings: { type: 'number' }, formulaUsed: { type: 'string' }, contractRuleUsed: { type: 'string' },
        scheduleRuleUsed: { type: 'string' }, reason: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string' }, finalStatus: { type: 'string', enum: ['Recommended','Not Recommended','Needs Contract Validation'] }
      },
      required: ['recommendationType','currentRoutesImpacted','newRouteName','currentPLC','proposedPLC','newPLC','pickupDayTimeWindow','weekAB','stops','currentChargeableMiles','newChargeableMiles','weeklyMilesSaved','currentFuel','newFuel','currentCost','newCost','weeklySavings','annualSavings','formulaUsed','contractRuleUsed','scheduleRuleUsed','reason','risks','confidence','finalStatus']
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
    return fallbackResult({ scope, candidates, reason: 'OPENAI_API_KEY is not configured. Returning deterministic contract-aware route calculator output.' });
  }

  const payload = {
    userQuestion: question,
    objective,
    contractLogic: contractRules(),
    assumptions: ASSUMPTIONS,
    hardRules: [
      'Optimize only within current McKesson contract rules and plasma center pickup schedule.',
      'Do not treat each center as its own shipment; centers are stops inside a route group.',
      'Charge begins at first pickup; deadhead/origin miles are tracked but not charged unless contract logic says otherwise.',
      'Use Rate Table linehaul, fuel surcharge, workbook accessorials when present, 48 ft refrigerated trailer, and 70 cases = 1 pallet.',
      'Do not move a center to a day it is not scheduled for, do not mix Week A/B cadence incorrectly, and do not violate pickup time windows.',
      'Do not recommend a PLC switch unless route eligibility is true (current PLC retained, relay route, or Base/Actual PLC mismatch).',
      'Do not label savings unless proposed total contract cost is lower than current total contract cost.',
      'Use actual truck-valid miles for 48 ft refrigerated trailer when available; otherwise label miles as estimated only.'
    ],
    routeGroups: groups.map(g => ({
      routeName: g.routeName, stopCount: g.stopCount, currentEndpointPLC: g.currentEndpointPLC, routeType: g.routeType,
      weeklyCases: g.weeklyCases, routePalletEstimate: g.routePalletEstimate, palletCalculationBasis: g.palletCalculationBasis,
      currentRoutePathMiles: g.workbookMiles, workbookAllocatedMiles: g.workbookAllocatedMiles,
      workbookLinehaul: g.workbookLinehaul, workbookFuel: g.workbookFuel, workbookTotalCost: g.workbookTotalCost,
      isRelay: g.isRelay, plcMismatch: g.plcMismatch, pickupDays: g.pickupDays, weekPatterns: g.weekPatterns, schedule: g.schedule,
      stops: g.stops.map((s,i)=>({ stop:i+1, id:s.id, name:s.routeName, centerNumber:s.centerNumber, city:s.city, state:s.state, basePLC:s.basePLC, actualPLC:s.actualPLC, pickupHours:s.pickupHours, weekA:s.weekPatternA||'', weekB:s.weekPatternB||'', pickupDays:s.pickupDays||{} }))
    })),
    preCalculatedCandidates: candidates.slice(0, 12)
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.5',
      input: [
        { role: 'system', content: 'You are a contract-aware cold-chain transportation optimization analyst. Identify route patterns, suggest only contract/schedule-feasible route rebuilds, prove savings with formulas, flag risks, and return only valid JSON that matches the schema.' },
        { role: 'user', content: JSON.stringify(payload) }
      ],
      text: { format: { type: 'json_schema', name: 'route_optimizer_result', strict: true, schema: SCHEMA } }
    })
  });
  const data = await res.json();
  if (!res.ok) return fallbackResult({ scope, candidates, reason: `OpenAI API failed: ${data.error?.message || res.status}` });
  const text = data.output_text || data.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('') || '';
  try { return JSON.parse(text); }
  catch { return fallbackResult({ scope, candidates, reason: 'OpenAI returned non-JSON. Returning deterministic contract-aware candidates.' }); }
}

function fallbackResult({ scope, candidates, reason }) {
  return {
    summary: 'Contract-aware route optimization candidates generated from Excel-derived route data, current pickup schedule, McKesson contract assumptions, and deterministic route calculator.',
    scope,
    dataSource: 'Embedded Excel-derived route data + Rate Table assumptions + deterministic contract-aware route calculator',
    calculationStatus: reason,
    confidence: 'Medium',
    recommendations: candidates.slice(0, 8).map(c => ({
      recommendationType: c.recommendationType,
      currentRoutesImpacted: c.currentRoutesImpacted,
      newRouteName: c.newRouteName,
      currentPLC: c.currentPLC || '',
      proposedPLC: c.proposedPLC || c.newPLC || '',
      newPLC: c.newPLC,
      pickupDayTimeWindow: c.pickupDayTimeWindow || '',
      weekAB: c.weekAB || '',
      stops: c.stops || [],
      currentChargeableMiles: Number(c.currentChargeableMiles || 0),
      newChargeableMiles: Number(c.newChargeableMiles || 0),
      weeklyMilesSaved: Number(c.weeklyMilesSaved || 0),
      currentFuel: Number(c.currentFuel || 0),
      newFuel: Number(c.newFuel || 0),
      currentCost: Number(c.currentCost || 0),
      newCost: Number(c.newCost || 0),
      weeklySavings: Number(c.weeklySavings || 0),
      annualSavings: Number(c.annualSavings || 0),
      formulaUsed: c.formulaUsed || '',
      contractRuleUsed: c.contractRuleUsed || '',
      scheduleRuleUsed: c.scheduleRuleUsed || '',
      reason: c.reason,
      risks: c.risks || [],
      confidence: c.confidence || 'Medium',
      finalStatus: c.finalStatus || 'Needs Contract Validation'
    })),
    questionsForMcKesson: [
      'Confirm whether any deadhead, toll, detention, layover, stop, accessorial, or special-handling charges apply beyond the loaded Rate Table/workbook data.',
      'Confirm route eligibility before switching any center or route endpoint PLC.',
      'Confirm proposed rebuilds preserve pickup windows and Week A / Week B cadence.',
      'Confirm the proposed PLC can receive the expected weekly pallet/case volume.'
    ]
  };
}
