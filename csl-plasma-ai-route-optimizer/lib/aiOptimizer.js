import { generateDeterministicCandidates, groupRouteRecords, getRouteGroup, ASSUMPTIONS } from './routeMath.js';

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
      'Flag >18 pallets and >11 driver hours as validation warnings.',
      'Do not claim savings unless current full route group is compared to proposed full route group.'
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
