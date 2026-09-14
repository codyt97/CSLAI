import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = process.cwd();
const recordsPath = path.join(root, 'lib', 'data', 'records.json');
const mapPath = path.join(root, 'public', 'network-map.html');
const optimizerPath = path.join(root, 'lib', 'aiNetworkOptimizer.js');
const optimizerPagePath = path.join(root, 'app', 'openai-optimizer', 'page.jsx');

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift() || [];
  return rows.filter(r => r.some(v => v !== '')).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const n = v => v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const s = v => String(v ?? '').trim();
const sig = r => `${s(r.address).toUpperCase()}|${s(r.zip)}`;

function loadTruth() {
  const b64 = [1, 2, 3, 4]
    .map(i => readFileSync(path.join(root, 'source-data', `1.truth.part${i}.b64`), 'utf8').trim())
    .join('');
  if (b64.length !== 27356) throw new Error(`[truth-sync] Expected 27,356 base64 characters, found ${b64.length}.`);
  const csv = gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  const rows = parseCsv(csv);
  if (rows.length !== 365) throw new Error(`[truth-sync] Expected 365 truth rows from 1.xlsx, found ${rows.length}.`);
  return rows;
}

function mergeTruth(legacyRecords, truthRows) {
  const byId = new Map();
  const byAddress = new Map();
  for (const r of legacyRecords || []) {
    if (r?.id != null && !byId.has(String(r.id))) byId.set(String(r.id), r);
    const key = sig(r || {});
    if (key !== '|' && !byAddress.has(key)) byAddress.set(key, r);
  }

  return truthRows.map(t => {
    const legacy = byId.get(s(t.sourceId)) || byAddress.get(sig(t)) || {};
    const pickupDays = {
      monday: s(t.monday), tuesday: s(t.tuesday), wednesday: s(t.wednesday),
      thursday: s(t.thursday), friday: s(t.friday), saturday: s(t.saturday), sunday: s(t.sunday)
    };
    const id = s(t.optimizerId) || s(t.sourceId);
    const basePLC = s(t.basePLC), actualPLC = s(t.actualPLC), currentRoute = s(t.mckessonRoute);
    const lat = Number.isFinite(Number(legacy.lat)) ? Number(legacy.lat) : null;
    const lng = Number.isFinite(Number(legacy.lng)) ? Number(legacy.lng) : null;

    return {
      ...legacy,
      id,
      sourceId: s(t.sourceId),
      primaryId: s(t.sourceId),
      sourceRow: n(t.sourceRow),
      routeName: s(t.routeName),
      centerName: s(t.routeName),
      centerNumber: s(t.centerNumber),
      centerId: s(t.centerNumber),
      address: s(t.address), city: s(t.city), state: s(t.state), zip: s(t.zip),
      basePLC, basePlc: basePLC,
      actualPLC, actualPlc: actualPLC,
      routeType: s(t.routeType),
      centerStatus: s(t.centerStatus),
      pickupFrequency: s(t.pickupFrequency),
      mckessonRoute: currentRoute,
      routeNameMckesson: currentRoute,
      currentRouteName: currentRoute,
      stopSequenceA: n(t.stopSequenceA),
      stopSequenceB: n(t.stopSequenceB),
      stopSequence: n(t.stopSequenceA) ?? n(t.stopSequenceB),
      weekPatternA: s(t.weekPatternA),
      weekPatternB: s(t.weekPatternB),
      pickupDays,
      ...pickupDays,
      timeZone: s(t.timeZone),
      pickupHours: s(t.pickupHours),
      weightPerCase: n(t.weightPerCase),
      caseLength: n(t.caseLength), caseWidth: n(t.caseWidth), caseHeight: n(t.caseHeight),
      length: n(t.caseLength), width: n(t.caseWidth), height: n(t.caseHeight),
      weeklyMiles: n(t.weeklyMiles) ?? 0,
      weeklyCases: n(t.weeklyCases) ?? 0,
      weeklyLiters: n(t.weeklyLiters) ?? 0,
      weeklyPallets: n(t.weeklyPallets) ?? 0,
      sourceNote: s(t.sourceNote),
      sourceWorkbook: '1.xlsx',
      sourceSheet: 'Sheet1',
      lat, lng,
      hasCoords: lat != null && lng != null,
      plcChanged: Boolean(basePLC && actualPLC && basePLC !== actualPLC)
    };
  });
}

const truthRows = loadTruth();
const legacyRecords = JSON.parse(readFileSync(recordsPath, 'utf8'));
const mergedRecords = mergeTruth(legacyRecords, truthRows);
writeFileSync(recordsPath, JSON.stringify(mergedRecords));

