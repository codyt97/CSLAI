import records from './data/records.json' assert { type: 'json' };
import rateTable from './data/rateTable.json' assert { type: 'json' };
import { PLC_COORDS, haversineMiles } from './routeMath.js';
import { fetchGeoapifyRoute } from './geoapify.js';

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
    routes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          aiRouteName: { type: 'string' },
          proposedPLC: { type: 'string', enum: ['Dallas PLC', 'Whitestown PLC'] },
          routeType: { type: 'string' },
          sourceRoutes: { type: 'array', items: { type: 'string' } },
          stops: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' },
                proposedStop: { type: 'integer', minimum: 1 }
              },
              required: ['id', 'proposedStop']
            }
          },
          reason: { type: 'string' },
          risks: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] }
        },
        required: ['aiRouteName','proposedPLC','routeType','sourceRoutes','stops','reason','risks','confidence']
      }
    },
    questionsForMcKesson: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary','confidence','routes','questionsForMcKesson']
};

const SOURCE_RULES = {
  sourceWorkbook: 'Analysis - CSL US Plasma Road RFP 2026.xlsx',
  sourceSheet: 'Master Data for suppliers',
  instructionsSheet: 'Instructions',
  scenarioA: 'Current Network',
  scenarioB: 'Current Network Optimization',
  fixedMode: 'Keep each center Actual PLC unchanged. Route grouping and stop sequence may change.',
  flexibleMode: 'Supplier/AI may propose Dallas PLC or Whitestown PLC as Proposal PLC. Route grouping and stop sequence may change.',
  preservedInputs: ['Center Status','Pickup Frequency','Week Pattern A','Week Pattern B','Pickup Day','TIME ZONE','PICK UP HOURS','Weight per case','Total Cases by week','Total Liters by week','Total Pallets by week Average']
};

