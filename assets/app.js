const BUNDLE_URL = 'data/derived/signal_cycle_bundle.json';
const POLL_MS = 10 * 60 * 1000;
let bundle = null;
let chart = null;
let activeTab = 'coupling';
let chartMaximized = false;
let lastStamp = '';
let betaPlay = { assumedBeta: 0.35, floorPenalty: 0.20 };
let betaCollapsed = localStorage.getItem('s2_beta_collapsed') !== '0';
let theater = { ready:false, playing:false, t:0, batchIndex:'auto', topic:'all', dustVisible:0.35, speed:1.0, points:[], raf:null, last:0, canvas:null, ctx:null, tooltip:null, hover:null };

const $ = id => document.getElementById(id);
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNum = (v, d=2) => num(v) == null ? '—' : Number(v).toFixed(d);
const fmtMoney = (v, d=2) => num(v) == null ? '—' : `$${Number(v).toFixed(d)}`;
const fmtPct = (v, d=2) => num(v) == null ? '—' : `${(Number(v)*100).toFixed(d)}%`;
const fmtSignedPct = (v, d=2) => num(v) == null ? '—' : `${Number(v) >= 0 ? '+' : ''}${(Number(v)*100).toFixed(d)}%`;
const fmtMetricPct = (v, d=2) => {
  const x = num(v);
  if (x == null) return '—';
  if (Math.abs(x) > 10) return 'outlier';
  return `${(x*100).toFixed(d)}%`;
};
const fmtHours = v => {
  const h = num(v);
  if (h == null) return '—';
  if (h >= 48) return `${(h/24).toFixed(1)}d`;
  if (h < 1) return `${(h*60).toFixed(0)}m`;
  return `${h.toFixed(h < 10 ? 1 : 0)}h`;
};
function clsDelta(v) { const x = num(v); return x == null ? '' : x > 0 ? 'good' : x < 0 ? 'bad' : ''; }
function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function betaFloorShare(row) { return num(row.topic_beta_035_share ?? row.beta_035_share ?? row.legacy_beta_floor_share ?? row.topic_beta_floor_share ?? row.beta_floor_share) ?? 0; }
function betaBasePressure(row) { return num(row.retained_pressure_score) ?? 0; }
function betaAdjustmentFactor(row) {
  const floor = betaFloorShare(row);
  const assumed = num(betaPlay.assumedBeta) ?? 0.35;
  const penalty = num(betaPlay.floorPenalty) ?? 0.20;
  const legacy = num((bundle?.summary || {}).legacy_beta_floor_watch ?? (bundle?.summary || {}).beta_floor_watch) ?? 0.35;
  const floorExcess = clip((floor - 0.75) / 0.25, 0, 1);
  const uncertaintyPenalty = 1 - penalty * floorExcess;
  let betaTilt = 1;
  if (assumed < legacy) betaTilt += (legacy - assumed) * floor * 1.15;
  if (assumed > legacy) betaTilt -= (assumed - legacy) * floor * 0.65;
  return clip(betaTilt * uncertaintyPenalty, 0.25, 1.75);
}
function betaAdjustedPressure(row) { return betaBasePressure(row) * betaAdjustmentFactor(row); }
function betaAdjustedCouplingScore(row) {
  const basePressure = betaBasePressure(row);
  const baseScore = num(row.coupling_score) ?? 0;
  if (!basePressure) return baseScore;
  return baseScore * (betaAdjustedPressure(row) / basePressure);
}
function adjustedCouplingRows() {
  return (bundle?.coupling_rows || []).map(r => ({...r, beta_adjusted_pressure: betaAdjustedPressure(r), beta_adjusted_coupling_score: betaAdjustedCouplingScore(r)}));
}
function pill(text, cls='ok') { return `<span class="pill ${cls}">${esc(text)}</span>`; }
function sourceLabel(v) { return v === 'live_scorecard' ? 'live prior scorecard' : v === 'backtest_model_comparison' ? 'backtest fallback' : 'none'; }
function horizonSort(rows){ return [...(rows||[])].sort((a,b)=>{ const ha=String(a.horizon||'').replace('h',''); const hb=String(b.horizon||'').replace('h',''); return (Number(ha)||999)-(Number(hb)||999); }); }

