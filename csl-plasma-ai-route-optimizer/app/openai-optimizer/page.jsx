'use client';

import { useEffect, useMemo, useState } from 'react';

const money = (v) => Number(v || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = (v) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

function Metric({ label, value }) {
  return <div style={styles.metric}><div style={styles.metricLabel}>{label}</div><div style={styles.metricValue}>{value}</div></div>;
}

function ResultPanel({ title, result, loading, mode }) {
  if (loading) return <section style={styles.panel}><h2 style={styles.h2}>{title}</h2><div style={styles.status}>OpenAI is rebuilding the network and the backend is validating the proposal…</div></section>;
  if (!result) return <section style={styles.panel}><h2 style={styles.h2}>{title}</h2><div style={styles.empty}>Run this mode to create a proposal.</div></section>;
  if (!result.aiExecuted || result.optimizationAccepted === false) {
    const diagnostics = result.sourceDiagnostics;
    return <section style={styles.panel}>
      <h2 style={styles.h2}>{title}</h2>
      <div style={styles.error}><b>{result.calculationStatus || 'NOT OPTIMIZED'}</b><br />{result.error || (result.validationWarnings || []).join(' ') || 'The optimizer did not return an accepted result.'}</div>
      {diagnostics && <div style={styles.diagnostics}>
        <b>Source check:</b> {diagnostics.suppliedCenters ?? '—'} supplied · {diagnostics.eligibleCenters ?? '—'} eligible · {diagnostics.excludedCenters ?? 0} excluded
      </div>}
    </section>;
  }
  const p = result.portfolio || {};
  return (
    <section style={styles.panel}>
      <div style={styles.panelHead}><div><h2 style={styles.h2}>{title}</h2><div style={styles.subtle}>{result.modelUsed} · {result.confidence || '—'} confidence</div></div><span style={mode === 'fixed' ? styles.badgeFixed : styles.badgeFlexible}>{mode === 'fixed' ? 'PLC LOCKED' : 'PLC FLEXIBLE'}</span></div>
      <div style={styles.metrics}>
        <Metric label="Current calculated miles" value={number(p.currentCalculatedRoadMiles)} />
        <Metric label="Proposed calculated miles" value={number(p.proposedCalculatedRoadMiles)} />
        <Metric label="Weekly miles change" value={number(p.weeklyMilesSaved)} />
        <Metric label="Current est. cost" value={money(p.currentEstimatedCost)} />
        <Metric label="Proposed est. cost" value={money(p.proposedEstimatedCost)} />
        <Metric label="Annual opportunity" value={money(p.annualSavings)} />
      </div>
      <div style={styles.summary}>{result.summary}</div>
      <div style={styles.source}><b>Source:</b> {result.dataSource}</div>
      {!!result.validationWarnings?.length && <div style={styles.warning}>{result.validationWarnings.join(' ')}</div>}
      <div style={styles.routesTitle}>AI route rebuild ({(result.recommendations || []).length} routes)</div>
      <div style={styles.routeTableWrap}>
        <table style={styles.table}>
          <thead><tr><th style={styles.th}>AI Route</th><th style={styles.th}>PLC</th><th style={styles.th}>Stops</th><th style={styles.th}>Pallets</th><th style={styles.th}>Miles</th><th style={styles.th}>Source Route(s)</th></tr></thead>
          <tbody>{(result.recommendations || []).map((r, i) => <tr key={`${r.newRouteName}-${i}`}><td style={styles.td}><b>{r.newRouteName}</b></td><td style={styles.td}>{r.newPLC}</td><td style={styles.td}>{r.stops?.length || 0}</td><td style={styles.td}>{number(r.weeklyPallets)}</td><td style={styles.td}>{number(r.newChargeableMiles)}</td><td style={styles.td}>{(r.currentRoutesImpacted || []).join(', ')}</td></tr>)}</tbody>
        </table>
      </div>
      {!!result.masterDataRows?.length && <button style={styles.secondaryButton} onClick={() => downloadCsv(result.masterDataRows, `CSL_AI_${mode === 'fixed' ? 'Fixed_PLC' : 'Flexible_PLC'}_Master_Data.csv`)}>Export Master Data format</button>}
    </section>
  );
}

function downloadCsv(rows, filename) {
  if (!rows?.length) return;
  const headers = Object.keys(rows[0]);
  const q = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = [headers.map(q).join(','), ...rows.map(r => headers.map(h => q(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function readApiResponse(res) {
  const text = await res.text();
  if (!text) {
    return { aiExecuted: false, optimizationAccepted: false, calculationStatus: 'NOT OPTIMIZED', error: `Optimizer returned an empty response (HTTP ${res.status}).` };
  }
  try {
    const json = JSON.parse(text);
    if (!res.ok && !json.error) json.error = `Optimizer request failed with HTTP ${res.status}.`;
    return json;
  } catch {
    const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 500);
    return {
      aiExecuted: false,
      optimizationAccepted: false,
      calculationStatus: 'NOT OPTIMIZED',
      error: `Optimizer backend returned a non-JSON response (HTTP ${res.status}). ${cleaned}`
    };
  }
}

export default function OpenAiOptimizerPage() {
  const [routes, setRoutes] = useState([]);
  const [scope, setScope] = useState('all');
  const [routeName, setRouteName] = useState('');
  const [fixed, setFixed] = useState(null);
  const [flexible, setFlexible] = useState(null);
  const [loadingFixed, setLoadingFixed] = useState(false);
  const [loadingFlexible, setLoadingFlexible] = useState(false);

  useEffect(() => { fetch('/api/routes').then(r => r.json()).then(d => setRoutes(d.routes || [])).catch(() => setRoutes([])); }, []);
  const routeNames = useMemo(() => routes.map(r => r.routeName).filter(Boolean).sort(), [routes]);

  async function run(mode) {
    const setLoading = mode === 'fixed' ? setLoadingFixed : setLoadingFlexible;
    const setResult = mode === 'fixed' ? setFixed : setFlexible;
    setLoading(true); setResult(null);
    try {
      const res = await fetch('/api/ai-route-optimizer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, routeName: scope === 'selected' ? routeName : '', mode, objective: 'miles', useActualRoadRoutes: true, tollPreference: 'allow' })
      });
      setResult(await readApiResponse(res));
    } catch (e) {
      setResult({ aiExecuted: false, optimizationAccepted: false, calculationStatus: 'NOT OPTIMIZED', error: e?.message || 'Network request failed.' });
    } finally { setLoading(false); }
  }

  async function runBoth() { await Promise.all([run('fixed'), run('flexible')]); }

  return <main style={styles.page}>
    <div style={styles.header}>
      <div><div style={styles.kicker}>CSL US Plasma Road RFP 2026</div><h1 style={styles.h1}>OpenAI Network Optimizer</h1><p style={styles.lead}>Start from the current McKesson network. Compare an AI rebuild with the current PLC locked against an AI rebuild where Dallas / Whitestown may change.</p></div>
      <a href="/" style={styles.back}>← Network Map</a>
    </div>

    <div style={styles.ruleBox}><b>Hard rule:</b> OpenAI designs route groups and stop sequence. It does not invent mileage or savings. Every eligible center must be assigned exactly once, and the backend validates the proposal before it is accepted.</div>

    <div style={styles.controls}>
      <label style={styles.label}>Scope<select value={scope} onChange={e => setScope(e.target.value)} style={styles.select}><option value="all">All current McKesson routes</option><option value="selected">One current route</option><option value="relay">Relay / PLC-mismatch routes</option></select></label>
      {scope === 'selected' && <label style={styles.label}>Current route<select value={routeName} onChange={e => setRouteName(e.target.value)} style={styles.select}><option value="">Select route…</option>{routeNames.map(r => <option key={r} value={r}>{r}</option>)}</select></label>}
      <button disabled={scope === 'selected' && !routeName} style={styles.primaryButton} onClick={runBoth}>Run Both Modes</button>
      <button disabled={scope === 'selected' && !routeName} style={styles.darkButton} onClick={() => run('fixed')}>Run OpenAI — Keep PLC</button>
      <button disabled={scope === 'selected' && !routeName} style={styles.lightButton} onClick={() => run('flexible')}>Run OpenAI — Allow PLC Change</button>
    </div>

    <div style={styles.compare}><ResultPanel title="AI optimization — without changing PLC" result={fixed} loading={loadingFixed} mode="fixed" /><ResultPanel title="AI optimization — changing PLC allowed" result={flexible} loading={loadingFlexible} mode="flexible" /></div>
  </main>;
}

const styles = {
  page:{fontFamily:'Arial, sans-serif',background:'#f5f7fb',minHeight:'100vh',padding:'28px',color:'#0b1739'},
  header:{display:'flex',justifyContent:'space-between',gap:24,alignItems:'flex-start',maxWidth:1600,margin:'0 auto 18px'},
  kicker:{fontSize:12,fontWeight:800,textTransform:'uppercase',letterSpacing:1,color:'#0b63ce'}, h1:{fontSize:34,margin:'5px 0 8px'}, lead:{margin:0,maxWidth:900,lineHeight:1.5,color:'#44506a'}, back:{textDecoration:'none',color:'#0b63ce',fontWeight:700,whiteSpace:'nowrap'},
  ruleBox:{maxWidth:1600,margin:'0 auto 18px',background:'#eaf7ee',border:'1px solid #b9e4c5',borderRadius:12,padding:'13px 16px',fontSize:13,lineHeight:1.5},
  controls:{maxWidth:1600,margin:'0 auto 20px',display:'flex',gap:10,alignItems:'end',flexWrap:'wrap',background:'#fff',border:'1px solid #dfe5ef',borderRadius:14,padding:14},
  label:{display:'flex',flexDirection:'column',gap:6,fontSize:12,fontWeight:800}, select:{minWidth:230,padding:'10px 12px',border:'1px solid #ccd5e2',borderRadius:9,background:'#fff'},
  primaryButton:{padding:'11px 16px',border:0,borderRadius:9,background:'#0b63ce',color:'#fff',fontWeight:800,cursor:'pointer'}, darkButton:{padding:'11px 16px',border:0,borderRadius:9,background:'#0b1739',color:'#fff',fontWeight:800,cursor:'pointer'}, lightButton:{padding:'10px 16px',border:'1px solid #9eb4cf',borderRadius:9,background:'#fff',color:'#0b1739',fontWeight:800,cursor:'pointer'}, secondaryButton:{marginTop:14,padding:'9px 12px',border:'1px solid #ccd5e2',borderRadius:8,background:'#fff',fontWeight:700,cursor:'pointer'},
  compare:{maxWidth:1600,margin:'0 auto',display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(540px,1fr))',gap:18}, panel:{background:'#fff',border:'1px solid #dfe5ef',borderRadius:14,padding:18,minWidth:0}, panelHead:{display:'flex',justifyContent:'space-between',gap:12,alignItems:'flex-start'}, h2:{margin:'0 0 4px',fontSize:20}, subtle:{fontSize:12,color:'#667085'}, badgeFixed:{fontSize:11,fontWeight:800,padding:'6px 8px',borderRadius:20,background:'#e8eef8'}, badgeFlexible:{fontSize:11,fontWeight:800,padding:'6px 8px',borderRadius:20,background:'#fff2cc'},
  metrics:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:9,marginTop:16}, metric:{background:'#f7f9fc',borderRadius:9,padding:10}, metricLabel:{fontSize:11,color:'#667085',marginBottom:5}, metricValue:{fontSize:18,fontWeight:800}, summary:{marginTop:15,lineHeight:1.45,fontSize:13}, source:{marginTop:10,fontSize:11,color:'#667085',lineHeight:1.4}, routesTitle:{marginTop:17,fontSize:13,fontWeight:800}, routeTableWrap:{overflowX:'auto',marginTop:8,maxHeight:430,overflowY:'auto',border:'1px solid #e5e9f0',borderRadius:8}, table:{width:'100%',borderCollapse:'collapse',fontSize:12}, th:{textAlign:'left',position:'sticky',top:0,background:'#eef3f8',padding:'8px',borderBottom:'1px solid #dfe5ef'}, td:{padding:'8px',borderBottom:'1px solid #eef1f5',verticalAlign:'top'}, empty:{padding:'32px 0',color:'#667085'}, status:{padding:'28px 0',color:'#0b63ce',fontWeight:700}, error:{marginTop:12,padding:12,background:'#fff0f0',border:'1px solid #ffcaca',borderRadius:8,color:'#8a1c1c',lineHeight:1.5}, diagnostics:{marginTop:10,padding:10,background:'#f7f9fc',borderRadius:8,fontSize:12}, warning:{marginTop:10,padding:10,background:'#fff8e1',border:'1px solid #f2df9b',borderRadius:8,fontSize:12,lineHeight:1.4}
};