function clean(v){ return String(v ?? '').trim(); }
function num(v){ const n=Number(v); return Number.isFinite(n) ? n : 0; }
function round(v,d=2){ const m=10**d; return Math.round(num(v)*m)/m; }
function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }
function sum(arr){ return arr.reduce((a,b)=>a+num(b),0); }
function isOpen(r){ return clean(r.centerStatus).toUpperCase()==='OPEN'; }
function routeName(r){ return clean(r.routeNameMckesson || r.mckessonRoute || 'UNASSIGNED'); }
function currentPickupDay(r){
  const map=[['M','monday'],['T','tuesday'],['W','wednesday'],['TH','thursday'],['F','friday'],['SA','saturday'],['SU','sunday']];
  return map.filter(([,k])=>clean(r[k])).map(([d,k])=>`${d}:${clean(r[k])}`).join('; ');
}
function sourceSequence(r){
  const a=num(r.stopSequenceA), b=num(r.stopSequenceB);
  return a || b || 9999;
}
function sourceCenter(r){
  return {
    id: clean(r.id), centerName: clean(r.routeName), centerId: clean(r.centerNumber), address: clean(r.address), city: clean(r.city), state: clean(r.state), zip: clean(r.zip),
    basePLC: clean(r.basePLC), actualPLC: clean(r.actualPLC), routeType: clean(r.routeType), centerStatus: clean(r.centerStatus), pickupFrequency: clean(r.pickupFrequency),
    currentRouteName: routeName(r), stopSequenceA: num(r.stopSequenceA)||null, stopSequenceB: num(r.stopSequenceB)||null,
    weekPatternA: clean(r.weekPatternA), weekPatternB: clean(r.weekPatternB), pickupDay: currentPickupDay(r), timeZone: clean(r.timeZone), pickupHours: clean(r.pickupHours),
    weightPerCase: num(r.weightPerCase), totalMilesByWeek: num(r.weeklyMiles), totalCasesByWeek: num(r.weeklyCases), totalLitersByWeek: num(r.weeklyLiters), totalPalletsByWeekAverage: num(r.weeklyPallets),
    lat: Number.isFinite(Number(r.lat)) ? Number(r.lat) : null, lng: Number.isFinite(Number(r.lng)) ? Number(r.lng) : null
  };
}
function scopedRecords(scope, selectedRoute){
  let rows=records.filter(isOpen);
  if(scope==='selected' && selectedRoute) rows=rows.filter(r=>routeName(r).toUpperCase()===clean(selectedRoute).toUpperCase());
  if(scope==='relay') rows=rows.filter(r=>clean(r.routeType).toLowerCase()==='relay' || clean(r.basePLC)!==clean(r.actualPLC) || ['ALLENTOWN','BUFFALO','PHILLY'].includes(routeName(r).toUpperCase()));
  return rows;
}
function groupCurrent(rows){
  // A calculated current-road baseline needs one destination per path, so mixed-PLC route names are split by Actual PLC.
  const m=new Map();
  for(const r of rows){
    const plc=clean(r.actualPLC);
    const key=`${routeName(r)}||${plc}`;
    if(!m.has(key))m.set(key,[]);
    m.get(key).push(r);
  }
  return [...m.entries()].map(([key,stops])=>({
    key, routeName:routeName(stops[0]), plc:clean(stops[0].actualPLC), stops:[...stops].sort((a,b)=>sourceSequence(a)-sourceSequence(b))
  }));
}
function fallbackMiles(orderedStops, plc){
  const pts=orderedStops.filter(s=>Number.isFinite(Number(s.lat))&&Number.isFinite(Number(s.lng))).map(s=>({lat:Number(s.lat),lng:Number(s.lng)}));
  const dest=PLC_COORDS[plc];
  if(!pts.length || !dest) return 0;
  let miles=0;
  for(let i=1;i<pts.length;i++) miles+=haversineMiles(pts[i-1],pts[i]);
  miles+=haversineMiles(pts[pts.length-1],dest);
  return round(miles*1.18,2);
}
function sourceRateCost(miles){
  const linehaul=miles*num(rateTable?.dedicatedTransportationRatePerMile || 0);
  const fuelPct=num(rateTable?.averageFuelSurchargePctFromWorkbook || 0);
  const fuel=linehaul*fuelPct;
  return { linehaul:round(linehaul,2), fuel:round(fuel,2), total:round(linehaul+fuel,2), ratePerMile:num(rateTable?.dedicatedTransportationRatePerMile||0), fuelPct };
}
async function routeMetrics(orderedStops, plc, {useActualRoadRoutes=true,tollPreference='allow'}={}){
  const missing=orderedStops.filter(s=>!Number.isFinite(Number(s.lat))||!Number.isFinite(Number(s.lng)));
  const valid=orderedStops.filter(s=>Number.isFinite(Number(s.lat))&&Number.isFinite(Number(s.lng)));
  let miles=fallbackMiles(valid,plc), method='Fallback geodesic × 1.18';
  let timeHours=null;
  if(useActualRoadRoutes && process.env.GEOAPIFY_API_KEY && valid.length){
    try{
      const dest=PLC_COORDS[plc];
      const waypoints=valid.map(s=>({lat:Number(s.lat),lng:Number(s.lng)}));
      if(dest) waypoints.push({lat:dest.lat,lng:dest.lng});
      const route=await fetchGeoapifyRoute({waypoints,avoidTolls:tollPreference==='avoid'});
      if(route?.distanceMiles){ miles=round(route.distanceMiles,2); timeHours=route.timeHours ?? null; method='Geoapify actual road route'; }
    }catch(err){ method=`Fallback geodesic × 1.18 (Geoapify error: ${err.message})`; }
  }
  const cost=sourceRateCost(miles);
  return { miles, timeHours, method, missingCoordinateIds:missing.map(s=>clean(s.id)), ...cost };
}
async function validateCurrent(rows, opts){
  const groups=groupCurrent(rows); const detail=[];
  for(const g of groups){
    const m=await routeMetrics(g.stops,g.plc,opts);
    detail.push({ currentRouteName:g.routeName, actualPLC:g.plc, stopCount:g.stops.length, stops:g.stops.map(s=>clean(s.id)), ...m });
  }
  return { detail, routeCount:detail.length, miles:round(sum(detail.map(x=>x.miles)),2), cost:round(sum(detail.map(x=>x.total)),2) };
}
function validateDesignCoverage(design, rows, mode){
  const validIds=new Set(rows.map(r=>clean(r.id)));
  const actualById=new Map(rows.map(r=>[clean(r.id),clean(r.actualPLC)]));
  const seen=new Map(); const errors=[];
  for(const route of design.routes||[]){
    const seq=(route.stops||[]).map(s=>num(s.proposedStop)).sort((a,b)=>a-b);
    if(seq.some((v,i)=>v!==i+1)) errors.push(`${route.aiRouteName}: stop sequence must be 1..N without gaps or duplicates.`);
    for(const s of route.stops||[]){
      const id=clean(s.id); seen.set(id,(seen.get(id)||0)+1);
      if(!validIds.has(id)) errors.push(`${route.aiRouteName}: unknown center ID ${id}.`);
      if(mode==='fixed' && validIds.has(id) && clean(route.proposedPLC)!==actualById.get(id)) errors.push(`${route.aiRouteName}: center ${id} Actual PLC is ${actualById.get(id)}, so fixed-PLC mode cannot send it to ${route.proposedPLC}.`);
    }
  }
  const missing=[...validIds].filter(id=>!seen.has(id));
  const duplicate=[...seen].filter(([,n])=>n>1).map(([id])=>id);
  if(missing.length) errors.push(`${missing.length} source centers were not assigned.`);
  if(duplicate.length) errors.push(`${duplicate.length} source centers were assigned more than once.`);
  return { valid:errors.length===0, errors, missing, duplicate };
}
async function validateProposed(design, rows, opts){
  const byId=new Map(rows.map(r=>[clean(r.id),r])); const detail=[];
  for(const route of design.routes||[]){
    const stopRefs=[...(route.stops||[])].sort((a,b)=>num(a.proposedStop)-num(b.proposedStop));
    const stops=stopRefs.map(s=>byId.get(clean(s.id))).filter(Boolean);
    const m=await routeMetrics(stops,clean(route.proposedPLC),opts);
    detail.push({
      recommendationType: 'OpenAI Route Rebuild', aiRouteName:clean(route.aiRouteName), newRouteName:clean(route.aiRouteName), newPLC:clean(route.proposedPLC), routeType:clean(route.routeType),
      currentRoutesImpacted:uniq(stops.map(routeName)), sourceRoutes:uniq(route.sourceRoutes||[]),
      stops:stops.map((s,i)=>({id:clean(s.id),name:clean(s.routeName),centerNumber:clean(s.centerNumber),city:clean(s.city),state:clean(s.state),currentRoute:routeName(s),currentActualPLC:clean(s.actualPLC),proposedStop:i+1,weeklyCases:num(s.weeklyCases),weeklyLiters:num(s.weeklyLiters),weeklyPallets:num(s.weeklyPallets)})),
      weeklyCases:round(sum(stops.map(s=>s.weeklyCases)),2), weeklyLiters:round(sum(stops.map(s=>s.weeklyLiters)),2), weeklyPallets:round(sum(stops.map(s=>s.weeklyPallets)),2),
      newChargeableMiles:m.miles, newCost:m.total, newLinehaul:m.linehaul, newFuel:m.fuel, routingMethod:m.method, missingCoordinateIds:m.missingCoordinateIds,
      reason:clean(route.reason), risks:route.risks||[], confidence:route.confidence||design.confidence||'Medium'
    });
  }
  return { detail, routeCount:detail.length, miles:round(sum(detail.map(x=>x.newChargeableMiles)),2), cost:round(sum(detail.map(x=>x.newCost)),2) };
}
function buildMasterDataRows(proposedRoutes, sourceRows){
  const byId=new Map(sourceRows.map(r=>[clean(r.id),r])); const rows=[];
  for(const route of proposedRoutes){
    for(const s of route.stops){
      const r=byId.get(clean(s.id)); if(!r)continue;
      rows.push({
        'GHA CENTERS':'','ID':clean(r.id),'Center Name':clean(r.routeName),'Center ID':clean(r.centerNumber),'Address':clean(r.address),'City':clean(r.city),'State':clean(r.state),'ZIP':clean(r.zip),
        'Base PLC':clean(r.basePLC),'Actual PLC':clean(r.actualPLC),'Proposal PLC':route.newPLC,'Route Type':route.routeType||clean(r.routeType),'Center Status':clean(r.centerStatus),'Pickup Frequency':clean(r.pickupFrequency),
        'Current Route Name':routeName(r),'Optimized/Supplier Route Name':route.newRouteName,'Stop Sequence':s.proposedStop,'Week Pattern A':clean(r.weekPatternA),'Week Pattern B':clean(r.weekPatternB),'Pickup Day':currentPickupDay(r),
        'TIME ZONE':clean(r.timeZone),'PICK UP HOURS':clean(r.pickupHours),'Weight per case':num(r.weightPerCase),'Length':num(r.caseLength),'Width':num(r.caseWidth),'Height':num(r.caseHeight),
        'Total Miles by week':'Calculated at route level; see route summary','Total Cases by week':num(r.weeklyCases),'Total Liters by week':num(r.weeklyLiters),'Total Pallets by week Average':num(r.weeklyPallets)
      });
    }
  }
  return rows;
}

