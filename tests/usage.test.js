import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  defaultRange,
  addDays,
  addMonths,
  usageQueryParams,
  zeroFillDaily,
  sumTotals,
  presentKinds,
  kindBreakdown,
  hasUsage,
  formatNumber,
  formatCost,
  formatCompact,
  periodLabel,
  usageChartSvg,
  classifyUsageError,
} from '../js/pages/usage-controller.js';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/* ==================== dates ==================== */

test('defaultRange is the last 30 calendar days inclusive in UTC', () => {
  const r = defaultRange(new Date('2026-10-26T23:30:00Z'));
  assert.equal(r.to, '2026-10-26');
  assert.equal(r.from, '2026-09-27');
  assert.equal(addDays(r.from, 29), r.to);
});

test('addDays/addMonths cross month and year boundaries in UTC', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-15', 1), '2026-02-01');
  assert.equal(addMonths('2026-12-01', 1), '2027-01-01');
  assert.equal(addDays('nope', 1), '');
});

/* ==================== query params ==================== */

test('usageQueryParams omits empty values and the all sentinel', () => {
  assert.deepEqual(usageQueryParams({ from: '2026-10-01', to: '2026-10-31', kind: 'all', bot: '' }), {
    from: '2026-10-01', to: '2026-10-31',
  });
  assert.deepEqual(usageQueryParams({ kind: 'chat', bot: 'b1', granularity: 'month' }), {
    kind: 'chat', bot: 'b1', granularity: 'month',
  });
});

/* ==================== zero-fill ==================== */

test('zeroFillDaily fills missing days in ascending order', () => {
  const filled = zeroFillDaily(
    [
      { date: '2026-10-02', total_tokens: 5, prompt_tokens: 3, completion_tokens: 2, embedding_tokens: 0, requests: 1, cost_usd: 0.01 },
    ],
    '2026-10-01', '2026-10-04', 'day',
  );
  assert.equal(filled.length, 4);
  assert.deepEqual(filled.map((r) => r.date), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(filled[1].total_tokens, 5);
  assert.equal(filled[0].total_tokens, 0);
  assert.equal(filled[0].cost_usd, null);
  assert.equal(filled[3].requests, 0);
});

test('zeroFillDaily monthly buckets start on the first and fill gaps', () => {
  const filled = zeroFillDaily(
    [{ date: '2026-11-01', total_tokens: 9, prompt_tokens: 0, completion_tokens: 0, embedding_tokens: 9, requests: 1, cost_usd: null }],
    '2026-09-17', '2026-12-05', 'month',
  );
  assert.deepEqual(filled.map((r) => r.date), ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
  assert.equal(filled[2].total_tokens, 9);
  assert.equal(filled[3].total_tokens, 0);
});

test('zeroFillDaily returns an empty list for an invalid or reversed range', () => {
  assert.deepEqual(zeroFillDaily([], '2026-10-10', '2026-10-01'), []);
  assert.deepEqual(zeroFillDaily([], 'bad', '2026-10-01'), []);
});

/* ==================== totals + kinds ==================== */

test('sumTotals adds tokens and only considers non-null costs', () => {
  const totals = sumTotals([
    { total_tokens: 10, prompt_tokens: 6, completion_tokens: 4, embedding_tokens: 0, requests: 1, cost_usd: 0.1 },
    { total_tokens: 5, prompt_tokens: 0, completion_tokens: 0, embedding_tokens: 5, requests: 2, cost_usd: null },
  ]);
  assert.equal(totals.total_tokens, 15);
  assert.equal(totals.requests, 3);
  assert.equal(totals.cost_usd, 0.1);
  assert.equal(sumTotals([{ total_tokens: 1, cost_usd: null }]).cost_usd, null);
});

test('presentKinds and kindBreakdown ignore missing kinds and compute shares', () => {
  const byKind = {
    embedding_ingest: { total_tokens: 25, prompt_tokens: 0, completion_tokens: 0, embedding_tokens: 25, requests: 1, cost_usd: null },
    chat: { total_tokens: 75, prompt_tokens: 50, completion_tokens: 25, embedding_tokens: 0, requests: 3, cost_usd: 0.01 },
  };
  assert.deepEqual(presentKinds(byKind), ['chat', 'embedding_ingest']);
  assert.deepEqual(presentKinds({}), []);
  assert.deepEqual(presentKinds(null), []);
  const rows = kindBreakdown(byKind);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'chat');
  assert.equal(rows[0].label, 'Chat');
  assert.equal(rows[0].share, 0.75);
  assert.equal(rows[1].share, 0.25);
  assert.equal(kindBreakdown({}).length, 0);
});

test('hasUsage detects empty summaries', () => {
  assert.equal(hasUsage({ total_tokens: 0, requests: 0 }), false);
  assert.equal(hasUsage({ total_tokens: 1, requests: 0 }), true);
  assert.equal(hasUsage({ total_tokens: 0, requests: 1 }), true);
  assert.equal(hasUsage(null), false);
});

/* ==================== formatting ==================== */

test('number formatting uses separators and keeps null cost distinct from zero', () => {
  assert.equal(formatNumber(12345), '12,345');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(null), '—');
  assert.equal(formatNumber(undefined), '—');
  assert.equal(formatCost(null), '—');
  assert.equal(formatCost(undefined), '—');
  assert.equal(formatCost(0), '$0.00');
  assert.match(formatCost(0.012345), /^\$0\.012345$/);
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1500), '1.5k');
  assert.equal(formatCompact(2_000_000), '2M');
});

