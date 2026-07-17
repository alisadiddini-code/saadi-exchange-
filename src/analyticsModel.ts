// Analytics V2 — pure derived-analysis model.
//
// Same discipline as assistantEngine.ts (Stage 7): zero React, zero
// Supabase, zero runtime import from App.tsx (type-only imports are
// erased at compile time, so no circular runtime dependency). Every
// function here is a pure function of already-filtered data the caller
// (AnalyticsView, in App.tsx) hands it — this file has no knowledge of
// dates, ranges, or which bank/company is selected; it only crunches
// numbers over the arrays it's given.
//
// Business-safety note: nothing here changes a financial formula. Net is
// always gross-minus-returns (computed by the caller exactly as before);
// currencies are never combined into one number; every ranking/insight
// operates on one currency at a time.

import type { Transfer, AppData, Currency } from './types';
import type { DateFilterMode } from './App';

function emptyCurrencyRecord(): Record<Currency, number> {
  return { USD: 0, EUR: 0, CNY: 0 };
}

function summarizeByCurrencyLocal(transfers: Transfer[]): Record<Currency, number> {
  const result = emptyCurrencyRecord();
  for (const t of transfers) result[t.currency] += t.amount;
  return result;
}

function isDateWithinRangeLocal(dateString: string, start: Date, end: Date): boolean {
  // Same comparison the app already uses (App.tsx's isDateWithinRange) —
  // duplicated here as a 3-line pure date compare rather than imported,
  // to keep this file free of runtime imports from App.tsx.
  const current = new Date(`${dateString}T00:00:00`);
  return current >= start && current <= end;
}

/** Sum returns per currency for a set of companyIds inside an optional
 *  date range. Moved here unchanged from AnalyticsView (Stage <Analytics
 *  V1). Same logic, same result — just relocated out of App.tsx. */
export function sumReturnsByCurrencyInRange(
  returnsMap: AppData['returns'],
  companyIds: string[],
  start: Date | null,
  end: Date | null
): Record<Currency, number> {
  const result = emptyCurrencyRecord();
  Object.entries(returnsMap).forEach(([dateKey, companyMap]) => {
    if (start && end && !isDateWithinRangeLocal(dateKey, start, end)) return;
    Object.entries(companyMap).forEach(([companyId, currencyMap]) => {
      if (companyIds.length && !companyIds.includes(companyId)) return;
      (Object.keys(currencyMap) as Currency[]).forEach((cur) => {
        result[cur] = (result[cur] || 0) + (currencyMap[cur] ?? 0);
      });
    });
  });
  return result;
}

export type AnalyticsTrendPoint = {
  key: string;
  label: string;
  netUsd: number; netEur: number; netCny: number;
  grossUsd: number; grossEur: number; grossCny: number;
  count: number;
};

/** Moved unchanged from AnalyticsView (renamed total*->gross* for clarity
 *  — same values, no formula change) and generalized from the removed
 *  AnalyticsPeriod type to the app-wide DateFilterMode, so the trend
 *  chart always describes the exact same range Excel/PDF/Print export. */
