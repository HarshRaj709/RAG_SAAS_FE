import { initTheme } from '../state.js';
import { guard } from '../router-guard.js';
import { getOrgContext } from '../components/org-switcher.js';
import { apiFetch, asList } from '../api.js';
import { ENDPOINTS } from '../config.js';
import { toast, emptyState } from '../ui.js';
import { escapeHtml } from '../utils.js';
import {
  defaultRange,
  usageQueryParams,
  zeroFillDaily,
  hasUsage,
  formatNumber,
  formatCost,
  kindBreakdown,
  classifyUsageError,
  usageChartSvg,
  METRIC_LABELS,
} from './usage-controller.js';

initTheme();

async function main() {
  const guardedOrgId = await guard('usage.html');
  const { orgId: contextOrgId, org } = await getOrgContext();
  const orgId = contextOrgId || guardedOrgId;
  const page = document.getElementById('page');
  if (!orgId || !org) {
    page.innerHTML = emptyState('🏢', 'No organization', 'Create or join an organization to see usage.', '<a class="btn btn-primary" href="settings.html#new-org">Create organization</a>');
    return;
  }
  const range = defaultRange();
  const state = { from: range.from, to: range.to, kind: 'all', bot: '', granularity: 'day' };

  let bots = [];
  try {
    bots = await apiFetch(ENDPOINTS.bots(orgId), { cacheTtl: 60000 }).then(asList);
  } catch { /* bot filter is optional; keep org-level usage working */ }

  page.innerHTML = `
    <div class="page-head"><div><h2>Usage</h2><p class="muted">${escapeHtml(org?.name || 'Organization')} · token consumption over time</p></div></div>
    <div class="card usage-filters-card">
      <div class="usage-filters">
        <div class="field"><label for="u-from">From</label><input id="u-from" type="date" value="${state.from}"></div>
        <div class="field"><label for="u-to">To</label><input id="u-to" type="date" value="${state.to}"></div>
        <div class="field"><label for="u-kind">Kind</label>
          <select id="u-kind">
            <option value="all">All kinds</option>
            <option value="chat">Chat</option>
            <option value="embedding_ingest">Document ingestion</option>
          </select>
        </div>
        <div class="field"><label for="u-bot">Bot</label>
          <select id="u-bot"><option value="">All bots</option>${bots.map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name || b.slug || b.id)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Granularity</label>
          <div class="usage-gran" role="group" aria-label="Chart granularity">
            <button class="btn btn-secondary btn-sm" data-gran="day" aria-pressed="true">Day</button>
            <button class="btn btn-secondary btn-sm" data-gran="month" aria-pressed="false">Month</button>
          </div>
        </div>
      </div>
      <div class="usage-filter-foot"><span class="tiny muted">Dates are UTC · default is the last 30 days</span><span class="error-text small" id="usage-range-error"></span><span class="tiny muted" id="usage-status" aria-live="polite"></span></div>
    </div>
    <div id="usage-results" class="mt3"></div>`;

  const results = document.getElementById('usage-results');
  const fromEl = document.getElementById('u-from');
  const toEl = document.getElementById('u-to');
  const kindEl = document.getElementById('u-kind');
  const botEl = document.getElementById('u-bot');
  const rangeErr = document.getElementById('usage-range-error');
  const statusEl = document.getElementById('usage-status');
  const granBtns = [...page.querySelectorAll('[data-gran]')];

  let seq = 0;
  let firstLoad = true;

  function readRange() {
    state.from = fromEl.value;
    state.to = toEl.value;
    rangeErr.textContent = '';
    if (!state.from || !state.to) { rangeErr.textContent = 'Choose both dates.'; return false; }
    if (state.from > state.to) { rangeErr.textContent = "'From' must be on or before 'To'."; return false; }
    return true;
  }

  function showError(err) {
    const kind = classifyUsageError(err);
    const message = err?.message || 'Something went wrong loading usage.';
    if (kind === 'forbidden') {
      results.innerHTML = emptyState('🔒', 'Access denied', 'You do not have access to this organization’s usage data.', '<a class="btn btn-secondary" href="dashboard.html">Back to dashboard</a>');
      return;
    }
    if (kind === 'validation') {
      results.innerHTML = `<div class="alert alert-danger">${escapeHtml(message)}</div>`;
      return;
    }
    results.innerHTML = `<div class="card"><div class="empty" style="padding:32px 16px"><div class="empty-icon">⚠️</div><h3 style="color:var(--text)">Could not load usage</h3><p class="mt1">${escapeHtml(message)}</p><button class="btn btn-secondary mt2" id="usage-retry">Retry</button></div></div>`;
    results.querySelector('#usage-retry')?.addEventListener('click', load);
  }

  function render(summary, daily, byBot) {
    const periods = zeroFillDaily(daily?.results, state.from, state.to, state.granularity);
    const rows = Array.isArray(byBot?.results) ? byBot.results : [];
    const kinds = kindBreakdown(summary?.by_kind);
    const empty = !hasUsage(summary);

    const kpis = [
      ['🪙', 'Total tokens', formatNumber(summary?.total_tokens), ''],
      ['⬆️', 'Prompt tokens', formatNumber(summary?.prompt_tokens), ''],
      ['⬇️', 'Completion tokens', formatNumber(summary?.completion_tokens), ''],
      ['🧩', 'Embedding tokens', formatNumber(summary?.embedding_tokens), ''],
      ['📨', 'Requests', formatNumber(summary?.requests), '1 per completed message / ingestion'],
      ['💵', 'Cost (USD)', formatCost(summary?.cost_usd), summary?.cost_usd == null ? 'Cost data unavailable' : ''],
    ];

    const kindHtml = kinds.length ? `
      <div class="usage-stack" aria-hidden="true">${kinds.map(k => `<span class="k-${k.kind}" style="width:${(k.share * 100).toFixed(2)}%" title="${escapeHtml(k.label)}: ${formatNumber(k.totals.total_tokens)} tokens"></span>`).join('')}</div>
      <div class="usage-legend mt2">${kinds.map(k => `<div class="usage-legend-row">
        <span class="usage-legend-dot k-${k.kind}"></span>
        <span class="usage-legend-name">${escapeHtml(k.label)}</span>
        <span class="mono">${formatNumber(k.totals.total_tokens)}</span>
        <span class="tiny muted">${formatNumber(k.totals.requests)} req · ${formatCost(k.totals.cost_usd)}</span>
      </div>`).join('')}</div>`
      : '<p class="muted small mt1">No kind breakdown for this range.</p>';

    const botRows = rows.map(b => `<tr>
      <td><a href="bot.html?id=${encodeURIComponent(b.bot_id)}&tab=usage"><strong>${escapeHtml(b.name || b.slug || b.bot_id)}</strong></a><br><span class="tiny mono muted">/${escapeHtml(b.slug || '')}</span></td>
      <td class="mono">${formatNumber(b.total_tokens)}</td>
      <td class="mono">${formatNumber(b.prompt_tokens)}</td>
      <td class="mono">${formatNumber(b.completion_tokens)}</td>
      <td class="mono">${formatNumber(b.embedding_tokens)}</td>
      <td class="mono">${formatNumber(b.requests)}</td>
      <td class="mono">${formatCost(b.cost_usd)}</td>
    </tr>`).join('');

    const chart = usageChartSvg(periods, { metric: 'total_tokens', granularity: state.granularity });

    results.innerHTML = `
      <div class="usage-kpis">${kpis.map(([ico, label, value, sub]) => `<div class="card stat-card"><div class="stat-icon">${ico}</div><div style="min-width:0"><div class="stat-num">${value}</div><div class="stat-label">${label}</div>${sub ? `<div class="tiny muted">${escapeHtml(sub)}</div>` : ''}</div></div>`).join('')}</div>
      ${empty ? `<div class="alert alert-info mt3">No usage recorded in this range. Change the dates, kind, or bot filter to see other data.</div>` : ''}
      <div class="card mt3">
        <div class="flex between" style="flex-wrap:wrap"><div><h3>${METRIC_LABELS.total_tokens} over time</h3><p class="small muted">${state.granularity === 'month' ? 'Monthly' : 'Daily'} buckets, zero-filled for gaps. All dates UTC.</p></div></div>
        <div class="usage-chart mt2">${chart || '<p class="muted small">No chart data.</p>'}</div>
      </div>
      <div class="card mt3"><h3>By kind</h3><p class="small muted">Only kinds with usage in this range are shown. Cost shows — when unknown.</p>${kindHtml}</div>
      <div class="card mt3"><div class="flex between" style="flex-wrap:wrap"><div><h3>Usage by bot</h3><p class="small muted">Ordered by total tokens. Bot-less usage (e.g. ingestion) is included in the totals above but not here.</p></div></div>
        <div class="table-wrap mt2">${botRows ? `<table><thead><tr><th>Bot</th><th>Total</th><th>Prompt</th><th>Completion</th><th>Embedding</th><th>Requests</th><th>Cost</th></tr></thead><tbody>${botRows}</tbody></table>` : '<p class="muted small" style="padding:16px">No bot-attributed usage in this range.</p>'}</div>
      </div>`;
  }

  async function load() {
    if (!readRange()) return;
    const my = ++seq;
    statusEl.textContent = firstLoad ? 'Loading…' : 'Refreshing…';
    if (firstLoad) {
      results.innerHTML = Array.from({ length: 4 }, () => '<div class="card mt2"><div class="skeleton" style="height:18px;width:45%"></div><div class="skeleton mt1" style="height:13px;width:80%"></div></div>').join('');
    }
    try {
      const base = usageQueryParams({ from: state.from, to: state.to, bot: state.bot, kind: state.kind });
      const dailyQuery = usageQueryParams({ from: state.from, to: state.to, bot: state.bot, kind: state.kind, granularity: state.granularity });
      const [summary, daily, byBot] = await Promise.all([
        apiFetch(`${ENDPOINTS.usageSummary(orgId)}?${new URLSearchParams(base)}`, { cacheTtl: 15000 }),
        apiFetch(`${ENDPOINTS.usageDaily(orgId)}?${new URLSearchParams(dailyQuery)}`, { cacheTtl: 15000 }),
        apiFetch(`${ENDPOINTS.usageByBot(orgId)}?${new URLSearchParams(base)}`, { cacheTtl: 15000 }),
      ]);
      if (my !== seq) return;
      render(summary, daily, byBot);
      statusEl.textContent = '';
    } catch (e) {
      if (my !== seq) return;
      statusEl.textContent = '';
      if (classifyUsageError(e) === 'unauthorized') return; // apiFetch redirects to login
      showError(e);
    } finally {
      if (my === seq) firstLoad = false;
    }
  }

  fromEl.addEventListener('change', load);
  toEl.addEventListener('change', load);
  kindEl.addEventListener('change', () => { state.kind = kindEl.value; load(); });
  botEl.addEventListener('change', () => { state.bot = botEl.value; load(); });
  granBtns.forEach(btn => btn.addEventListener('click', () => {
    state.granularity = btn.dataset.gran;
    granBtns.forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    load();
  }));

  load();
}

main().catch(e => {
  if (e === 0) return;
  toast(e?.message || 'Could not load usage.', 'error');
});