test('periodLabel renders readable UTC day/month labels', () => {
  assert.equal(periodLabel('2026-10-25', 'day'), 'Oct 25');
  assert.equal(periodLabel('2026-10-01', 'month'), 'Oct 2026');
  assert.equal(periodLabel('bad', 'day'), 'bad');
});

/* ==================== chart ==================== */

test('usageChartSvg renders a line, dots and safe labels for zero-filled data', () => {
  const periods = zeroFillDaily([], '2026-10-01', '2026-10-03', 'day');
  const svg = usageChartSvg(periods, { granularity: 'day' });
  assert.match(svg, /^<svg/);
  assert.match(svg, /class="chart-line"/);
  assert.equal((svg.match(/class="chart-dot"/g) || []).length, 3);
  assert.match(svg, /Oct 1/);
  assert.match(svg, /Oct 3/);
  // all-zero series must not divide by zero or produce NaN
  assert.ok(!/NaN/.test(svg));
});

test('usageChartSvg handles a single bucket and an empty list', () => {
  const one = usageChartSvg([{ date: '2026-10-01', total_tokens: 42 }]);
  assert.match(one, /class="chart-line"/);
  assert.match(one, /42/);
  assert.equal(usageChartSvg([]), '');
});

/* ==================== errors ==================== */

test('classifyUsageError maps access, validation and network failures', () => {
  assert.equal(classifyUsageError({ status: 403 }), 'forbidden');
  assert.equal(classifyUsageError({ status: 404 }), 'forbidden');
  assert.equal(classifyUsageError({ status: 401 }), 'unauthorized');
  assert.equal(classifyUsageError({ status: 400 }), 'validation');
  assert.equal(classifyUsageError({ status: 0 }), 'network');
  assert.equal(classifyUsageError({ status: 500 }), 'unknown');
});

/* ==================== endpoint + page guards ==================== */

test('config exposes the four documented read-only usage endpoints', () => {
  const cfg = src('../js/config.js');
  assert.match(cfg, /usageSummary: \(orgId\) => `\/api\/organization\/orgs\/\$\{orgId\}\/usage\/summary\/`/);
  assert.match(cfg, /usageByBot: \(orgId\) => `\/api\/organization\/orgs\/\$\{orgId\}\/usage\/by-bot\/`/);
  assert.match(cfg, /usageDaily: \(orgId\) => `\/api\/organization\/orgs\/\$\{orgId\}\/usage\/daily\/`/);
  assert.match(cfg, /botUsage: \(orgId, botId\) => `\/api\/organization\/orgs\/\$\{orgId\}\/bots\/\$\{botId\}\/usage\/`/);
});

test('usage pages call GET-only usage endpoints (no invented writes)', () => {
  const page = src('../js/pages/usage.js');
  assert.match(page, /ENDPOINTS\.usageSummary/);
  assert.match(page, /ENDPOINTS\.usageDaily/);
  assert.match(page, /ENDPOINTS\.usageByBot/);
  assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)/.test(page), 'usage page must not mutate usage');
  assert.match(page, /zeroFillDaily/);
  const bot = src('../js/pages/bot-detail.js');
  assert.match(bot, /ENDPOINTS\.botUsage/);
  assert.match(bot, /zeroFillDaily/);
});

test('nav includes the usage page', () => {
  const sidebar = src('../js/components/sidebar.js');
  const topbar = src('../js/components/topbar.js');
  assert.match(sidebar, /\['usage\.html', 'Usage'/);
  assert.match(topbar, /'usage\.html': 'Usage'/);
});