async function loadBundle(manual=false) {
  try {
    const res = await fetch(`${BUNDLE_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !json.generated_at) throw new Error('bundle missing generated_at');
    if (json.generated_at !== lastStamp || manual) {
      bundle = json;
      lastStamp = json.generated_at;
      render();
    }
    $('pollState').textContent = manual ? 'refreshed' : '10m';
  } catch (err) {
    $('notice').innerHTML = `No generated bundle loaded. Run the GitHub Action. Error: <code>${esc(err.message)}</code>`;
    $('pollState').textContent = 'waiting';
    if (!bundle) renderEmpty();
  }
}

function renderEmpty() {
  $('generatedAt').textContent = 'waiting';
  $('kpis').innerHTML = ['Cycle rows','Score rows','Backtest rows','Live rows','β audit','Coupling'].map(k => `<div class="kpi"><span>${k}</span><b>0</b><small>waiting for generated bundle</small></div>`).join('');
  $('signalRead').innerHTML = '<div class="empty">No generated artifacts loaded. This app never shows dummy signals.</div>';
  $('topicTable').innerHTML = '<div class="empty">No cycle JSON parsed.</div>';
  $('horizonTable').innerHTML = '<div class="empty">No scored market artifacts parsed.</div>';
  $('backtestTable').innerHTML = '<div class="empty">No model comparison parsed.</div>';
  $('couplingTable').innerHTML = '<div class="empty">No coupling rows emitted.</div>';
  $('liveTable').innerHTML = '<div class="empty">No live prediction state loaded.</div>';
  $('sourceHealth').innerHTML = '<div class="empty">Source health will appear after the workflow runs.</div>';
  if ($('pnlAuditTable')) $('pnlAuditTable').innerHTML = '<div class="empty">No matured PnL audit loaded.</div>';
  if ($('betaAdjustedTable')) $('betaAdjustedTable').innerHTML = '<div class="empty">No β-adjusted coupling rows.</div>';
  if ($('paperBoard')) $('paperBoard').innerHTML = '<div class="empty">No paper trading ledger loaded yet.</div>';
  if ($('betaPlayRead')) $('betaPlayRead').innerHTML = 'No bundle loaded yet.';
  renderChart();
}

function render() {
  if (!bundle) return renderEmpty();
  const s = bundle.summary || {};
  $('generatedAt').textContent = bundle.generated_at || '—';
  $('mode').textContent = sourceLabel(s.score_source);
  $('notice').innerHTML = `${esc(bundle.source_policy || 'Strict source mode')}`;
  $('horizonSource').textContent = sourceLabel(s.score_source);
  const rawScoreRows = (bundle.source_health || []).find(r => r.kind === 'prediction_scorecard')?.raw_rows;
  $('kpis').innerHTML = `
    <div class="kpi"><span>Current cycle rows</span><b>${s.current_wave_cycle_rows ?? s.cycle_rows ?? 0}</b><small>${s.topics ?? 0} topics · ${s.archive_cycle_rows ?? 0} archive rows available</small></div>
    <div class="kpi"><span>Score aggregates</span><b>${s.score_rows ?? 0}</b><small>${rawScoreRows ? `${rawScoreRows} raw scored rows` : sourceLabel(s.score_source)}</small></div>
    <div class="kpi"><span>Backtest rows</span><b>${s.backtest_rows ?? 0}</b><small>${s.backtest_horizons ?? 0} horizons</small></div>
    <div class="kpi"><span>Live state rows</span><b>${s.live_prediction_rows ?? 0}</b><small>searchable, display-only</small></div>
    <div class="kpi"><span>β audit</span><b>${fmtNum(s.beta_mode,2)}</b><small>${fmtPct(s.beta_below_035_share,1)} below 0.35 · ${fmtPct(s.new_grid_floor_share,1)} at new floor</small></div>
    <div class="kpi"><span>Coupling rows</span><b>${s.coupling_rows ?? 0}</b><small>${s.candidate_coupling_rows ?? 0} confirmed candidates · ${s.pnl_audit_rows ?? 0} PnL audits</small></div>`;
  renderRead(); renderBetaPlay(); renderTopics(); renderHorizons(); renderBacktest(); renderPnlAudit(); renderCoupling(); renderBetaAdjusted(); renderPaperBoard(); renderLive(); renderHealth(); renderChart();
}

function renderRead() {
  const s = bundle.summary || {};
  const horizons = bundle.market_horizons || [];
  const coupling = bundle.coupling_rows || [];
  const candidates = coupling.filter(r => r.status === 'candidate coupling');
  const mixed = coupling.filter(r => r.status === 'mixed coupling');
  const best = candidates[0] || mixed[0] || coupling[0];
  const h1 = horizons.find(h => h.horizon === 'h1');
  const primary = horizons.filter(h => h.horizon !== 'h1');
  const betaWarn = Number(s.new_grid_floor_share) >= .75;
  const legacyCluster = Number(s.beta_035_share ?? s.legacy_beta_floor_share) >= .75;
  const dustWarn = Number(s.dust_nonzero_share) < .25;
  const rawScoreRows = (bundle.source_health || []).find(r => r.kind === 'prediction_scorecard')?.raw_rows;
  let html = '';
  html += `<div class="read-card"><b>Plain-English verdict</b><span><strong>${esc(s.verdict || 'No verdict emitted')}</strong>. This is an academic coupling surface. It asks whether a retained public-information cycle appears before or alongside a matured market-score horizon. It does not convert live prediction rows into performance, and it does not emit trade instructions.</span></div>`;
  html += `<div class="read-card"><b>Source status</b><span>${s.current_wave_cycle_rows || s.cycle_rows || 0} current-wave cycle rows and ${rawScoreRows || 0} raw scored market rows are loaded. The large market scorecard is compressed into ${s.score_rows || 0} model/horizon aggregates; a small aggregate count is expected because it usually means baseline_h1, s2_h1, baseline_h5, and s2_h5.</span></div>`;
  html += `<div class="read-card"><b>How to read the graph</b><span>Each tab answers one bounded question: cycle pressure, horizon lift, β audit, backtest, or coupling. Use <strong>Max graph</strong> when axis labels or long topic names need room; press Esc or Collapse graph to return.</span></div>`;
  if (h1) html += `<div class="read-card"><b>h1 is a dust diagnostic</b><span>h1 is shown to prove what not to trust. Current h1: Δ hit ${fmtSignedPct(h1.delta_hit)} · Δ PnL ${fmtSignedPct(h1.delta_pnl)} · rows ${h1.realized_rows ?? '—'}. It never drives advanced signals.</span></div>`;
  if (primary.length) {
    const bestH = [...primary].sort((a,b)=>((b.delta_pnl ?? -9)+(b.delta_hit ?? -9))-((a.delta_pnl ?? -9)+(a.delta_hit ?? -9)))[0];
    const liftIsMixed = Number(bestH.delta_hit) > 0 && Number(bestH.delta_pnl) <= 0;
    html += `<div class="read-card"><b>Primary horizon read</b><span>Best non-h1 loaded horizon is <strong>${esc(bestH.horizon)}</strong>: Δ hit ${fmtSignedPct(bestH.delta_hit)} · Δ PnL ${fmtSignedPct(bestH.delta_pnl)} · rows ${bestH.realized_rows ?? '—'}. ${liftIsMixed ? 'Hit rate improves but PnL does not, so the app keeps the coupling as mixed.' : 'A confirmed signal needs both hit and PnL to improve.'}</span></div>`;
  } else {
    html += `<div class="read-card"><b>Primary horizon read</b><span>No non-h1 scored market horizon is available yet. Coupling cannot be confirmed without matured h5/h10/h20 rows.</span></div>`;
  }
  if (best) html += `<div class="read-card"><b>Top coupling row</b><span>${esc(best.topic)} / ${esc(best.horizon)} · <strong>${esc(best.status)}</strong> · pressure ${fmtNum(best.retained_pressure_score,1)} · β ${fmtNum(best.topic_beta_mode,2)} · dust ${fmtNum(best.topic_dust_median,3)}. This ranks research alignment, not a trade instruction.</span></div>`;
  const pnlRows = bundle.pnl_audit || [];
  const bestPnl = pnlRows.find(r => r.horizon !== 'h1') || pnlRows[0];
  if (bestPnl) html += `<div class="read-card"><b>Postfactum PnL audit</b><span>The app checks matured predictions after the fact with a paper-PnL proxy. For ${esc(bestPnl.horizon)}: Δ hit ${fmtSignedPct(bestPnl.delta_hit)} · Δ PnL ${fmtSignedPct(bestPnl.delta_pnl)} · Δ cumulative proxy ${fmtSignedPct(bestPnl.delta_cumulative_pnl)}. This is still not executable portfolio PnL because it excludes slippage, spread, borrow, and sizing.</span></div>`;
  html += `<div class="read-card"><b>β playground</b><span>Use the sliders to ask: if the true news-cycle shape were lower or higher than the published floor, how would topic pressure and coupling rankings move? This is a client-side what-if weighting, not a refit and not proof of exact β.</span></div>`;
  html += `<div class="read-card"><b>Table guidance</b><span>Large tables are lazy-rendered. Search scans all loaded rows, not only the visible page, so ticker lookup is no longer limited to the first alphabetic page.</span></div>`;
  html += `<div class="read-card"><b>Beta audit</b><span class="${betaWarn ? 'warn':'good'}">${betaWarn ? `Current wave is hitting the new lower β grid floor (${fmtNum(s.expanded_beta_min,2)}), so the attractor is still unresolved.` : legacyCluster ? `Current wave still clusters around legacy 0.35 even though lower β values are allowed; 0.35 is a candidate attractor.` : `Current wave is no longer dominated by legacy 0.35. β is resolving below/around the old floor; read β mode directly.`}</span><span class="mini-line">Archive rows may still contain legacy-grid fits. Coupling and topic tables now use the current active wave when it is available.</span></div>`;
  html += `<div class="read-card"><b>Dust audit</b><span class="${dustWarn ? 'warn':'good'}">${dustWarn ? 'Many parsed dust values are zero/missing. Treat dust-specific conclusions cautiously.' : 'Dust values are present enough to interpret topic pressure.'}</span></div>`;
  $('signalRead').innerHTML = html || '<div class="empty">No reads available.</div>';
}

const gridState = {};
const gridCache = {};
const gridDefaults = { pageSize: 25, pageSizes: [20,25,50,100,250] };

function table(headers, rows) {
  if (!rows.length) return '<div class="empty">No rows.</div>';
  return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function stripHtml(v) {
  const div = document.createElement('div');
  div.innerHTML = String(v ?? '');
  return div.textContent || div.innerText || '';
}
function gridText(row, col) {
  if (col.searchText) return String(col.searchText(row) ?? '').toLowerCase();
  if (col.value) return String(col.value(row) ?? '').toLowerCase();
  return stripHtml(col.render(row)).toLowerCase();
}
function gridSortValue(row, col) {
  if (col.sortValue) return col.sortValue(row);
  if (col.value) return col.value(row);
  return stripHtml(col.render(row));
}
function ensureGridState(gridId, opts={}) {
  if (!gridState[gridId]) gridState[gridId] = { search:'', page:1, pageSize: opts.pageSize || gridDefaults.pageSize, sortKey: opts.defaultSort || '', sortDir: opts.defaultDir || 'asc' };
  return gridState[gridId];
}
function renderDataGrid(containerId, gridId, rows, columns, opts={}) {
  gridCache[gridId] = { containerId, rows: rows || [], columns, opts };
  renderDataGridCached(gridId);
}
function renderDataGridCached(gridId) {
  const cached = gridCache[gridId];
  if (!cached) return;
  const { containerId, rows, columns, opts } = cached;
  const st = ensureGridState(gridId, opts);
  const pageSizes = opts.pageSizes || gridDefaults.pageSizes;
  const q = String(st.search || '').trim().toLowerCase();
  let filtered = q ? rows.filter(row => columns.some(col => gridText(row, col).includes(q))) : [...rows];
  if (st.sortKey) {
    const col = columns.find(c => c.key === st.sortKey);
    if (col) {
      filtered.sort((a,b) => {
        let va = gridSortValue(a, col), vb = gridSortValue(b, col);
        const na = Number(va), nb = Number(vb);
        if (Number.isFinite(na) && Number.isFinite(nb)) return st.sortDir === 'asc' ? na - nb : nb - na;
        va = String(va ?? '').toLowerCase(); vb = String(vb ?? '').toLowerCase();
        return st.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
  }
  const total = filtered.length;
  const pageSize = Number(st.pageSize) || 25;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  st.page = Math.min(Math.max(1, Number(st.page)||1), pages);
  const start = (st.page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);
  const showingStart = total ? start + 1 : 0;
  const showingEnd = Math.min(start + pageSize, total);
  const note = opts.note ? `<div class="grid-note">${opts.note}</div>` : '';
  const tableHtml = pageRows.length ? `<table><thead><tr>${columns.map(c=>`<th class="${c.cls || ''}" onclick="gridSort('${gridId}','${c.key}')">${esc(c.label)}${st.sortKey===c.key ? (st.sortDir==='asc'?' ▲':' ▼') : ''}</th>`).join('')}</tr></thead><tbody>${pageRows.map(row=>`<tr>${columns.map(c=>`<td class="${c.cls || ''}">${c.render(row)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty">No matching rows.</div>';
  $(containerId).innerHTML = `
    <div class="data-grid">
      ${note}
      <div class="grid-tools">
        <input class="grid-search" type="search" placeholder="Search loaded rows..." value="${esc(st.search)}" oninput="gridSearch('${gridId}', this.value)" />
        <select class="grid-size" onchange="gridPageSize('${gridId}', this.value)">${pageSizes.map(sz=>`<option value="${sz}" ${Number(st.pageSize)===sz?'selected':''}>${sz}/page</option>`).join('')}</select>
        <span class="grid-count">showing ${showingStart}-${showingEnd} of ${total} filtered · ${rows.length} loaded</span>
      </div>
      <div class="grid-table">${tableHtml}</div>
      <div class="grid-pager">
        <button onclick="gridPage('${gridId}', 1)" ${st.page<=1?'disabled':''}>first</button>
        <button onclick="gridPage('${gridId}', ${st.page-1})" ${st.page<=1?'disabled':''}>prev</button>
        <span>page ${st.page} / ${pages}</span>
        <button onclick="gridPage('${gridId}', ${st.page+1})" ${st.page>=pages?'disabled':''}>next</button>
        <button onclick="gridPage('${gridId}', ${pages})" ${st.page>=pages?'disabled':''}>last</button>
      </div>
    </div>`;
}
function gridSearch(gridId, value) { const st = ensureGridState(gridId); st.search = value; st.page = 1; renderDataGridCached(gridId); }
function gridPageSize(gridId, value) { const st = ensureGridState(gridId); st.pageSize = Number(value) || 25; st.page = 1; renderDataGridCached(gridId); }
function gridPage(gridId, page) { const st = ensureGridState(gridId); st.page = Number(page) || 1; renderDataGridCached(gridId); }
function gridSort(gridId, key) { const st = ensureGridState(gridId); if (st.sortKey === key) st.sortDir = st.sortDir === 'asc' ? 'desc' : 'asc'; else { st.sortKey = key; st.sortDir = 'asc'; } st.page = 1; renderDataGridCached(gridId); }
window.gridSearch = gridSearch; window.gridPageSize = gridPageSize; window.gridPage = gridPage; window.gridSort = gridSort;


function renderBetaPlay() {
  const read = $('betaPlayRead');
  if (!read) return;
  const rows = bundle?.topic_summaries || [];
  const legacy = num((bundle?.summary || {}).legacy_beta_floor_watch ?? (bundle?.summary || {}).beta_floor_watch) ?? 0.35;
  const floorShare = num((bundle?.summary || {}).legacy_beta_floor_share ?? (bundle?.summary || {}).beta_floor_share);
  const strongest = rows.length ? [...rows].sort((a,b)=>betaAdjustedPressure(b)-betaAdjustedPressure(a))[0] : null;
  const betaEl = $('betaAssumedValue'); if (betaEl) betaEl.textContent = fmtNum(betaPlay.assumedBeta,2);
  const penEl = $('betaPenaltyValue'); if (penEl) penEl.textContent = fmtPct(betaPlay.floorPenalty,0);
  const direction = betaPlay.assumedBeta < legacy ? 'lower than legacy 0.35; slow-tail topics get a cautious what-if lift' : betaPlay.assumedBeta > legacy ? 'higher than legacy 0.35; legacy-clustered topics are discounted' : 'equal to legacy 0.35; only uncertainty penalty applies';
  const message = `<strong>Assumed β ${fmtNum(betaPlay.assumedBeta,2)}</strong> is ${direction}. Legacy β=0.35 share is ${fmtPct(floorShare,1)}. ${strongest ? `Top β-adjusted clock: <strong>${esc(strongest.topic)}</strong> at ${fmtNum(betaAdjustedPressure(strongest),1)} adjusted pressure.` : 'No topic rows loaded.'} <span class="mini-line">Only the Cycle, Coupling, and Beta playground views are β-sensitive. Horizon, PnL audit, and Backtest are realized market-score views, so they should not move when β changes.</span>`;
  read.innerHTML = message;
  const mini = $('betaMiniRead');
  if (mini) mini.textContent = `β ${fmtNum(betaPlay.assumedBeta,2)} · penalty ${fmtPct(betaPlay.floorPenalty,0)} · floor ${fmtPct(floorShare,0)}${strongest ? ` · top ${strongest.topic}` : ''}`;
  const toggle = $('betaToggleBtn');
  if (toggle) toggle.textContent = betaCollapsed ? 'Expand β' : 'Collapse β';
}

function renderPnlAudit() {
  const data = bundle.pnl_audit || [];
  renderDataGrid('pnlAuditTable', 'pnlAuditGrid', data, [
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'realized_rows', label:'rows', cls:'num', render:r=>r.realized_rows ?? '—', value:r=>r.realized_rows},
    {key:'delta_hit', label:'Δ hit', cls:'num', render:r=>`<span class="${clsDelta(r.delta_hit)}">${fmtSignedPct(r.delta_hit)}</span>`, value:r=>r.delta_hit},
    {key:'delta_pnl', label:'Δ PnL', cls:'num', render:r=>`<span class="${clsDelta(r.delta_pnl)}">${fmtSignedPct(r.delta_pnl)}</span>`, value:r=>r.delta_pnl},
    {key:'baseline_avg_win', label:'base avg win', cls:'num', render:r=>fmtPct(r.baseline_avg_win), value:r=>r.baseline_avg_win},
    {key:'s2_avg_win', label:'s2 avg win', cls:'num', render:r=>fmtPct(r.s2_avg_win), value:r=>r.s2_avg_win},
    {key:'baseline_avg_loss', label:'base avg loss', cls:'num', render:r=>fmtPct(r.baseline_avg_loss), value:r=>r.baseline_avg_loss},
    {key:'s2_avg_loss', label:'s2 avg loss', cls:'num', render:r=>fmtPct(r.s2_avg_loss), value:r=>r.s2_avg_loss},
    {key:'baseline_win_loss_ratio', label:'base W/L', cls:'num', render:r=>fmtNum(r.baseline_win_loss_ratio,2), value:r=>r.baseline_win_loss_ratio},
    {key:'s2_win_loss_ratio', label:'s2 W/L', cls:'num', render:r=>fmtNum(r.s2_win_loss_ratio,2), value:r=>r.s2_win_loss_ratio},
    {key:'delta_cumulative_pnl', label:'Δ cum proxy', cls:'num', render:r=>`<span class="${clsDelta(r.delta_cumulative_pnl)}">${fmtSignedPct(r.delta_cumulative_pnl)}</span>`, value:r=>r.delta_cumulative_pnl},
    {key:'verdict', label:'verdict', render:r=>pill(r.verdict || '—', /positive/.test(r.verdict||'') ? 'ok' : /without/.test(r.verdict||'') ? 'warn' : 'bad'), value:r=>r.verdict},
  ], { pageSize: 25, note: 'Postfactum paper-PnL proxy from matured predictions. It checks payoff symmetry after the prediction horizon closes; it is not a real portfolio simulation.' });
}

function renderBetaAdjusted() {
  const data = adjustedCouplingRows().filter(r => r.status !== 'dust diagnostic').sort((a,b)=>(b.beta_adjusted_coupling_score??-999)-(a.beta_adjusted_coupling_score??-999));
  renderDataGrid('betaAdjustedTable', 'betaAdjustedGrid', data, [
    {key:'topic', label:'topic', render:r=>esc(r.topic), value:r=>r.topic},
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'retained_pressure_score', label:'published pressure', cls:'num', render:r=>fmtNum(r.retained_pressure_score,1), value:r=>r.retained_pressure_score},
    {key:'beta_adjusted_pressure', label:'β-adjusted pressure', cls:'num', render:r=>fmtNum(r.beta_adjusted_pressure,1), value:r=>r.beta_adjusted_pressure},
    {key:'topic_beta_035_share', label:'β=0.35', cls:'num', render:r=>fmtPct(r.topic_beta_035_share ?? r.topic_beta_floor_share,0), value:r=>r.topic_beta_035_share ?? r.topic_beta_floor_share},
    {key:'topic_new_grid_floor_share', label:'new floor', cls:'num', render:r=>fmtPct(r.topic_new_grid_floor_share,0), value:r=>r.topic_new_grid_floor_share},
    {key:'delta_hit', label:'Δ hit', cls:'num', render:r=>`<span class="${clsDelta(r.delta_hit)}">${fmtSignedPct(r.delta_hit)}</span>`, value:r=>r.delta_hit},
    {key:'delta_pnl', label:'Δ PnL', cls:'num', render:r=>`<span class="${clsDelta(r.delta_pnl)}">${fmtSignedPct(r.delta_pnl)}</span>`, value:r=>r.delta_pnl},
    {key:'beta_adjusted_coupling_score', label:'β-adjusted score', cls:'num', render:r=>fmtNum(r.beta_adjusted_coupling_score,2), value:r=>r.beta_adjusted_coupling_score},
    {key:'status', label:'status', render:r=>pill(r.status || '—', r.status === 'candidate coupling' ? 'ok' : r.status === 'mixed coupling' ? 'warn' : 'bad'), value:r=>r.status},
  ], { pageSize: 25, defaultSort:'beta_adjusted_coupling_score', defaultDir:'desc', note: 'What-if ranking. Sliders only reweight published rows in the browser; they do not refit the upstream cycle model.' });
}

function renderTopics() {
  const data = bundle.topic_summaries || [];
  renderDataGrid('topicTable', 'topicsGrid', data, [
    {key:'topic', label:'topic', render:r=>esc(r.topic), value:r=>r.topic},
    {key:'cycle_rows', label:'rows', cls:'num', render:r=>r.cycle_rows ?? '—', value:r=>r.cycle_rows},
    {key:'retained_pressure_score', label:'pressure', cls:'num', render:r=>fmtNum(r.retained_pressure_score,1), value:r=>r.retained_pressure_score},
    {key:'lambda_median_hours', label:'λq', cls:'num', render:r=>fmtHours(r.lambda_median_hours), value:r=>r.lambda_median_hours},
    {key:'beta_mode', label:'β mode', cls:'num', render:r=>fmtNum(r.beta_mode,2), value:r=>r.beta_mode},
    {key:'beta_035_share', label:'β=0.35', cls:'num', render:r=>fmtPct(r.beta_035_share ?? r.legacy_beta_floor_share ?? r.beta_floor_share,0), value:r=>r.beta_035_share ?? r.legacy_beta_floor_share ?? r.beta_floor_share},
    {key:'new_grid_floor_share', label:'new floor', cls:'num', render:r=>fmtPct(r.new_grid_floor_share ?? r.expanded_beta_min_share,0), value:r=>r.new_grid_floor_share ?? r.expanded_beta_min_share},
    {key:'dust_median', label:'dust', cls:'num', render:r=>fmtNum(r.dust_median,3), value:r=>r.dust_median},
    {key:'dust_audit', label:'dust audit', render:r=>pill(r.dust_audit || '—', r.dust_audit === 'ok' ? 'ok' : 'warn'), value:r=>r.dust_audit},
    {key:'delta_aic_median', label:'ΔAIC', cls:'num', render:r=>fmtNum(r.delta_aic_median,2), value:r=>r.delta_aic_median},
    {key:'beta_verdict', label:'β audit', render:r=>pill(r.beta_verdict || '—', ['new-grid-floor','0.35-cluster'].includes(r.beta_verdict) ? 'warn' : 'ok'), value:r=>r.beta_verdict},
  ], { pageSize: 25, note: 'Cycle summaries use the current active wave when available; archive rows are kept separately for context. Search/filter does not change calculations.' });
}

function horizonRows(rows) {
  return rows.map(r => `<tr>
    <td>${esc(r.horizon)}</td><td>${esc(r.score_source || '')}</td><td>${esc(r.best_model || '—')}</td><td class="num">${r.realized_rows ?? '—'}</td>
    <td class="num">${fmtPct(r.baseline_hit)}</td><td class="num">${fmtPct(r.s2_hit)}</td><td class="num ${clsDelta(r.delta_hit)}">${fmtSignedPct(r.delta_hit)}</td>
    <td class="num">${fmtPct(r.baseline_pnl)}</td><td class="num">${fmtPct(r.s2_pnl)}</td><td class="num ${clsDelta(r.delta_pnl)}">${fmtSignedPct(r.delta_pnl)}</td>
    <td class="num">${fmtMetricPct(r.best_mae)}</td>
  </tr>`);
}
function renderHorizons() {
  const rows = bundle.market_horizons || [];
  const fallback = (!rows.length && (bundle.backtest_horizons || []).length) ? bundle.backtest_horizons : [];
  const data = rows.length ? rows : fallback;
  const note = rows.length
    ? 'Live prior scorecard aggregates only. h1 is displayed as a dust diagnostic; non-h1 rows drive research coupling.'
    : fallback.length
      ? 'No live scored horizon artifact recognized. Showing real backtest/model-comparison rows only.'
      : 'No scored horizon rows recognized. Source Health will show whether files loaded but schema was not recognized.';
  renderDataGrid('horizonTable', 'horizonGrid', data, [
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'score_source', label:'source', render:r=>esc(r.score_source || ''), value:r=>r.score_source},
    {key:'best_model', label:'best', render:r=>esc(r.best_model || '—'), value:r=>r.best_model},
    {key:'realized_rows', label:'rows', cls:'num', render:r=>r.realized_rows ?? '—', value:r=>r.realized_rows},
    {key:'baseline_hit', label:'base hit', cls:'num', render:r=>fmtPct(r.baseline_hit), value:r=>r.baseline_hit},
    {key:'s2_hit', label:'s2 hit', cls:'num', render:r=>fmtPct(r.s2_hit), value:r=>r.s2_hit},
    {key:'delta_hit', label:'Δ hit', cls:'num', render:r=>`<span class="${clsDelta(r.delta_hit)}">${fmtSignedPct(r.delta_hit)}</span>`, value:r=>r.delta_hit},
    {key:'baseline_pnl', label:'base PnL', cls:'num', render:r=>fmtPct(r.baseline_pnl), value:r=>r.baseline_pnl},
    {key:'s2_pnl', label:'s2 PnL', cls:'num', render:r=>fmtPct(r.s2_pnl), value:r=>r.s2_pnl},
    {key:'delta_pnl', label:'Δ PnL', cls:'num', render:r=>`<span class="${clsDelta(r.delta_pnl)}">${fmtSignedPct(r.delta_pnl)}</span>`, value:r=>r.delta_pnl},
    {key:'best_mae', label:'MAE', cls:'num', render:r=>fmtMetricPct(r.best_mae), value:r=>r.best_mae},
  ], { pageSize: 25, note });
}
function renderBacktest() {
  const data = bundle.backtest_horizons || [];
  renderDataGrid('backtestTable', 'backtestGrid', data, [
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'score_source', label:'source', render:r=>esc(r.score_source || ''), value:r=>r.score_source},
    {key:'best_model', label:'best', render:r=>esc(r.best_model || '—'), value:r=>r.best_model},
    {key:'realized_rows', label:'rows', cls:'num', render:r=>r.realized_rows ?? '—', value:r=>r.realized_rows},
    {key:'baseline_hit', label:'base hit', cls:'num', render:r=>fmtPct(r.baseline_hit), value:r=>r.baseline_hit},
    {key:'s2_hit', label:'s2 hit', cls:'num', render:r=>fmtPct(r.s2_hit), value:r=>r.s2_hit},
    {key:'delta_hit', label:'Δ hit', cls:'num', render:r=>`<span class="${clsDelta(r.delta_hit)}">${fmtSignedPct(r.delta_hit)}</span>`, value:r=>r.delta_hit},
    {key:'baseline_pnl', label:'base PnL', cls:'num', render:r=>fmtPct(r.baseline_pnl), value:r=>r.baseline_pnl},
    {key:'s2_pnl', label:'s2 PnL', cls:'num', render:r=>fmtPct(r.s2_pnl), value:r=>r.s2_pnl},
    {key:'delta_pnl', label:'Δ PnL', cls:'num', render:r=>`<span class="${clsDelta(r.delta_pnl)}">${fmtSignedPct(r.delta_pnl)}</span>`, value:r=>r.delta_pnl},
    {key:'best_mae', label:'MAE', cls:'num', render:r=>fmtMetricPct(r.best_mae), value:r=>r.best_mae},
  ], { pageSize: 25, note: 'Backtest reference is shown only when model_comparison.json yields recognized aggregate rows.' });
}

function renderCoupling() {
  const data = bundle.coupling_rows || [];
  renderDataGrid('couplingTable', 'couplingGrid', data, [
    {key:'topic', label:'topic', render:r=>esc(r.topic), value:r=>r.topic},
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'retained_pressure_score', label:'pressure', cls:'num', render:r=>fmtNum(r.retained_pressure_score,1), value:r=>r.retained_pressure_score},
    {key:'topic_lambda_hours', label:'λq', cls:'num', render:r=>fmtHours(r.topic_lambda_hours), value:r=>r.topic_lambda_hours},
    {key:'topic_beta_mode', label:'β', cls:'num', render:r=>fmtNum(r.topic_beta_mode,2), value:r=>r.topic_beta_mode},
    {key:'topic_beta_035_share', label:'β=0.35', cls:'num', render:r=>fmtPct(r.topic_beta_035_share ?? r.topic_beta_floor_share,0), value:r=>r.topic_beta_035_share ?? r.topic_beta_floor_share},
    {key:'topic_new_grid_floor_share', label:'new floor', cls:'num', render:r=>fmtPct(r.topic_new_grid_floor_share,0), value:r=>r.topic_new_grid_floor_share},
    {key:'topic_dust_median', label:'dust', cls:'num', render:r=>fmtNum(r.topic_dust_median,3), value:r=>r.topic_dust_median},
    {key:'topic_dust_audit', label:'dust audit', render:r=>pill(r.topic_dust_audit || '—', r.topic_dust_audit === 'ok' ? 'ok' : 'warn'), value:r=>r.topic_dust_audit},
    {key:'topic_delta_aic_median', label:'ΔAIC', cls:'num', render:r=>fmtNum(r.topic_delta_aic_median,2), value:r=>r.topic_delta_aic_median},
    {key:'delta_hit', label:'Δ hit', cls:'num', render:r=>`<span class="${clsDelta(r.delta_hit)}">${fmtSignedPct(r.delta_hit)}</span>`, value:r=>r.delta_hit},
    {key:'delta_pnl', label:'Δ PnL', cls:'num', render:r=>`<span class="${clsDelta(r.delta_pnl)}">${fmtSignedPct(r.delta_pnl)}</span>`, value:r=>r.delta_pnl},
    {key:'coupling_score', label:'score', cls:'num', render:r=>`<span class="${clsDelta(r.coupling_score)}">${fmtNum(r.coupling_score,2)}</span>`, value:r=>r.coupling_score},
    {key:'status', label:'status', render:r=>pill(r.status, r.status === 'candidate coupling' ? 'ok' : r.status === 'mixed coupling' ? 'warn' : r.status === 'dust diagnostic' ? 'warn' : 'bad'), value:r=>r.status},
  ], { pageSize: 25, defaultSort:'coupling_score', defaultDir:'desc', note: 'Coupling rows are topic × scored horizon. They are research reads only unless both hit and PnL gates confirm lift.' });
}

