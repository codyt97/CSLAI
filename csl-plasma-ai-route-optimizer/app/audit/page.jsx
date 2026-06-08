'use client';

import { useEffect, useMemo, useState } from 'react';

const DATA_FILES = [
  ['centers.json', 'Centers'],
  ['scheduledCenters.json', 'Scheduled centers'],
  ['weekAStops.json', 'Week A stops'],
  ['weekBStops.json', 'Week B stops'],
  ['billingFY26.json', 'Billing rows'],
  ['casesByCenter.json', 'Cases by center']
];

function money(value) {
  return typeof value === 'number' ? value.toLocaleString(undefined, { style: 'currency', currency: 'USD' }) : '—';
}

function number(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function percent(value) {
  return typeof value === 'number' ? `${value.toLocaleString()}%` : '—';
}

function rowStatus(row) {
  if (row.status && row.status !== 'OK') return row.status;
  if ([row.invoiceDisputeDeadlineStatus, row.overchargeUnderchargeDeadlineStatus].includes('Expired Window')) return 'Expired Window';
  if ([row.invoiceDisputeDeadlineStatus, row.overchargeUnderchargeDeadlineStatus].includes('Missing Data')) return 'Missing Data';
  return row.status || 'OK';
}

function Card({ title, children }) {
  return (
    <section style={styles.card}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div style={styles.metric}>
      <div style={styles.label}>{label}</div>
      <div style={styles.value}>{value}</div>
    </div>
  );
}

export default function AuditPage() {
  const [dataSummary, setDataSummary] = useState(null);
  const [invoiceAudit, setInvoiceAudit] = useState(null);
  const [fuelAudit, setFuelAudit] = useState(null);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [rowSearch, setRowSearch] = useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const [dataRes, invoiceRes, fuelRes] = await Promise.all([
          fetch('/api/data-summary'),
          fetch('/api/invoice-audit'),
          fetch('/api/fuel-surcharge-audit?dieselAverage=3.70')
        ]);

        if (!dataRes.ok || !invoiceRes.ok || !fuelRes.ok) throw new Error('One or more audit APIs failed.');

        const [data, invoice, fuel] = await Promise.all([dataRes.json(), invoiceRes.json(), fuelRes.json()]);
        if (active) {
          setDataSummary(data);
          setInvoiceAudit(invoice);
          setFuelAudit(fuel);
        }
      } catch (err) {
        if (active) setError(err.message);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, []);

  const filesByName = useMemo(() => {
    return Object.fromEntries((dataSummary?.files || []).map((file) => [file.fileName, file]));
  }, [dataSummary]);

  const warnings = dataSummary?.dataQuality?.sampleRecords || [];
  const invoiceRowsNeedingReview = useMemo(() => {
    const query = rowSearch.trim().toLowerCase();
    return (invoiceAudit?.rows || [])
      .filter((row) => rowStatus(row) !== 'OK' || !row.routeName || !row.plc || !row.cases || !row.miles || !row.linehaul || !row.fuelSurcharge || !row.totalCost || (row.costPerMile && (row.costPerMile < 1 || row.costPerMile > 20)))
      .filter((row) => statusFilter === 'All' || rowStatus(row) === statusFilter)
      .filter((row) => {
        if (!query) return true;
        return [row.routeName, row.centerName, row.centerNumber, row.plc].some((value) => String(value || '').toLowerCase().includes(query));
      })
      .slice(0, 50);
  }, [invoiceAudit, rowSearch, statusFilter]);

  return (
    <html>
      <body style={styles.body}>
        <main style={styles.main}>
          <header style={styles.header}>
            <div>
              <p style={styles.eyebrow}>CSL Plasma Route Optimizer</p>
              <h1 style={styles.h1}>Audit Dashboard</h1>
            </div>
            <a href="/" style={styles.link}>Back to map</a>
          </header>

          <p style={styles.warning}>
            Current audit uses available runtime data. Route-mile reduction is shown as operational opportunity only and is not confirmed invoice savings unless contract rating or McKesson repricing confirms it.
          </p>

          {error && <p style={styles.error}>{error}</p>}
          {!dataSummary || !invoiceAudit || !fuelAudit ? <p style={styles.loading}>Loading audit APIs…</p> : null}

          {dataSummary && (
            <Card title="Data Source Summary">
              <div style={styles.grid}>
                {DATA_FILES.map(([fileName, label]) => (
                  <Metric key={fileName} label={label} value={number(filesByName[fileName]?.recordCount)} />
                ))}
              </div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr><th style={styles.th}>File</th><th style={styles.th}>Records</th><th style={styles.th}>Source status</th></tr>
                  </thead>
                  <tbody>
                    {(dataSummary.files || []).map((file) => (
                      <tr key={file.fileName}>
                        <td style={styles.td}>{file.fileName}</td>
                        <td style={styles.td}>{number(file.recordCount)}</td>
                        <td style={styles.td}>{file.sourceStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {invoiceAudit && (
            <Card title="Invoice Audit Summary">
              <div style={styles.grid}>
                <Metric label="Total rows" value={number(invoiceAudit.totalRows)} />
                <Metric label="Total linehaul" value={money(invoiceAudit.totalLinehaul)} />
                <Metric label="Total fuel surcharge" value={money(invoiceAudit.totalFuelSurcharge)} />
                <Metric label="Total cost" value={money(invoiceAudit.totalCost)} />
                <Metric label="Average cost per case" value={money(invoiceAudit.averageCostPerCase)} />
                <Metric label="Average cost per mile" value={money(invoiceAudit.averageCostPerMile)} />
                <Metric label="Rows needing review" value={number(invoiceAudit.rowsNeedingReview)} />
                <Metric label="Abnormal cost per mile rows" value={number(invoiceAudit.abnormalCostPerMileRows)} />
              </div>
            </Card>
          )}

          {invoiceAudit && (
            <Card title="Invoice Rows Needing Review">
              <p style={styles.note}>This table highlights rows that need review based on the available runtime data. These are audit flags, not confirmed billing errors.</p>
              {(invoiceAudit.rows || []).length ? (
                <>
                  <div style={styles.filters}>
                    <label style={styles.filterLabel}>
                      Status
                      <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={styles.input}>
                        {['All', 'Review', 'Missing Data', 'Unmapped', 'Expired Window'].map((status) => <option key={status}>{status}</option>)}
                      </select>
                    </label>
                    <label style={styles.filterLabel}>
                      Search
                      <input value={rowSearch} onChange={(event) => setRowSearch(event.target.value)} placeholder="Route, center, center #, or PLC" style={styles.input} />
                    </label>
                  </div>
                  {invoiceRowsNeedingReview.length ? (
                    <div style={styles.tableWrap}>
                      <table style={styles.reviewTable}>
                        <thead>
                          <tr>{['Status', 'Route', 'Center', 'Center #', 'PLC', 'Cases', 'Miles', 'Linehaul', 'Fuel Surcharge', 'Total Cost', 'Cost / Case', 'Cost / Mile', 'Explanation'].map((heading) => <th key={heading} style={styles.th}>{heading}</th>)}</tr>
                        </thead>
                        <tbody>
                          {invoiceRowsNeedingReview.map((row, index) => (
                            <tr key={`${row.routeName || 'route'}-${row.centerNumber || index}`}>
                              <td style={styles.td}>{rowStatus(row)}</td>
                              <td style={styles.td}>{row.routeName || '—'}</td>
                              <td style={styles.td}>{row.centerName || '—'}</td>
                              <td style={styles.td}>{row.centerNumber || '—'}</td>
                              <td style={styles.td}>{row.plc || '—'}</td>
                              <td style={styles.td}>{number(row.cases)}</td>
                              <td style={styles.td}>{number(row.miles)}</td>
                              <td style={styles.td}>{money(row.linehaul)}</td>
                              <td style={styles.td}>{money(row.fuelSurcharge)}</td>
                              <td style={styles.td}>{money(row.totalCost)}</td>
                              <td style={styles.td}>{money(row.costPerCase)}</td>
                              <td style={styles.td}>{money(row.costPerMile)}</td>
                              <td style={styles.td}>{row.explanation || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p>No rows match the current filters.</p>}
                </>
              ) : <p>No row-level audit results available from the current data source.</p>}
            </Card>
          )}

          {fuelAudit && (
            <Card title="Fuel Surcharge Audit Summary">
              <div style={styles.grid}>
                <Metric label="Diesel average" value={money(fuelAudit.dieselAverage)} />
                <Metric label="Expected fuel surcharge" value={percent(fuelAudit.expectedFuelSurchargePercent)} />
                <Metric label="Actual fuel surcharge" value={percent(fuelAudit.actualFuelSurchargePercent)} />
                <Metric label="Variance" value={percent(fuelAudit.variancePercent)} />
                <Metric label="Status" value={fuelAudit.status || '—'} />
                <Metric label="Zero fuel with linehaul rows" value={number(fuelAudit.zeroFuelWithLinehaulRows)} />
                <Metric label="Abnormal fuel percent rows" value={number(fuelAudit.abnormalFuelPercentRows)} />
              </div>
            </Card>
          )}

          {dataSummary && (
            <Card title="Data Quality Warnings">
              {warnings.length ? (
                <ul style={styles.list}>
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning.warning || JSON.stringify(warning)}</li>
                  ))}
                </ul>
              ) : <p>No data quality warnings returned.</p>}
            </Card>
          )}
        </main>
      </body>
    </html>
  );
}

const styles = {
  body: { margin: 0, background: '#f4f7fb', color: '#102033', fontFamily: 'Arial, sans-serif' },
  main: { maxWidth: 1180, margin: '0 auto', padding: 32 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 20 },
  eyebrow: { margin: 0, color: '#58708c', fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' },
  h1: { margin: '6px 0 0', fontSize: 38 },
  h2: { margin: '0 0 18px', fontSize: 22 },
  link: { color: '#0b63ce', fontWeight: 700, textDecoration: 'none' },
  warning: { background: '#fff7df', border: '1px solid #f2d27a', borderRadius: 12, padding: 16, lineHeight: 1.5 },
  error: { background: '#ffecec', border: '1px solid #ffb5b5', borderRadius: 12, padding: 16 },
  loading: { padding: 16 },
  note: { color: '#40566f', lineHeight: 1.5, marginTop: 0 },
  filters: { display: 'flex', flexWrap: 'wrap', gap: 12, margin: '16px 0' },
  filterLabel: { display: 'flex', flexDirection: 'column', gap: 6, color: '#5d7086', fontSize: 13, fontWeight: 700 },
  input: { border: '1px solid #cbd8e6', borderRadius: 8, fontSize: 14, padding: '9px 10px', minWidth: 220 },
  card: { background: 'white', border: '1px solid #dce6f1', borderRadius: 16, padding: 22, marginTop: 20, boxShadow: '0 8px 22px rgba(16, 32, 51, 0.06)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 },
  metric: { background: '#f7faff', border: '1px solid #e2ebf6', borderRadius: 12, padding: 14 },
  label: { color: '#5d7086', fontSize: 13, marginBottom: 6 },
  value: { color: '#102033', fontSize: 22, fontWeight: 800 },
  tableWrap: { overflowX: 'auto', marginTop: 18 },
  table: { borderCollapse: 'collapse', minWidth: 640, width: '100%' },
  reviewTable: { borderCollapse: 'collapse', minWidth: 1500, width: '100%' },
  th: { textAlign: 'left', borderBottom: '1px solid #dce6f1', color: '#5d7086', padding: '10px 8px' },
  td: { borderBottom: '1px solid #eef3f8', padding: '10px 8px' },
  list: { margin: 0, paddingLeft: 22, lineHeight: 1.7 }
};