// The homepage is a legacy self-contained HTML map. Replace its embedded records
// so the map, filters and KPIs use the exact same 1.xlsx truth dataset as the APIs.
let html = readFileSync(mapPath, 'utf8');
const marker = 'const DATA = ';
const dataStart = html.indexOf(marker);
if (dataStart < 0) throw new Error('[truth-sync] Could not find embedded DATA payload in network-map.html.');
const lineEnd = html.indexOf('\n', dataStart);
if (lineEnd <= dataStart) throw new Error('[truth-sync] Could not determine embedded DATA payload boundary.');
const raw = html.slice(dataStart + marker.length, lineEnd).trim().replace(/;$/, '');
const payload = JSON.parse(raw);
payload.records = mergedRecords;
html = `${html.slice(0, dataStart)}${marker}${JSON.stringify(payload)};${html.slice(lineEnd)}`;
writeFileSync(mapPath, html);

// Make optimizer source metadata point to the actual truth file.
let optimizer = readFileSync(optimizerPath, 'utf8');
optimizer = optimizer
  .replace("sourceWorkbook:'Analysis - CSL US Plasma Road RFP 2026.xlsx'", "sourceWorkbook:'1.xlsx'")
  .replace("sourceSheet:'Master Data for suppliers'", "sourceSheet:'Sheet1'");

// Current/baseline miles MUST come from 1.xlsx Total Miles by week. Proposed miles
// remain separately routed road miles. This prevents Geoapify from replacing the RFQ baseline.
const oldValidateCurrent = "async function validateCurrent(rows,opts){const groups=groupCurrent(rows).filter(g=>VALID_PLCS.has(g.plc));const detail=await mapLimit(groups,ROUTING_CONCURRENCY,async g=>({currentRouteName:g.routeName,actualPLC:g.plc,stopCount:g.stops.length,stops:g.stops.map(s=>clean(s.id)),...(await routeMetrics(g.stops,g.plc,opts))}));return{detail,routeCount:detail.length,miles:round(sum(detail.map(x=>x.miles))),cost:round(sum(detail.map(x=>x.total)))}}";
const newValidateCurrent = "async function validateCurrent(rows,opts){const groups=groupCurrent(rows).filter(g=>VALID_PLCS.has(g.plc));const detail=groups.map(g=>{const miles=round(sum(g.stops.map(s=>s.weeklyMiles)));return{currentRouteName:g.routeName,actualPLC:g.plc,stopCount:g.stops.length,stops:g.stops.map(s=>clean(s.id)),miles,method:'1.xlsx — Total Miles by week',missingCoordinateIds:[],...sourceRateCost(miles)}});return{detail,routeCount:detail.length,miles:round(sum(detail.map(x=>x.miles))),cost:round(sum(detail.map(x=>x.total)))}}";
if (optimizer.includes(oldValidateCurrent)) optimizer = optimizer.replace(oldValidateCurrent, newValidateCurrent);
else if (!optimizer.includes("method:'1.xlsx — Total Miles by week'")) throw new Error('[truth-sync] Could not patch optimizer baseline mileage logic.');
writeFileSync(optimizerPath, optimizer);

// Keep the OpenAI screen explicit about the two mileage definitions and remove
// savings-style KPI language that could be interpreted as validated savings.
let page = readFileSync(optimizerPagePath, 'utf8');
page = page
  .replace('Current calculated miles', 'RFQ workbook miles')
  .replace('Proposed calculated miles', 'AI proposed road miles')
  .replace('Weekly miles change', 'Raw mileage difference*')
  .replace('Current est. cost', 'Current directional cost*')
  .replace('Proposed est. cost', 'Proposed directional cost*')
  .replace('Annual opportunity', 'Directional opportunity*');
const warning = '<div style={styles.warning}><b>*Mileage definition:</b> Current baseline mileage comes directly from 1.xlsx (Total Miles by week). AI proposed mileage is calculated from the proposed road route. The difference is directional only and is not validated savings.</div>';
if (!page.includes('*Mileage definition:')) {
  page = page.replace('<div style={styles.summary}>{result.summary}</div>', `<div style={styles.summary}>{result.summary}</div>${warning}`);
}
writeFileSync(optimizerPagePath, page);

const open = mergedRecords.filter(r => String(r.centerStatus).toUpperCase() === 'OPEN');
const totals = open.reduce((a, r) => {
  a.miles += Number(r.weeklyMiles) || 0; a.cases += Number(r.weeklyCases) || 0;
  a.liters += Number(r.weeklyLiters) || 0; a.pallets += Number(r.weeklyPallets) || 0; return a;
}, { miles: 0, cases: 0, liters: 0, pallets: 0 });
console.log(`[truth-sync] 1.xlsx -> ${mergedRecords.length} rows (${open.length} OPEN). OPEN totals: ${totals.miles.toFixed(2)} miles, ${totals.cases.toFixed(2)} cases, ${totals.liters.toFixed(2)} liters, ${totals.pallets.toFixed(2)} pallets.`);