function renderPaperBoard() {
  const paper = bundle.paper_trading || null;
  const el = $('paperBoard');
  if (!el) return;
  if (!paper) {
    el.innerHTML = '<div class="empty">No paper trading board artifact yet. The workflow will create one after the bundle build.</div>';
    return;
  }
  const account = paper.account || {};
  const gates = paper.gates || {};
  const positions = paper.open_positions || [];
  const proposals = paper.proposed_orders || [];
  const closed = paper.closed_trades || [];
  const alpaca = paper.alpaca_events || [];
  const modeClass = /alpaca/.test(paper.mode || '') ? 'ok' : 'warn';
  el.innerHTML = `
    <div class="paper-summary">
      <div class="paper-kpi"><span>Mode</span><b>${pill(paper.mode || 'local paper', modeClass)}</b><small>${esc(paper.verdict || 'paper board ready')}</small></div>
      <div class="paper-kpi"><span>Equity</span><b>${fmtMoney(account.equity)}</b><small>starting budget ${fmtMoney(account.starting_cash)}</small></div>
      <div class="paper-kpi"><span>Cash</span><b>${fmtMoney(account.cash)}</b><small>open exposure ${fmtMoney(account.market_value)}</small></div>
      <div class="paper-kpi"><span>Total PnL</span><b class="${clsDelta(account.total_pnl)}">${fmtMoney(account.total_pnl)}</b><small>realized ${fmtMoney(account.realized_pnl)} · unrealized ${fmtMoney(account.unrealized_pnl)}</small></div>
      <div class="paper-kpi"><span>Positions</span><b>${account.open_positions ?? 0}</b><small>closed trades ${account.closed_trades ?? 0} · win ${fmtPct(account.win_rate,1)}</small></div>
      <div class="paper-kpi"><span>Risk gates</span><b>${fmtMoney(account.max_position_notional)}</b><small>max one idea · max exposure ${fmtMoney(account.max_total_exposure)}</small></div>
    </div>
    <div class="paper-narrative">
      <div><b>What this board does</b><span>It keeps a $1,000 paper ledger for S2-adjusted vectors. A proposal requires h5/h10/h20 candidate coupling, a same-horizon live BUY vector, enough confidence, and positive expected return.</span></div>
      <div><b>What it does not do</b><span>It is not real-money trading. Alpaca submission is off unless paper API secrets are configured and ALPACA_PAPER_ENABLED is true. h1 never opens or closes paper positions.</span></div>
      <div><b>Current gates</b><span>min confidence ${fmtPct(gates.min_confidence,1)} · min expected return ${fmtSignedPct(gates.min_expected_return,2)} · long-only · h5/h10/h20 only.</span></div>
    </div>
    <div class="paper-grid">
      <section><div class="panel-subhead">Proposed / filled paper orders</div><div id="paperOrders" class="table-wrap compact"></div></section>
      <section><div class="panel-subhead">Open positions</div><div id="paperPositions" class="table-wrap compact"></div></section>
    </div>
    <div class="paper-grid">
      <section><div class="panel-subhead">Closed trades</div><div id="paperClosed" class="table-wrap compact"></div></section>
      <section><div class="panel-subhead">Alpaca paper events</div><div id="paperAlpaca" class="table-wrap compact"></div></section>
    </div>`;
  renderDataGrid('paperOrders', 'paperOrdersGrid', proposals, [
    {key:'ticker', label:'ticker', render:r=>`<strong>${esc(r.ticker)}</strong>`, value:r=>r.ticker},
    {key:'side', label:'side', render:r=>pill(r.side || '—', r.side === 'BUY' ? 'ok' : 'warn'), value:r=>r.side},
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'notional', label:'notional', cls:'num', render:r=>fmtMoney(r.notional), value:r=>r.notional},
    {key:'paper_fill_price', label:'price', cls:'num', render:r=>fmtMoney(r.paper_fill_price), value:r=>r.paper_fill_price},
    {key:'confidence', label:'conf', cls:'num', render:r=>fmtPct(r.confidence,1), value:r=>r.confidence},
    {key:'expected_return', label:'pred ret', cls:'num', render:r=>`<span class="${clsDelta(r.expected_return)}">${fmtSignedPct(r.expected_return)}</span>`, value:r=>r.expected_return},
    {key:'source_topic', label:'topic', render:r=>esc(r.source_topic), value:r=>r.source_topic},
    {key:'status', label:'status', render:r=>pill(r.status || 'proposed', r.status === 'local_filled' ? 'ok' : 'warn'), value:r=>r.status},
  ], {pageSize:25, note:'Orders are generated only from h5/h10/h20 candidate coupling plus same-horizon live BUY vectors. h1 rows are display-only dust diagnostics.'});
  renderDataGrid('paperPositions', 'paperPositionsGrid', positions, [
    {key:'ticker', label:'ticker', render:r=>`<strong>${esc(r.ticker)}</strong>`, value:r=>r.ticker},
    {key:'horizon', label:'h', render:r=>esc(r.horizon || '—'), value:r=>r.horizon},
    {key:'qty', label:'qty', cls:'num', render:r=>fmtNum(r.qty,4), value:r=>r.qty},
    {key:'avg_price', label:'avg', cls:'num', render:r=>fmtMoney(r.avg_price), value:r=>r.avg_price},
    {key:'last_price', label:'last', cls:'num', render:r=>fmtMoney(r.last_price), value:r=>r.last_price},
    {key:'market_value', label:'value', cls:'num', render:r=>fmtMoney(r.market_value), value:r=>r.market_value},
    {key:'unrealized_pnl', label:'uPnL', cls:'num', render:r=>`<span class="${clsDelta(r.unrealized_pnl)}">${fmtMoney(r.unrealized_pnl)}</span>`, value:r=>r.unrealized_pnl},
    {key:'source_topic', label:'topic', render:r=>esc(r.source_topic), value:r=>r.source_topic},
    {key:'planned_exit_date', label:'planned exit', render:r=>esc(r.planned_exit_date), value:r=>r.planned_exit_date},
  ], {pageSize:25, note:'Open paper positions are h5/h10/h20 only. They are marked with the latest ticker price; h1 live rows are ignored for both entries and exits.'});
  renderDataGrid('paperClosed', 'paperClosedGrid', closed, [
    {key:'ticker', label:'ticker', render:r=>`<strong>${esc(r.ticker)}</strong>`, value:r=>r.ticker},
    {key:'horizon', label:'h', render:r=>esc(r.horizon || '—'), value:r=>r.horizon},
    {key:'qty', label:'qty', cls:'num', render:r=>fmtNum(r.qty,4), value:r=>r.qty},
    {key:'entry_price', label:'entry', cls:'num', render:r=>fmtMoney(r.entry_price), value:r=>r.entry_price},
    {key:'exit_price', label:'exit', cls:'num', render:r=>fmtMoney(r.exit_price), value:r=>r.exit_price},
    {key:'realized_pnl', label:'rPnL', cls:'num', render:r=>`<span class="${clsDelta(r.realized_pnl)}">${fmtMoney(r.realized_pnl)}</span>`, value:r=>r.realized_pnl},
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'exit_reason', label:'reason', render:r=>esc(r.exit_reason), value:r=>r.exit_reason},
  ], {pageSize:25, note:'Closed trades update the $1,000 ledger. This is still paper PnL, not a broker statement.'});
  renderDataGrid('paperAlpaca', 'paperAlpacaGrid', alpaca, [
    {key:'ticker', label:'ticker', render:r=>esc(r.ticker || ''), value:r=>r.ticker},
    {key:'status', label:'status', render:r=>pill(r.status || '—', r.status === 'submitted' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn'), value:r=>r.status},
    {key:'http_status', label:'HTTP', cls:'num', render:r=>r.http_status ?? '', value:r=>r.http_status},
    {key:'reason', label:'reason/error', render:r=>esc(r.reason || r.error || ''), value:r=>r.reason || r.error},
  ], {pageSize:25, note:'Alpaca paper orders appear only when ALPACA_PAPER_ENABLED=true and paper API secrets are configured.'});
}

function renderLive() {
  const data = bundle.live_predictions || [];
  renderDataGrid('liveTable', 'liveGrid', data, [
    {key:'ticker', label:'ticker', render:r=>`<strong>${esc(r.ticker)}</strong>`, value:r=>r.ticker},
    {key:'horizon', label:'h', render:r=>esc(r.horizon), value:r=>r.horizon},
    {key:'prediction', label:'signal', render:r=>esc(r.prediction), value:r=>r.prediction},
    {key:'expected_return', label:'pred ret', cls:'num', render:r=>`<span class="${clsDelta(r.expected_return)}">${fmtSignedPct(r.expected_return)}</span>`, value:r=>r.expected_return},
    {key:'probability', label:'confidence', cls:'num', render:r=>fmtPct(r.probability,1), value:r=>r.probability},
    {key:'asof_date', label:'asof', render:r=>esc(r.asof_date || ''), value:r=>r.asof_date},
    {key:'asof_close', label:'close', cls:'num', render:r=>fmtNum(r.asof_close,3), value:r=>r.asof_close},
  ], { pageSize: 50, pageSizes:[25,50,100,250,500], defaultSort:'ticker', defaultDir:'asc', note: 'Search covers every loaded live prediction row, not just the first tickers. This table is display-only and never used to compute hit/PnL.' });
}

function renderHealth() {
  const data = bundle.source_health || [];
  renderDataGrid('sourceHealth', 'healthGrid', data, [
    {key:'group', label:'group', render:r=>esc(r.group), value:r=>r.group},
    {key:'kind', label:'kind', render:r=>esc(r.kind), value:r=>r.kind},
    {key:'ok', label:'status', render:r=>r.ok ? pill('loaded','ok') : pill('failed','bad'), value:r=>r.ok ? 1 : 0},
    {key:'schema_mode', label:'schema', render:r=>esc(r.schema_mode || ''), value:r=>r.schema_mode},
    {key:'rows', label:'parsed', cls:'num', render:r=>r.rows ?? 0, value:r=>r.rows},
    {key:'raw_rows', label:'raw', cls:'num', render:r=>r.raw_rows ?? '', value:r=>r.raw_rows},
    {key:'note', label:'note', render:r=>esc(r.warning || r.error || ''), value:r=>r.warning || r.error || ''},
    {key:'url', label:'url', render:r=>`<span class="mono">${esc(r.url)}</span>`, value:r=>r.url},
  ], { pageSize: 25, note: 'Source Health separates “loaded” from “recognized”. A loaded file can still be unusable if its schema changed.' });
}

function axisColor(){return getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#8ea4ad'}
function textColor(){return getComputedStyle(document.body).getPropertyValue('--text').trim() || '#e8f1f4'}
function gridLineColor(){return document.body.classList.contains('light') ? 'rgba(11,31,39,.12)' : 'rgba(128,128,128,.18)'}
function initChart() { if (!chart) chart = echarts.init($('mainChart')); }
function chartLimit(base, maxed) { return chartMaximized ? maxed : base; }
function chartGrid(left=110, top=62, bottom=76, right=34) { return { left, right, top, bottom, containLabel:true }; }
function axisValue(name, formatter) {
  return { type:'value', name, nameLocation:'middle', nameGap:48, nameTextStyle:{color:axisColor(),fontSize:11,fontWeight:600}, axisLabel:{formatter:formatter || undefined,color:axisColor(),hideOverlap:true}, axisLine:{lineStyle:{color:axisColor()}}, splitLine:{lineStyle:{color:gridLineColor()}} };
}
function axisCategory(name, data, rotate=0) {
  return { type:'category', name, nameLocation:'middle', nameGap:42, nameTextStyle:{color:axisColor(),fontSize:11,fontWeight:600}, data, axisLabel:{color:axisColor(),hideOverlap:true,rotate}, axisLine:{lineStyle:{color:axisColor()}} };
}
function chartTitle(text, subtext='') {
  return { text, subtext, left:10, top:6, textStyle:{color:textColor(),fontSize:12,fontWeight:700}, subtextStyle:{color:axisColor(),fontSize:10} };
}
function setChartNarrative(cards) {
  const el = $('chartNarrative');
  if (!el) return;
  el.innerHTML = cards.map(c => `<div class="chart-note"><b>${esc(c.title)}</b><span>${c.body}</span></div>`).join('');
}
function showTheater(show) {
  const theaterEl = $('theaterStage');
  const chartEl = $('mainChart');
  if (theaterEl) theaterEl.classList.toggle('hidden', !show);
  if (chartEl) chartEl.classList.toggle('hidden', show);
  if (show && chart) { chart.dispose(); chart = null; }
}
function renderChart() {
  if (activeTab === 'theater') { showTheater(true); return renderTheater(); }
  showTheater(false);
  initChart();
  if (!bundle) {
    setChartNarrative([{title:'Waiting', body:'Run the workflow to generate the strict artifact bundle. The chart will not use dummy data.'}]);
    chart.setOption({ title:{ text:'Waiting for generated bundle', left:'center', top:'middle', textStyle:{ color:'#8ea4ad', fontSize:13 } } }, true);
    return;
  }
  if (activeTab === 'cycle') return renderCycleChart();
  if (activeTab === 'horizon') return renderHorizonChart();
  if (activeTab === 'pnl') return renderPnlChart();
  if (activeTab === 'beta') return renderBetaChart();
  if (activeTab === 'backtest') return renderBacktestChart();
  renderCouplingChart();
}
function emptyChart(text, narrative='No source rows were available for this view.') {
  setChartNarrative([{title:'Empty view', body:esc(narrative)}, {title:'Strict mode', body:'The app leaves charts empty instead of inventing placeholder values.'}]);
  chart.setOption({ title:{ text, left:'center', top:'middle', textStyle:{ color:axisColor(), fontSize:13 } }, xAxis:[], yAxis:[], series:[] }, true);
}

function theaterColor(topic) {
  const map = {'Cybersecurity':'#60a5fa','AI / Tech':'#c084fc','Energy':'#f59e0b','Markets / Economy':'#34d399','Space / Science':'#f472b6','Public Health':'#22d3ee','Climate / Weather':'#a3e635','Culture / Media':'#fb7185','Politics / Elections':'#facc15','Geopolitics':'#f97316','General':'#94a3b8','Quantum tech':'#38bdf8'};
  if (map[topic]) return map[topic];
  let h = 0; String(topic || '').split('').forEach(ch => h = (h * 31 + ch.charCodeAt(0)) >>> 0);
  return Object.values(map)[h % Object.values(map).length];
}
function theaterBand(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h)) return 'medium';
  if (h <= 12) return 'short';
  if (h <= 48) return 'medium';
  if (h <= 120) return 'long';
  return 'slow';
}
function theaterBandX(band) { return ({short:0.16, medium:0.38, long:0.62, slow:0.84})[band] || 0.38; }
function theaterScore(row) {
  const dust = num(row.dust) ?? 0.25;
  const delta = num(row.delta_aic) ?? 0;
  const support = clip(delta / 35, 0, 1);
  return 100 * (0.56 * support + 0.30 * (1 - clip(dust / 0.50, 0, 1)) + 0.14 * (row.retained ? 1 : 0));
}
function theaterTradeSignalsFor(topic) {
  return (bundle?.theater_trade_signals || []).filter(r => r.topic === topic);
}
function theaterSignalScore(row) {
  return Math.abs(Number(row.expected_return || 0)) * 1000 + Number(row.probability || 0);
}
function theaterRowsForCurrent() {
  const batches = bundle?.theater_batches || [];
  if (!batches.length) return [];
  if (theater.batchIndex === 'auto') return batches.flatMap(b => (b.rows || []).map(r => ({...r, batch_id:b.batch_id})));
  const b = batches[Number(theater.batchIndex)] || batches[0];
  return (b?.rows || []).map(r => ({...r, batch_id:b.batch_id}));
}
function theaterBuildPoints() {
  const rows = theaterRowsForCurrent().filter(r => theater.topic === 'all' || r.topic === theater.topic);
  const counts = {};
  theater.points = rows.map((r, i) => {
    const band = theaterBand(r.lambda_hours);
    const topic = r.topic || 'Unknown';
    const j = counts[topic] || 0; counts[topic] = j + 1;
    const dust = num(r.dust) ?? 0.25;
    const delta = num(r.delta_aic) ?? 0;
    const support = clip(delta / 35, 0, 1);
    const retained = !!r.retained || (delta >= 6 && dust <= 0.35);
    const n = num(r.n) || 1;
    const links = theaterTradeSignalsFor(topic);
    const topSignals = links.flatMap(x => (x.signals || []).map(sig => ({...sig, coupling_horizon:x.horizon, coupling_score:x.coupling_score, delta_hit:x.delta_hit, delta_pnl:x.delta_pnl})))
      .sort((a,b)=>theaterSignalScore(b)-theaterSignalScore(a)).slice(0,6);
    return {
      topic, band, retained, dust, delta, beta:num(r.beta), lambda:num(r.lambda_hours), n,
      trade_links: links, trade_signals: topSignals,
      x: clip(theaterBandX(band) + ((j % 7)-3)*0.012 + ((i % 5)-2)*0.006, 0.06, 0.94),
      y: clip(0.14 + (0.25 + support*0.55 + (1-dust)*0.18)*0.72 + ((i % 9)-4)*0.018, 0.08, 0.94),
      size: 3 + Math.min(10, Math.log10(Math.max(1,n))*3.5),
      wobble:(i*1.618)%(Math.PI*2), score:theaterScore(r), batch_id:r.batch_id || ''
    };
  });
}
function theaterOpacity(p) {
  const phase = theaterPhase();
  let a = 0.9;
  if (phase >= 1 && p.dust > 0.35) a *= Math.max(0.04, 1 - theater.t * 1.55);
  if (phase >= 2 && p.delta < 6) a *= Math.max(0.05, 1 - (theater.t - 0.28) * 2.5);
  a *= p.retained ? (0.75 + theater.t * 0.45) : Math.max(0.06, 1 - theater.t * (0.9 + p.dust));
  if (!p.retained) a *= theater.dustVisible;
  return clip(a, 0.025, 1);
}
function theaterPhase() { const v = theater.t; return v < 0.14 ? 0 : v < 0.30 ? 1 : v < 0.48 ? 2 : v < 0.66 ? 3 : v < 0.88 ? 4 : 5; }
function theaterResize() {
  if (!theater.canvas) return;
  const r = theater.canvas.getBoundingClientRect();
  const d = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  theater.canvas.width = Math.floor(r.width * d); theater.canvas.height = Math.floor(r.height * d);
  theater.ctx.setTransform(d,0,0,d,0,0); theaterDraw();
}
function theaterDrawAxes(w,h) {
  const c = theater.ctx; c.save();
  c.strokeStyle = document.body.classList.contains('light') ? 'rgba(20,40,60,.22)' : 'rgba(238,246,255,.16)';
  c.lineWidth = 1; c.beginPath(); c.moveTo(58,h-44); c.lineTo(w-24,h-44); c.moveTo(58,h-44); c.lineTo(58,24); c.stroke();
  c.fillStyle = axisColor(); c.font = '800 11px Inter, sans-serif'; c.textAlign = 'center';
  ['short','medium','long','slow'].forEach(label => { const x = 58 + theaterBandX(label) * (w - 92); c.beginPath(); c.moveTo(x,h-50); c.lineTo(x,h-38); c.stroke(); c.fillText(label,x,h-22); });
  c.textAlign = 'right'; ['low','mid','high'].forEach((label,i)=>{ const y = h - 44 - (i+1)*(h-88)/4; c.beginPath(); c.moveTo(52,y); c.lineTo(64,y); c.stroke(); c.fillText(label,48,y+4); });
  c.restore();
}
function hexToRgba(hex, a) { const n = parseInt(String(hex).slice(1),16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; }
function theaterDrawFilaments(w,h) {
  const groups = {};
  theater.points.filter(p => p.retained && theaterOpacity(p) > 0.25).forEach(p => { (groups[p.topic] ||= []).push(p); });
  Object.entries(groups).forEach(([topic, arr]) => {
    if (arr.length < 2) return; arr.sort((a,b)=>a.x-b.x); const color = theaterColor(topic); const c = theater.ctx;
    c.save(); c.strokeStyle = hexToRgba(color, 0.08 + 0.42 * theater.t); c.lineWidth = 1.2 + 3.2 * theater.t; c.shadowColor = color; c.shadowBlur = 12 + 20 * theater.t; c.beginPath();
    arr.forEach((p,i)=>{ const x=58+p.x*(w-92), y=h-44-p.y*(h-88); if(i===0)c.moveTo(x,y); else c.lineTo(x,y); }); c.stroke(); c.restore();
  });
}
function theaterDraw() {
  if (!theater.ctx) return;
  const r = theater.canvas.getBoundingClientRect(), w = r.width, h = r.height, c = theater.ctx;
  c.clearRect(0,0,w,h); theaterDrawAxes(w,h); if (theater.t > 0.45) theaterDrawFilaments(w,h);
  theater.points.forEach(p => { const a=theaterOpacity(p), color=theaterColor(p.topic), x=58+p.x*(w-92)+Math.sin(performance.now()/900+p.wobble)*(p.retained?1.2:4.4*(1-theater.t)), y=h-44-p.y*(h-88)+Math.cos(performance.now()/1100+p.wobble)*(p.retained?1:3.8*(1-theater.t)); const rad=p.size*(p.retained?1+theater.t*.55:Math.max(.45,1-theater.t*.55)); p._sx=x; p._sy=y; p._sr=Math.max(10,rad+8); p._alpha=a; c.save(); c.globalAlpha=a; c.fillStyle=color; c.shadowColor=color; c.shadowBlur=p.retained?12+24*theater.t:2+7*(1-p.dust); c.beginPath(); c.arc(x,y,rad,0,Math.PI*2); c.fill(); if(p.retained && theater.t>.72){ c.globalAlpha=.22+.36*theater.t; c.lineWidth=1.3; c.strokeStyle=color; c.beginPath(); c.arc(x,y,rad+5+Math.sin(performance.now()/220)*1.8,0,Math.PI*2); c.stroke(); } c.restore(); });
}
function theaterNarrative() {
  const copy = [
    ['Raw cycle field','All fitted cycle rows from the selected refresh batch are visible before S2 thinning.'],
    ['Dust blur','High-dust rows fade first. The theater refuses to promote weak/noisy fits into structure.'],
    ['Cycle gate','Rows with stronger ΔAIC and acceptable dust survive longer.'],
    ['λ scale gate','Rows organize by retained scale: short, medium, long, and slow cycles separate.'],
    ['Filaments emerge','Surviving rows connect by topic. These are retained public-information filaments.'],
    ['Final retained field','The final field is intentionally sparse: if no rows survive, there is no retained filament.']
  ][theaterPhase()];
  const survivors = theater.points.filter(p=>p.retained && theaterOpacity(p) > 0.35).sort((a,b)=>b.score-a.score);
  const dustTotal = Math.max(1, theater.points.filter(p=>!p.retained).length);
  const visibleDust = theater.points.filter(p=>!p.retained && theaterOpacity(p) > 0.08).length;
  const dustRemoved = Math.round(100*(1-visibleDust/dustTotal));
  const batches = bundle?.theater_batches || [];
  const batchLabel = theater.batchIndex === 'auto' ? `last ${batches.length}` : (batches[Number(theater.batchIndex)]?.batch_id || 'selected');
  const box = $('theaterReadout'); if (box) box.innerHTML = `
    <div><span>cycle rows</span><b>${theater.points.length}</b></div><div><span>dust removed</span><b>${dustRemoved}%</b></div><div><span>retained</span><b>${survivors.length}</b></div><div><span>batch</span><b>${esc(batchLabel).slice(0,18)}</b></div>`;
  const body = $('theaterNarrativeBody'); if (body) body.innerHTML = `<b>${esc(copy[0])}</b><span>${esc(copy[1])}</span><span class="mini-line">Progress ${Math.round(theater.t*100)}%. Data source: generated bundle from cycle refresh JSONs; no dummy rows.</span>`;
  const list = $('theaterVectors'); if (list) list.innerHTML = survivors.slice(0,10).map(p=>`<div class="theater-vector"><strong>${esc(p.topic)} · ${esc(p.band)}</strong><span>β ${fmtNum(p.beta,2)} · λ ${fmtHours(p.lambda)} · dust ${fmtPct(p.dust,0)} · ΔAIC ${fmtNum(p.delta,2)}</span><em>${Math.round(p.score)}</em></div>`).join('') || '<div class="empty">No retained vectors in this pass.</div>';
}
function theaterTooltipHtml(p) {
  const rows = (p.trade_signals || []).slice(0,5);
  const signalHtml = rows.length ? rows.map(s => {
    const cls = Number(s.expected_return || 0) >= 0 ? 'tt-good' : 'tt-bad';
    return `<div class="tt-signal"><strong>${esc(s.ticker || '')}</strong><span>${esc(s.horizon || s.coupling_horizon || '')}</span><span class="${cls}">${esc(s.prediction || '')} ${fmtSignedPct(s.expected_return)} · ${fmtPct(s.probability,1)}</span></div>`;
  }).join('') : '<div class="tt-muted">No linked live trade rows for this topic/horizon in the bundle.</div>';
  return `<b>${esc(p.topic)} · ${esc(p.band)}</b>
    <div class="tt-muted">Batch: ${esc(p.batch_id || '')}</div>
    <div class="tt-grid"><span>β ${fmtNum(p.beta,2)}</span><span>λ ${fmtHours(p.lambda)}</span><span>dust ${fmtPct(p.dust,0)}</span><span>ΔAIC ${fmtNum(p.delta,2)}</span><span>retained ${p.retained ? 'yes' : 'no'}</span><span>score ${Math.round(p.score || 0)}</span></div>
    <div class="tt-signals"><b>linked live trade rows</b>${signalHtml}</div>`;
}
function theaterMoveTooltip(ev) {
  if (!theater.canvas || !theater.tooltip) return;
  const rect = theater.canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  let best = null, bestD = 999999;
  for (const p of theater.points) {
    if (!Number.isFinite(p._sx) || !Number.isFinite(p._sy) || (p._alpha || 0) < 0.06) continue;
    const dx = x - p._sx, dy = y - p._sy, d = Math.sqrt(dx*dx + dy*dy);
    if (d < (p._sr || 12) && d < bestD) { best = p; bestD = d; }
  }
  if (!best) { theater.tooltip.classList.add('hidden'); theater.hover = null; return; }
  theater.hover = best;
  theater.tooltip.innerHTML = theaterTooltipHtml(best);
  const wrap = theater.canvas.parentElement.getBoundingClientRect();
  let left = ev.clientX - wrap.left + 12;
  let top = ev.clientY - wrap.top + 12;
  const maxLeft = wrap.width - 380;
  if (left > maxLeft) left = Math.max(8, ev.clientX - wrap.left - 370);
  if (top > wrap.height - 210) top = Math.max(8, ev.clientY - wrap.top - 200);
  theater.tooltip.style.left = `${left}px`;
  theater.tooltip.style.top = `${top}px`;
  theater.tooltip.classList.remove('hidden');
}
function theaterHideTooltip() { if (theater.tooltip) theater.tooltip.classList.add('hidden'); theater.hover = null; }
function theaterTick(now) {
  if (!theater.last) theater.last = now; const dt = Math.min(0.05, (now - theater.last) / 1000); theater.last = now;
  if (activeTab === 'theater' && theater.playing) { theater.t += dt * 0.15 * theater.speed; if (theater.t >= 1) { theater.t = 1; theater.playing = false; } }
  theaterDraw(); theaterNarrative(); theaterSyncButtons();
  if (activeTab === 'theater') theater.raf = requestAnimationFrame(theaterTick);
}
function theaterSyncButtons() {
  const btn = $('theaterPlayBtn'); if (btn) btn.textContent = theater.playing ? 'Pause' : (theater.t >= 1 ? 'Replay S2' : 'Play S2');
}
function theaterReset() { theater.t=0; theater.playing=false; theater.last=0; theaterDraw(); theaterNarrative(); theaterSyncButtons(); }
function theaterPlayToggle() { if (theater.t >= 1) theater.t = 0; theater.playing = !theater.playing; theaterSyncButtons(); }
function theaterApplySelection() { theater.batchIndex = $('theaterBatch')?.value || 'auto'; theater.topic = $('theaterTopic')?.value || 'all'; theaterBuildPoints(); theaterReset(); }
function renderTheater() {
  const el = $('theaterStage');
  const batches = bundle?.theater_batches || [];
  if (!batches.length) {
    el.innerHTML = '<div class="theater-empty"><b>No S2 Theater batches loaded.</b><span>The build step did not find fitted cycle rows in the source refresh JSONs. Strict mode leaves the theater empty instead of inventing data.</span></div>';
    setChartNarrative([{title:'S2 Theater empty', body:'No real cycle-batch rows were available in the generated bundle.'},{title:'Strict mode', body:'The theater uses generated cycle-batch JSON only; no browser-side dummy rows are created.'}]);
    return;
  }
  if (!theater.ready) {
    const topics = [...new Set(batches.flatMap(b => (b.rows || []).map(r=>r.topic).filter(Boolean)))].sort();
    el.innerHTML = `
      <div class="theater-head">
        <div><b>S2 Filament Theater</b><span>Replay last cycle refresh batches. Dust fades; retained topic rows connect into filaments.</span></div>
        <div id="theaterReadout" class="theater-readout"></div>
      </div>
      <div class="theater-controls">
        <button id="theaterPlayBtn" class="primary">Play S2</button><button id="theaterResetBtn">Reset</button>
        <label>Speed <input id="theaterSpeed" type="range" min="0.5" max="3" step="0.25" value="1"></label>
        <label>Batch <select id="theaterBatch"><option value="auto">Replay last ${batches.length} refreshes</option>${batches.map((b,i)=>`<option value="${i}">${esc(b.batch_id)} · ${b.row_count} rows</option>`).join('')}</select></label>
        <label>Topic <select id="theaterTopic"><option value="all">All topics</option>${topics.map(t=>`<option>${esc(t)}</option>`).join('')}</select></label>
        <label>Dust visibility <input id="theaterDust" type="range" min="0" max="1" step="0.05" value="0.35"></label>
      </div>
      <div class="theater-body"><div class="theater-canvas-wrap"><canvas id="theaterCanvas"></canvas><div id="theaterTooltip" class="theater-tooltip hidden"></div><span class="theater-x">λ scale / retained cycle horizon →</span><span class="theater-y">cycle support / confidence →</span></div><aside><div id="theaterNarrativeBody" class="theater-narrative"></div><div id="theaterVectors" class="theater-vectors"></div></aside></div>
      <div class="theater-phases"><span>1 raw field</span><span>2 dust blur</span><span>3 cycle gate</span><span>4 λ scale</span><span>5 filaments</span><span>6 retained field</span></div>`;
    $('theaterPlayBtn')?.addEventListener('click', theaterPlayToggle);
    $('theaterResetBtn')?.addEventListener('click', theaterReset);
    $('theaterSpeed')?.addEventListener('input', e => theater.speed = Number(e.target.value) || 1);
    $('theaterDust')?.addEventListener('input', e => { theater.dustVisible = Number(e.target.value) || 0; theaterNarrative(); theaterDraw(); });
    $('theaterBatch')?.addEventListener('change', theaterApplySelection);
    $('theaterTopic')?.addEventListener('change', theaterApplySelection);
    theater.canvas = $('theaterCanvas'); theater.ctx = theater.canvas.getContext('2d'); theater.tooltip = $('theaterTooltip');
    theater.canvas.addEventListener('mousemove', theaterMoveTooltip);
    theater.canvas.addEventListener('mouseleave', theaterHideTooltip);
    theater.ready = true;
  }
  theaterBuildPoints(); theaterResize(); theaterNarrative(); theaterSyncButtons();
  setChartNarrative([{title:'What this shows', body:'The theater animates real fitted cycle rows from the latest generated bundle. It is sourced from cycle refresh JSONs bundled by the workflow.'},{title:'No dummy rows', body:'If source rows are missing, the theater remains empty. The animation does not generate fake tickers or synthetic signals.'},{title:'Mouseover read', body:'Hover any dot to see the fitted cycle row and the linked real live prediction rows for the matched non-h1 horizon.'},{title:'Teaching line', body:'S2 is not creating signal; it removes unresolved dust and highlights retained public-information filaments.'}]);
  if (theater.raf) cancelAnimationFrame(theater.raf); theater.last = 0; theater.raf = requestAnimationFrame(theaterTick);
}

function renderCycleChart(){
  const rows=(bundle.topic_summaries||[]).slice(0,chartLimit(16,40)).reverse();
  if (!rows.length) return emptyChart('No cycle rows parsed', 'No usable cycle rows were parsed from cycles/history/news_s2 JSON.');
  setChartNarrative([
    {title:'What this shows', body:'Retained pressure by topic from historical cycle JSON. Higher bars mean the topic has stronger retained news-cycle structure.'},
    {title:'What it does not show', body:'This chart is not market performance. It is the upstream public-information clock.'},
    {title:'Use it with', body:'Compare this with the Horizon and Coupling tabs to see whether strong cycle pressure lines up with matured h5/h10 market lift.'}
  ]);
  chart.setOption({backgroundColor:'transparent',title:chartTitle('Retained cycle pressure by topic','x-axis: retained pressure score'),grid:chartGrid(138,64,82,38),tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},xAxis:axisValue('retained pressure score'),yAxis:{type:'category',name:'topic',nameLocation:'middle',nameGap:92,nameTextStyle:{color:axisColor(),fontSize:11,fontWeight:600},data:rows.map(r=>r.topic),axisLabel:{color:axisColor(),hideOverlap:false},axisLine:{lineStyle:{color:axisColor()}}},series:[{name:'β-adjusted pressure',type:'bar',data:rows.map(r=>betaAdjustedPressure(r)),itemStyle:{color:'#6fb7ff'}},{name:'published pressure',type:'bar',data:rows.map(r=>r.retained_pressure_score),itemStyle:{color:'#b197fc'}}]},true);
}
function renderHorizonChart(){
  const scored = horizonSort(bundle.market_horizons || []);
  const backtest = horizonSort(bundle.backtest_horizons || []);
  const liveCounts = horizonSort(bundle.live_horizon_counts || []);
  const rows = scored.length ? scored : backtest;
  if (rows.length) {
    const title = scored.length ? 'Scored horizon ladder' : 'Backtest horizon reference — no live scorecard parsed';
    setChartNarrative([
      {title:'What this shows', body:'S2 minus baseline by scored horizon. Positive Δ hit means S2 guessed direction better after the prediction matured.'},
      {title:'Conservative rule', body:'A useful coupling needs more than hit-rate lift. Δ PnL should also be positive, otherwise the read stays mixed.'},
      {title:'h1 policy', body:'h1 is diagnostic/dust only. The research horizon starts at h5 and should expand to h10/h20 when scored artifacts exist.'}
    ]);
    chart.setOption({backgroundColor:'transparent',title:chartTitle(title,'x-axis: horizon · y-axis: S2 minus baseline'),legend:{top:34,textStyle:{color:textColor()}},grid:chartGrid(68,76,86,34),tooltip:{trigger:'axis',valueFormatter:v=>fmtSignedPct(v)},xAxis:axisCategory('scored horizon',rows.map(r=>r.horizon)),yAxis:axisValue('S2 - baseline',v=>`${(v*100).toFixed(1)}%`),series:[{name:'Δ hit',type:'bar',data:rows.map(r=>r.delta_hit),itemStyle:{color:'#66e3a1'}},{name:'Δ PnL',type:'bar',data:rows.map(r=>r.delta_pnl),itemStyle:{color:'#ffd166'}}]},true);
    return;
  }
  if (liveCounts.length) {
    setChartNarrative([
      {title:'Live rows only', body:'Live predictions show current state and coverage. They are not scored until future returns become observable.'},
      {title:'No hit/PnL math', body:'The app refuses to compute performance from live rows.'},
      {title:'Next step', body:'Wait for prediction_scorecard.csv to mature and publish h5/h10/h20 score rows.'}
    ]);
    chart.setOption({backgroundColor:'transparent',title:chartTitle('Live prediction horizon coverage — not scored','x-axis: live horizon · y-axis: row count'),grid:chartGrid(70,70,84,34),tooltip:{trigger:'axis'},xAxis:axisCategory('live prediction horizon',liveCounts.map(r=>r.horizon)),yAxis:axisValue('live rows'),series:[{name:'live rows',type:'bar',data:liveCounts.map(r=>r.rows),itemStyle:{color:'#6fb7ff'}}]},true);
    return;
  }
  emptyChart('No scored horizons, backtest horizons, or live horizon counts parsed', 'Source Health will identify whether the artifact was missing or its schema changed.');
}