export async function runAiRouteOptimizer(input){
  const { scope='all', routeName:selectedRoute='', question='', objective='miles', mode='fixed', useActualRoadRoutes=true, tollPreference='allow' }=input||{};
  if(!['fixed','flexible'].includes(mode)) throw new Error('mode must be fixed or flexible');
  const rows=scopedRecords(scope,selectedRoute);
  if(!rows.length) throw new Error('No source centers match the requested scope.');
  if(!process.env.OPENAI_API_KEY){
    return { aiExecuted:false, error:'OPENAI_API_KEY is not configured. No AI optimization was performed.', scope, mode, dataSource:`${SOURCE_RULES.sourceWorkbook} → ${SOURCE_RULES.sourceSheet}`, calculationStatus:'NOT OPTIMIZED' };
  }

  const centers=rows.map(sourceCenter);
  const currentRouteSummary=groupCurrent(rows).map(g=>({ currentRouteName:g.routeName, actualPLC:g.plc, stopCount:g.stops.length, centerIds:g.stops.map(s=>clean(s.id)), officialStopOrder:g.stops.map(s=>({id:clean(s.id),sequence:sourceSequence(s)})) }));
  const system=`You are the OpenAI network-design engine for CSL US Plasma Road RFP Scenario B (Current Network Optimization). Optimize the provided CURRENT MCKESSON NETWORK. Use only the supplied workbook-derived data. Do not invent centers, volumes, schedules, PLCs, constraints, miles, costs, or operational facts. Your job is network design only: assign every supplied center exactly once to an AI route, choose route grouping and stop sequence, and ${mode==='fixed'?'KEEP EACH CENTER\'S ACTUAL PLC EXACTLY UNCHANGED':'you MAY choose Dallas PLC or Whitestown PLC as the proposed destination for each AI route'}. Preserve CSL-controlled pickup frequency, Week A/B, pickup days, time zone, pickup hours, cases, liters and pallets. Do not calculate or claim mileage/cost savings; the backend routing calculator will validate your design. Routes must have one destination PLC. Stop sequence must be 1..N with no duplicates or gaps.`;
  const payload={
    optimizationMode:mode==='fixed'?'PLC FIXED — no destination changes':'PLC FLEXIBLE — Proposal PLC may change', objective,
    rfqRules:SOURCE_RULES, userQuestion:question, currentRouteSummary, centers
  };
  const model=process.env.OPENAI_MODEL || 'gpt-5.5';
  const res=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
    body:JSON.stringify({ model, input:[{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}], text:{format:{type:'json_schema',name:'csl_route_network_design',strict:true,schema:DESIGN_SCHEMA}} })
  });
  const data=await res.json();
  if(!res.ok) return { aiExecuted:false, error:`OpenAI API failed: ${data.error?.message||res.status}`, scope, mode, modelUsed:model, calculationStatus:'NOT OPTIMIZED' };
  const text=data.output_text || data.output?.flatMap(o=>o.content||[]).map(c=>c.text||'').join('') || '';
  let design;
  try{ design=JSON.parse(text); }catch{ return {aiExecuted:false,error:'OpenAI returned an unreadable network design.',scope,mode,modelUsed:model,calculationStatus:'NOT OPTIMIZED'}; }

  const coverage=validateDesignCoverage(design,rows,mode);
  if(!coverage.valid){
    return { aiExecuted:true, optimizationAccepted:false, scope, mode, modelUsed:model, dataSource:`${SOURCE_RULES.sourceWorkbook} → ${SOURCE_RULES.sourceSheet}`, calculationStatus:'OpenAI produced a proposal, but backend validation rejected it.', validationWarnings:coverage.errors, rawDesign:design };
  }

  const opts={useActualRoadRoutes,tollPreference};
  const current=await validateCurrent(rows,opts);
  const proposed=await validateProposed(design,rows,opts);
  const weeklyMilesSaved=round(current.miles-proposed.miles,2);
  const weeklySavings=round(current.cost-proposed.cost,2);
  const recommendations=proposed.detail.map(r=>({...r,currentChargeableMiles:0,currentCost:0,weeklyMilesSaved:0,weeklySavings:0,annualSavings:0}));
  const missingCoords=uniq([...current.detail.flatMap(x=>x.missingCoordinateIds||[]),...proposed.detail.flatMap(x=>x.missingCoordinateIds||[])]);
  return {
    aiExecuted:true, optimizationAccepted:true, summary:design.summary, scope, mode, modelUsed:model,
    dataSource:`${SOURCE_RULES.sourceWorkbook} → ${SOURCE_RULES.sourceSheet}; rules from Instructions; mileage validation by ${process.env.GEOAPIFY_API_KEY&&useActualRoadRoutes?'Geoapify':'fallback geodesic × 1.18'}`,
    calculationStatus: missingCoords.length ? `AI design accepted. Mileage is incomplete for ${missingCoords.length} center(s) without coordinates.` : 'AI design accepted and backend route validation completed.',
    confidence:design.confidence,
    portfolio:{ currentCalculatedRouteCount:current.routeCount, proposedRouteCount:proposed.routeCount, currentCalculatedRoadMiles:current.miles, proposedCalculatedRoadMiles:proposed.miles, weeklyMilesSaved, currentEstimatedCost:current.cost, proposedEstimatedCost:proposed.cost, weeklySavings, annualSavings:round(weeklySavings*52,2), pricingBasis:`Rate Table dedicated transportation rate $${num(rateTable?.dedicatedTransportationRatePerMile).toFixed(2)}/mile + ${(num(rateTable?.averageFuelSurchargePctFromWorkbook)*100).toFixed(2)}% workbook fuel surcharge` },
    recommendations, currentRouteValidation:current.detail, validationWarnings:missingCoords.length?[`Missing coordinates for center IDs: ${missingCoords.join(', ')}`]:[],
    questionsForMcKesson:design.questionsForMcKesson||[], masterDataRows:buildMasterDataRows(proposed.detail,rows)
  };
}