export function buildAnalyticsTrend(
  transfers: Transfer[],
  returnsMap: AppData['returns'],
  companyIds: string[],
  mode: DateFilterMode,
  selectedDate: string,
  helpers: {
    startOfWeek: (d: Date) => Date;
    endOfWeek: (d: Date) => Date;
    startOfMonth: (d: Date) => Date;
    endOfMonth: (d: Date) => Date;
    eachDayOfInterval: (range: { start: Date; end: Date }) => Date[];
    eachMonthOfInterval: (range: { start: Date; end: Date }) => Date[];
    format: (d: Date, fmt: string) => string;
  }
): AnalyticsTrendPoint[] {
  const { startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, eachMonthOfInterval, format } = helpers;

  if (mode === 'day') {
    const dayTransfers = transfers.filter((t) => t.date === selectedDate);
    if (!dayTransfers.length) return [];
    const buckets = new Map<number, Transfer[]>();
    dayTransfers.forEach((t) => {
      let hour = 0;
      const parsed = new Date(t.timestamp);
      if (!Number.isNaN(parsed.getTime())) hour = parsed.getHours();
      const arr = buckets.get(hour) ?? [];
      arr.push(t);
      buckets.set(hour, arr);
    });
    const usedHours = [...buckets.keys()].sort((a, b) => a - b);
    const dayD = new Date(`${selectedDate}T00:00:00`);
    const ret = sumReturnsByCurrencyInRange(returnsMap, companyIds, dayD, dayD);
    const totalCount = dayTransfers.length;
    return usedHours.map((hour) => {
      const ht = buckets.get(hour) ?? [];
      const totals = summarizeByCurrencyLocal(ht);
      const share = totalCount > 0 ? ht.length / totalCount : 0;
      return {
        label: `${String(hour).padStart(2, '0')}:00`,
        key: `h${hour}`,
        netUsd: totals.USD - ret.USD * share,
        netEur: totals.EUR - ret.EUR * share,
        netCny: totals.CNY - ret.CNY * share,
        grossUsd: totals.USD,
        grossEur: totals.EUR,
        grossCny: totals.CNY,
        count: ht.length,
      };
    });
  }

  if (mode === 'all') {
    if (!transfers.length) return [];
    const allDates = [...new Set(transfers.map((t) => t.date))].sort();
    const firstMonth = startOfMonth(new Date(`${allDates[0]}T00:00:00`));
    const months = eachMonthOfInterval({ start: firstMonth, end: endOfMonth(new Date()) });
    return months.map((monthStart) => {
      const end = endOfMonth(monthStart);
      const mt = transfers.filter((t) => isDateWithinRangeLocal(t.date, monthStart, end));
      const totals = summarizeByCurrencyLocal(mt);
      const ret = sumReturnsByCurrencyInRange(returnsMap, companyIds, monthStart, end);
      return {
        label: format(monthStart, 'MM.yy'),
        key: format(monthStart, 'yyyy-MM'),
        netUsd: totals.USD - ret.USD,
        netEur: totals.EUR - ret.EUR,
        netCny: totals.CNY - ret.CNY,
        grossUsd: totals.USD,
        grossEur: totals.EUR,
        grossCny: totals.CNY,
        count: mt.length,
      };
    });
  }

  const d = new Date(`${selectedDate}T00:00:00`);
  const range = mode === 'week'
    ? { start: startOfWeek(d), end: endOfWeek(d) }
    : { start: startOfMonth(d), end: endOfMonth(d) };
  const days = eachDayOfInterval(range);
  const labelFmt = mode === 'month' ? 'dd' : 'dd.MM';

  return days.map((day) => {
    const key = format(day, 'yyyy-MM-dd');
    const dayD = new Date(`${key}T00:00:00`);
    const dt = transfers.filter((t) => t.date === key);
    const totals = summarizeByCurrencyLocal(dt);
    const ret = sumReturnsByCurrencyInRange(returnsMap, companyIds, dayD, dayD);
    return {
      label: format(day, labelFmt),
      key,
      netUsd: totals.USD - ret.USD,
      netEur: totals.EUR - ret.EUR,
      netCny: totals.CNY - ret.CNY,
      grossUsd: totals.USD,
      grossEur: totals.EUR,
      grossCny: totals.CNY,
      count: dt.length,
    };
  });
}

// ── Period comparison (section 6) ──────────────────────────────────────
export type PeriodComparisonRow = {
  currency: Currency;
  currentValue: number;
  previousValue: number | null;
  absoluteChange: number | null;
  /** null exactly when a percentage would be misleading: no comparable
   *  previous period, or previous value is zero. */
  percentChange: number | null;
  direction: 'up' | 'down' | 'flat' | 'unavailable';
};

export function buildPeriodComparison(
  currentNet: Record<Currency, number>,
  previousNet: Record<Currency, number> | null,
  activeCurrencies: Currency[]
): PeriodComparisonRow[] {
  return activeCurrencies.map((currency): PeriodComparisonRow => {
    const currentValue = currentNet[currency];
    if (!previousNet) {
      return { currency, currentValue, previousValue: null, absoluteChange: null, percentChange: null, direction: 'unavailable' };
    }
    const previousValue = previousNet[currency];
    const absoluteChange = currentValue - previousValue;
    const percentChange = previousValue !== 0 ? (absoluteChange / Math.abs(previousValue)) * 100 : null;
    const direction: PeriodComparisonRow['direction'] = absoluteChange > 0 ? 'up' : absoluteChange < 0 ? 'down' : 'flat';
    return { currency, currentValue, previousValue, absoluteChange, percentChange, direction };
  });
}

// ── Company distribution (section 7) ───────────────────────────────────
export type DistributionRow = { name: string; value: number; pct: number; count: number; returned: number };
export type CompanyDistribution = {
  rows: DistributionRow[];
  others: { count: number; value: number; pct: number } | null;
  total: number;
};