function renderPnlChart(){
  const rows = horizonSort(bundle.pnl_audit || []);
  if (!rows.length) return emptyChart('No postfactum PnL audit parsed', 'The scorecard did not expose enough matured PnL fields for avg win/loss or cumulative proxy audit.');
  setChartNarrative([
    {title:'What this shows', body:'Paper-PnL proxy after predictions matured. It checks whether S2 direction improvements actually survive as payoff.'},
    {title:'Not portfolio PnL', body:'This excludes transaction costs, sizing, slippage, borrow, liquidity, and overlapping exposure.'},
    {title:'Conservative rule', body:'A real edge needs positive Δ hit and positive Δ PnL; hit-only lift is academically interesting but not economically confirmed.'}
  ]);
  chart.setOption({backgroundColor:'transparent',title:chartTitle('Postfactum PnL audit by horizon','x-axis: horizon · y-axis: S2 minus baseline'),legend:{top:34,textStyle:{color:textColor()}},grid:chartGrid(70,78,86,34),tooltip:{trigger:'axis',valueFormatter:v=>fmtSignedPct(v)},xAxis:axisCategory('matured horizon',rows.map(r=>r.horizon)),yAxis:axisValue('S2 - baseline',v=>`${(v*100).toFixed(1)}%`),series:[{name:'Δ PnL',type:'bar',data:rows.map(r=>r.delta_pnl),itemStyle:{color:'#ffd166'}},{name:'Δ hit',type:'bar',data:rows.map(r=>r.delta_hit),itemStyle:{color:'#66e3a1'}},{name:'Δ cumulative proxy',type:'line',smooth:true,data:rows.map(r=>r.delta_cumulative_pnl),itemStyle:{color:'#b197fc'}}]},true);
}

