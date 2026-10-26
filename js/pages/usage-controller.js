/**
 * Pure helpers for the usage/billing dashboards.
 * No DOM/network access here so the logic stays unit-testable.
 */

export const USAGE_KINDS = ['chat', 'embedding_ingest', 'embedding_query'];
export const KIND_LABELS = {
  chat: 'Chat',
  embedding_ingest: 'Document ingestion',
  embedding_query: 'Query embeddings',
};
export const METRIC_LABELS = {
  total_tokens: 'Total tokens',
  prompt_tokens: 'Prompt tokens',
  completion_tokens: 'Completion tokens',
  embedding_tokens: 'Embedding tokens',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clean = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;

export function isoDate(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}

export function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDate(d) !== value) return null;
  return d;
}

export function addDays(dateStr, days) {
  const d = parseIsoDate(dateStr);
  if (!d) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function addMonths(dateStr, months) {
  const d = parseIsoDate(dateStr);
  if (!d) return '';
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  return isoDate(d);
}

/** Default window: last 30 calendar days inclusive (UTC). */
export function defaultRange(now = new Date()) {
  const to = isoDate(now);
  return { from: addDays(to, -29), to };
}

export function isValidRange(from, to) {
  return !!parseIsoDate(from) && !!parseIsoDate(to) && from <= to;
}

/** Drop empty values and the `all` sentinel so the server sees clean params. */
export function usageQueryParams(q = {}) {
  const params = {};
  if (q.from) params.from = q.from;
  if (q.to) params.to = q.to;
  if (q.bot) params.bot = q.bot;
  if (q.kind && q.kind !== 'all') params.kind = q.kind;
  if (q.granularity) params.granularity = q.granularity;
  return params;
}

export function zeroPeriod(date) {
  return {
    date,
    total_tokens: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    embedding_tokens: 0,
    requests: 0,
    cost_usd: null,
  };
}

/**
 * Fill missing day/month buckets between [from, to] inclusive.
 * Monthly buckets use the first day of the month (YYYY-MM-01).
 */
export function zeroFillDaily(results = [], from, to, granularity = 'day') {
  if (!isValidRange(from, to)) return [];
  const map = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    const key = String(row?.date || '').slice(0, 10);
    if (key) map.set(key, row);
  }
  const monthly = granularity === 'month';
  const out = [];
  let cur = monthly ? `${from.slice(0, 7)}-01` : from;
  let guard = 0;
  while (cur && cur <= to && guard++ < 5000) {
    const hit = map.get(cur);
    out.push(hit ? { ...zeroPeriod(cur), ...hit, date: cur } : zeroPeriod(cur));
    cur = monthly ? addMonths(cur, 1) : addDays(cur, 1);
  }
  return out;
}

/** Sum a list of totals. Cost is only summed when at least one value is known. */
export function sumTotals(rows = []) {
  const total = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, embedding_tokens: 0, requests: 0, cost_usd: null };
  let hasCost = false;
  let cost = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    total.total_tokens += clean(row?.total_tokens);
    total.prompt_tokens += clean(row?.prompt_tokens);
    total.completion_tokens += clean(row?.completion_tokens);
    total.embedding_tokens += clean(row?.embedding_tokens);
    total.requests += clean(row?.requests);
    if (row?.cost_usd != null && Number.isFinite(Number(row.cost_usd))) {
      hasCost = true;
      cost += Number(row.cost_usd);
    }
  }
  total.cost_usd = hasCost ? Number(cost.toFixed(6)) : null;
  return total;
}

/** Only kinds that actually have a payload, in a stable display order. */
export function presentKinds(byKind = {}) {
  return USAGE_KINDS.filter((k) => byKind && byKind[k] && typeof byKind[k] === 'object');
}

export function kindBreakdown(byKind = {}) {
  const rows = presentKinds(byKind).map((kind) => ({
    kind,
    label: KIND_LABELS[kind] || kind,
    totals: sumTotals([byKind[kind]]),
  }));
  const grand = rows.reduce((a, r) => a + r.totals.total_tokens, 0);
  return rows.map((r) => ({ ...r, share: grand > 0 ? r.totals.total_tokens / grand : 0 }));
}

export function hasUsage(totals = {}) {
  const t = totals || {};
  return num(t.requests) > 0 || num(t.total_tokens) > 0;
}

export function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US').format(Number(value));
}

export function formatCost(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(value));
}

export function formatCompact(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function periodLabel(dateStr, granularity = 'day') {
  const d = parseIsoDate(dateStr);
  if (!d) return dateStr || '';
  const m = MONTHS[d.getUTCMonth()];
  if (granularity === 'month') return `${m} ${d.getUTCFullYear()}`;
  return `${m} ${d.getUTCDate()}`;
}

/**
 * Build a responsive area/line chart as an SVG string.
 * Sparse periods must already be zero-filled by the caller.
 */
export function usageChartSvg(periods = [], { metric = 'total_tokens', width = 720, height = 220, granularity = 'day' } = {}) {
  if (!Array.isArray(periods) || !periods.length) return '';
  const pad = { l: 52, r: 16, t: 16, b: 30 };
  const cw = width - pad.l - pad.r;
  const ch = height - pad.t - pad.b;
  const vals = periods.map((p) => num(p?.[metric]));
  const rawMax = Math.max(1, ...vals);
  const max = niceCeil(rawMax);
  const xAt = (i) => periods.length === 1 ? pad.l + cw / 2 : pad.l + (i / (periods.length - 1)) * cw;
  const yAt = (v) => pad.t + ch - (v / max) * ch;
  const base = pad.t + ch;

  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  const area = `${line} L${xAt(vals.length - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`;

  const grid = [0, 1, 2, 3, 4].map((step) => {
    const value = (max / 4) * (4 - step);
    const y = pad.t + (ch / 4) * step;
    return `<line class="chart-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${width - pad.r}" y2="${y.toFixed(1)}"/>`
      + `<text class="chart-axis" x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${formatCompact(value)}</text>`;
  }).join('');

  const idx = new Set([0, Math.floor((periods.length - 1) / 2), periods.length - 1]);
  if (periods.length <= 7) periods.forEach((_, i) => idx.add(i));
  const xLabels = [...idx].sort((a, b) => a - b).map((i) =>
    `<text class="chart-axis" x="${xAt(i).toFixed(1)}" y="${height - 8}" text-anchor="middle">${periodLabel(periods[i]?.date, granularity)}</text>`,
  ).join('');

  const dots = periods.map((p, i) =>
    `<circle class="chart-dot" cx="${xAt(i).toFixed(1)}" cy="${yAt(vals[i]).toFixed(1)}" r="3"><title>${periodLabel(p.date, granularity)} · ${formatNumber(vals[i])}</title></circle>`,
  ).join('');

  return `<svg class="usage-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Usage chart">`
    + `<defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--primary)" stop-opacity=".3"/><stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>`
    + grid
    + `<path class="chart-area" d="${area}" fill="url(#usage-fill)"/>`
    + `<path class="chart-line" d="${line}"/>`
    + dots
    + xLabels
    + `</svg>`;
}

function niceCeil(n) {
  if (n <= 10) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const frac = n / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

export function classifyUsageError(err) {
  const status = Number(err?.status);
  if (status === 403 || status === 404) return 'forbidden';
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'validation';
  if (status === 0) return 'network';
  return 'unknown';
}

/** Total token series from an already zero-filled array. */
export function tokenSeries(periods = []) {
  return periods.map((p) => num(p?.total_tokens));
}