/** Ranks by ONE currency's value only — caller picks which currency's
 *  field (`value`) to pass in per company. Never combines currencies. */
export function buildCompanyDistribution(
  companies: { name: string; value: number; count: number; returned: number }[],
  topN = 5
): CompanyDistribution {
  const sorted = [...companies].filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, c) => sum + c.value, 0);
  if (total <= 0) return { rows: [], others: null, total: 0 };

  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);

  const rows: DistributionRow[] = top.map((c) => ({
    name: c.name,
    value: c.value,
    count: c.count,
    returned: c.returned,
    pct: (c.value / total) * 100,
  }));

  const others = rest.length > 0
    ? {
        count: rest.reduce((s, c) => s + c.count, 0),
        value: rest.reduce((s, c) => s + c.value, 0),
        pct: (rest.reduce((s, c) => s + c.value, 0) / total) * 100,
      }
    : null;

  return { rows, others, total };
}

// ── Deterministic insights (section 10) ────────────────────────────────
export type AnalyticsInsight = { id: string; text: string };

export type InsightCompanyRow = {
  name: string;
  count: number;
  net: number;
  returned: number;
};

/** Every insight names the currency it's about — never mixes currencies,
 *  never predicts, never advises. Skips a rule entirely when its
 *  precondition doesn't hold (fewer than 5 is honest; padding with a
 *  filler insight would not be). */
export function buildAnalyticsInsights(params: {
  currency: Currency;
  companyRows: InsightCompanyRow[];
  trend: AnalyticsTrendPoint[];
  grossByCurrency: Record<Currency, number>;
  returnsByCurrency: Record<Currency, number>;
  periodLabel: string;
  currencySymbol: (c: Currency) => string;
  formatAmount: (value: number) => string;
}): AnalyticsInsight[] {
  const { currency, companyRows, trend, grossByCurrency, returnsByCurrency, periodLabel, currencySymbol, formatAmount } = params;
  const insights: AnalyticsInsight[] = [];
  const sym = currencySymbol(currency);
  const fmt = (v: number) => `${sym}${formatAmount(v)}`;

  if (companyRows.length > 0) {
    const topNet = [...companyRows].sort((a, b) => b.net - a.net)[0];
    if (topNet.net > 0) {
      insights.push({
        id: 'top-net',
        text: `«${topNet.name}» дорои калонтарин маблағи софи ${currency} дар ${periodLabel} аст: ${fmt(topNet.net)}.`,
      });
    }
  }

  const withReturns = companyRows.filter((c) => c.returned > 0);
  if (withReturns.length > 0) {
    const topReturn = [...withReturns].sort((a, b) => b.returned - a.returned)[0];
    insights.push({
      id: 'top-return',
      text: `«${topReturn.name}» дорои калонтарин маблағи баргаштаи ${currency} аст: ${fmt(topReturn.returned)}.`,
    });
  }

  if (companyRows.length > 0) {
    const mostActive = [...companyRows].sort((a, b) => b.count - a.count)[0];
    if (mostActive.count > 0) {
      insights.push({
        id: 'most-active',
        text: `«${mostActive.name}» бо ${mostActive.count} гузариш фаъолтарин ширкат аз рӯйи шумора аст.`,
      });
    }
  }

  if (trend.length > 1) {
    const netKey = currency === 'USD' ? 'netUsd' : currency === 'EUR' ? 'netEur' : 'netCny';
    const strongest = [...trend].sort((a, b) => b[netKey] - a[netKey])[0];
    if (strongest[netKey] > 0) {
      insights.push({
        id: 'strongest-period',
        text: `Давраи «${strongest.label}» бо софи ${fmt(strongest[netKey])} пурқувваттарин давра аз рӯйи ${currency} аст.`,
      });
    }
  }

  const inactiveCurrencies = (['USD', 'EUR', 'CNY'] as Currency[]).filter(
    (cur) => grossByCurrency[cur] === 0 && returnsByCurrency[cur] === 0
  );
  if (inactiveCurrencies.length > 0 && inactiveCurrencies.length < 3) {
    insights.push({
      id: 'inactive-currency',
      text: `${inactiveCurrencies.join(', ')} дар ${periodLabel} ягон фаъолият надорад.`,
    });
  }

  return insights.slice(0, 5);
}