function renderBacktestChart(){
  const rows=bundle.backtest_horizons||[];
  if (!rows.length) return emptyChart('No backtest comparison parsed', 'model_comparison.json loaded zero recognized aggregate rows. Live scorecard can still work without this panel.');
  setChartNarrative([
    {title:'What this shows', body:'Historical model-comparison reference only. It is not the live prior scorecard.'},
    {title:'Why it matters', body:'Backtest lift can guide research, but live matured rows are the source of truth for current coupling.'},
    {title:'Interpretation', body:'Look for the same horizon pattern repeating in both backtest and live scorecard.'}
  ]);
  chart.setOption({backgroundColor:'transparent',title:chartTitle('Backtest reference by horizon','x-axis: horizon · y-axis: backtest S2 minus baseline'),legend:{top:34,textStyle:{color:textColor()}},grid:chartGrid(68,76,86,34),tooltip:{trigger:'axis',valueFormatter:v=>fmtSignedPct(v)},xAxis:axisCategory('backtest horizon',rows.map(r=>r.horizon)),yAxis:axisValue('backtest delta',v=>`${(v*100).toFixed(1)}%`),series:[{name:'Δ hit',type:'bar',data:rows.map(r=>r.delta_hit),itemStyle:{color:'#66e3a1'}},{name:'Δ PnL',type:'bar',data:rows.map(r=>r.delta_pnl),itemStyle:{color:'#ffd166'}}]},true);
}
function renderBetaChart(){
  const rows=(bundle.topic_summaries||[]).slice(0,chartLimit(20,44)).reverse();
  if (!rows.length) return emptyChart('No beta diagnostics parsed', 'No topic summaries were available for beta audit.');
  const legacy = num((bundle?.summary || {}).legacy_beta_floor_watch ?? (bundle?.summary || {}).beta_floor_watch) ?? 0.35;
  const assumed = num(betaPlay.assumedBeta) ?? legacy;
  const penalty = num(betaPlay.floorPenalty) ?? 0;
  const maxPressure = Math.max(1, ...rows.map(r => Math.max(betaBasePressure(r), betaAdjustedPressure(r))));
  setChartNarrative([
    {title:'This graph now responds to β', body:`The blue bars are the client-side what-if pressure after applying assumed β ${fmtNum(assumed,2)} and floor-lock penalty ${fmtPct(penalty,0)}. The violet bars are the source pressure from the current active wave when available.`},
    {title:'What does not change', body:'The β=0.35 share and new-grid-floor share are measured audit statistics from the source cycle files. It does not change when you move the slider; only the what-if pressure/ranking changes.'},
    {title:'Research action', body:'If moving β strongly changes the topic ranking, the market-coupling conclusion is beta-sensitive. Exact β still requires the upstream cycle app to refit below the old 0.35 floor.'}
  ]);
  chart.setOption({
    backgroundColor:'transparent',
    title:chartTitle('β playground: adjusted cycle pressure by topic',`x-axis: pressure · assumed β ${fmtNum(assumed,2)} · legacy floor ${fmtNum(legacy,2)}`),
    legend:{top:34,textStyle:{color:textColor()}},
    grid:chartGrid(150,76,90,50),
    tooltip:{
      trigger:'axis',
      axisPointer:{type:'shadow'},
      formatter: params => {
        const idx = params?.[0]?.dataIndex ?? 0;
        const r = rows[idx] || {};
        const lines = [`<strong>${esc(r.topic)}</strong>`, `β mode: ${fmtNum(r.beta_mode,2)}`, `β=0.35 share: ${fmtPct(r.beta_035_share ?? r.legacy_beta_floor_share ?? r.beta_floor_share,1)}`, `published pressure: ${fmtNum(betaBasePressure(r),2)}`, `adjusted pressure: ${fmtNum(betaAdjustedPressure(r),2)}`];
        return lines.join('<br>');
      }
    },
    xAxis:axisValue('cycle pressure score'),
    yAxis:{type:'category',name:'topic',nameLocation:'middle',nameGap:102,nameTextStyle:{color:axisColor(),fontSize:12,fontWeight:700},data:rows.map(r=>r.topic),axisLabel:{color:axisColor(),hideOverlap:false},axisLine:{lineStyle:{color:axisColor()}}},
    series:[
      {name:'β-adjusted pressure',type:'bar',data:rows.map(r=>betaAdjustedPressure(r)),itemStyle:{color:'#6fb7ff'}},
      {name:'published pressure',type:'bar',data:rows.map(r=>betaBasePressure(r)),itemStyle:{color:'#b197fc'}},
      {name:'β=0.35 share × max pressure',type:'line',smooth:true,symbolSize:5,data:rows.map(r=>(num(r.beta_035_share ?? r.legacy_beta_floor_share ?? r.beta_floor_share)||0)*maxPressure),itemStyle:{color:'#ffd166'},lineStyle:{width:2,type:'dashed'}}
    ]
  },true);
}
function renderCouplingChart(){
  const rows=adjustedCouplingRows().filter(r=>r.status !== 'dust diagnostic').sort((a,b)=>(b.beta_adjusted_coupling_score??-999)-(a.beta_adjusted_coupling_score??-999)).slice(0,chartLimit(28,60)).reverse();
  if (rows.length) {
    setChartNarrative([
      {title:'What this shows', body:'Research coupling score: retained topic pressure crossed with matured non-h1 S2 lift.'},
      {title:'Candidate rule', body:'Confirmed coupling needs positive hit lift and positive PnL lift. Hit-only improvement remains mixed.'},
      {title:'No trade instruction', body:'Rows rank structure alignment. They do not authorize execution or position sizing.'}
    ]);
    chart.setOption({backgroundColor:'transparent',title:chartTitle('β-adjusted coupling score from cycle pressure × scored horizon lift','x-axis: β-adjusted research coupling score · y-axis: topic/horizon'),grid:chartGrid(210,70,86,44),tooltip:{trigger:'axis'},xAxis:axisValue('research coupling score'),yAxis:{type:'category',name:'topic / horizon',nameLocation:'middle',nameGap:142,nameTextStyle:{color:axisColor(),fontSize:11,fontWeight:600},data:rows.map(r=>`${r.topic} / ${r.horizon}`),axisLabel:{color:axisColor(),hideOverlap:false},axisLine:{lineStyle:{color:axisColor()}}},series:[{name:'coupling score',type:'bar',data:rows.map(r=>r.beta_adjusted_coupling_score),itemStyle:{color:p=>p.value>=0?'#66e3a1':'#ff6b6b'}}]},true);
    return;
  }
  const topics=(bundle.topic_summaries||[]).slice(0,chartLimit(18,40)).reverse();
  if (topics.length) {
    setChartNarrative([
      {title:'No scored coupling yet', body:'The app found cycle pressure but no trusted non-h1 scored market lift to cross with it.'},
      {title:'Fallback view', body:'Showing real cycle pressure only. This keeps the graph useful without fabricating coupling.'},
      {title:'Needed input', body:'A matured h5/h10/h20 scorecard with recognized baseline and S2 rows.'}
    ]);
    chart.setOption({backgroundColor:'transparent',title:chartTitle('No confirmed coupling — showing real cycle pressure only','x-axis: retained pressure score'),grid:chartGrid(138,70,84,38),tooltip:{trigger:'axis'},xAxis:axisValue('retained pressure score'),yAxis:{type:'category',name:'topic',nameLocation:'middle',nameGap:92,nameTextStyle:{color:axisColor(),fontSize:11,fontWeight:600},data:topics.map(r=>r.topic),axisLabel:{color:axisColor(),hideOverlap:false},axisLine:{lineStyle:{color:axisColor()}}},series:[{name:'retained pressure',type:'bar',data:topics.map(r=>r.retained_pressure_score),itemStyle:{color:'#6fb7ff'}}]},true);
    return;
  }
  emptyChart('No cycle rows parsed. Coupling cannot be evaluated.', 'No coupling and no cycle pressure rows are available.');
}
function toggleChartMaximized() {
  const panel = document.querySelector('.chart-panel');
  if (!panel) return;
  chartMaximized = !chartMaximized;
  panel.classList.toggle('is-maximized', chartMaximized);
  document.body.classList.toggle('chart-maximized', chartMaximized);
  const btn = $('chartMaxBtn');
  if (btn) btn.textContent = chartMaximized ? 'Collapse graph' : 'Max graph';
  let backdrop = document.querySelector('.chart-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'chart-backdrop';
    backdrop.addEventListener('click', () => { if (chartMaximized) toggleChartMaximized(); });
    document.body.appendChild(backdrop);
  }
  setTimeout(() => { chart && chart.resize(); renderChart(); }, 80);
}


function applyBetaCollapse() {
  const panel = $('betaPlayground');
  if (!panel) return;
  panel.classList.toggle('is-collapsed', betaCollapsed);
  const btn = $('betaToggleBtn');
  if (btn) btn.textContent = betaCollapsed ? 'Expand β' : 'Collapse β';
  renderBetaPlay();
}
function toggleBetaPlayground() {
  betaCollapsed = !betaCollapsed;
  localStorage.setItem('s2_beta_collapsed', betaCollapsed ? '1' : '0');
  applyBetaCollapse();
  setTimeout(() => chart && chart.resize(), 80);
}

function bind() {
  document.querySelectorAll('.tab[data-tab]').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-tab]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); activeTab = btn.dataset.tab; renderChart();
  }));
  $('chartMaxBtn')?.addEventListener('click', toggleChartMaximized);
  $('betaToggleBtn')?.addEventListener('click', toggleBetaPlayground);
  applyBetaCollapse();
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && chartMaximized) toggleChartMaximized(); });
  $('refreshBtn').addEventListener('click', () => loadBundle(true));
  $('themeBtn').addEventListener('click', () => { const light=document.body.classList.toggle('light'); $('themeBtn').textContent = light ? 'Dark' : 'Light'; setTimeout(renderChart, 80); });
  const betaAssumed = $('betaAssumed');
  const betaPenalty = $('betaPenalty');
  if (betaAssumed) betaAssumed.addEventListener('input', e => { betaPlay.assumedBeta = Number(e.target.value) || 0.35; renderBetaPlay(); renderBetaAdjusted(); if (['cycle','coupling','beta'].includes(activeTab)) renderChart(); });
  if (betaPenalty) betaPenalty.addEventListener('input', e => { betaPlay.floorPenalty = Number(e.target.value) || 0; renderBetaPlay(); renderBetaAdjusted(); if (['cycle','coupling','beta'].includes(activeTab)) renderChart(); });
  window.addEventListener('resize', () => { if (chart) chart.resize(); if (activeTab === 'theater') theaterResize(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadBundle(false); });
}
bind();
loadBundle(false);
setInterval(() => loadBundle(false), POLL_MS);
