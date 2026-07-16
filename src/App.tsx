import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Plus,
  Building2,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  TrendingUp,
  ArrowDownCircle,
  Trash2,
  BarChart3,
  Pencil,
  Save,
  X,
  Search,
  Filter,
  FileSpreadsheet,
  FileText,
  ArrowUpDown,
  Printer,
  Check,
  Receipt,
  Send,
  Sun,
  Moon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Landmark,
  Zap,
  Lightbulb,
  RotateCcw,
  Users
} from 'lucide-react';
import {
  format,
  parseISO,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  eachMonthOfInterval
} from 'date-fns';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { AppData, Bank, ClientMessage, Company, Currency, ServerMessage, Transfer } from './types';
import { cn } from './lib/utils';
import { supabase } from './lib/supabase';

type ViewMode = 'tracker' | 'analytics';
type DateFilterMode = 'day' | 'week' | 'month' | 'all';
type CompanySortMode =
  | 'manual'
  | 'name-asc'
  | 'name-desc'
  | 'net-desc'
  | 'net-asc'
  | 'count-desc'
  | 'count-asc';

function isDateWithinRange(dateString: string, start: Date, end: Date) {
  const current = parseISO(`${dateString}T00:00:00`);
  return current >= start && current <= end;
}

function getStoredString(key: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  return localStorage.getItem(key) || fallback;
}

function getActiveRange(selectedDate: string, filterMode: DateFilterMode) {
  const selectedDateObj = parseISO(`${selectedDate}T00:00:00`);

  if (filterMode === 'all') return null;

  if (filterMode === 'day') {
    return { start: selectedDateObj, end: selectedDateObj };
  }

  if (filterMode === 'week') {
    return {
      start: startOfWeek(selectedDateObj, { weekStartsOn: 1 }),
      end: endOfWeek(selectedDateObj, { weekStartsOn: 1 }),
    };
  }

  return {
    start: startOfMonth(selectedDateObj),
    end: endOfMonth(selectedDateObj),
  };
}

function currencySymbol(currency: Currency) {
  if (currency === 'CNY') return '¥';
  if (currency === 'EUR') return '€';
  return '$';
}

// Pure display derivation from the existing confirmation booleans — no new
// data, nothing persisted. Consistent status color semantics used across
// the app: green = done, amber = waiting, blue = in progress.
type TransferStatus = 'complete' | 'in-progress' | 'waiting';

function getTransferStatus(t: Pick<Transfer, 'preparedConfirmed' | 'invoiceConfirmed' | 'swiftConfirmed'>): TransferStatus {
  const confirmedCount = [t.preparedConfirmed, t.invoiceConfirmed, t.swiftConfirmed].filter(Boolean).length;
  if (confirmedCount === 3) return 'complete';
  if (confirmedCount === 0) return 'waiting';
  return 'in-progress';
}

const TRANSFER_STATUS_LABEL: Record<TransferStatus, string> = {
  complete: 'Анҷом ёфт',
  'in-progress': 'Дар ҷараён',
  waiting: 'Дар интизор',
};

const TRANSFER_STATUS_CLASS: Record<TransferStatus, string> = {
  complete: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
  'in-progress': 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
  waiting: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
};

// ── Currency identity (section 5) ──────────────────────────────────────
// Single source of truth for USD/EUR/CNY color roles — previously this
// existed as three near-identical-but-independent definitions (this
// constant, AnalyticsView's local `colorMap`, and an inline ternary on
// the transfer-row currency badge that had no dark-mode variants at all).
// All three now read from here, so a future palette change is one edit.
// Emerald is reserved as the *brand* color; USD deliberately also reads
// emerald since it's this operation's primary currency, not because
// "USD = brand" — EUR/CNY get their own distinct, professional hues so
// currencies stay visually separable without turning the page multicolor.
const CURRENCY_COLOR_MAP: Record<Currency, { text: string; bg: string; badge: string; btnActive: string }> = {
  USD: {
    text: 'text-emerald-700 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400',
    btnActive: 'bg-emerald-500 text-white',
  },
  EUR: {
    text: 'text-blue-700 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400',
    btnActive: 'bg-blue-500 text-white',
  },
  CNY: {
    text: 'text-yellow-700 dark:text-yellow-400',
    bg: 'bg-yellow-50 dark:bg-yellow-950/40',
    badge: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400',
    btnActive: 'bg-yellow-500 text-white',
  },
};

// ── Command Center: a single derived operational summary ──────────────────
// Pure read-only aggregation over already-loaded data (data.transfers,
// data.banks, data.companies, data.returns) for the currently selected day.
// Nothing here is persisted, nothing here is new stored state, and this
// function does not call Supabase — it is exactly one pass over that day's
// transfers, computed once per (data, selectedDate) change via useMemo at
// the call site.
type CommandCenterBankRow = {
  bankId: string;
  bankName: string;
  count: number;
  totalsByCurrency: Record<Currency, number>;
  incompleteCount: number;
  completionPct: number;
  // Stage 5.1 additions — same per-transfer loop, three more counters per
  // bank instead of one.
  completeCount: number;
  notSent: number;
  missingInvoice: number;
  missingSwift: number;
  /** Tajik label naming whichever of notSent/missingInvoice/missingSwift is
   *  this bank's largest single unresolved reason. Null when the bank has
   *  no incomplete transfers at all — a fact, not a judgment call. */
  primaryUnresolvedReason: string | null;
};

type CommandCenterCompanyRow = {
  companyId: string;
  companyName: string;
  bankId: string;
  bankName: string;
  transferCount: number;
  pendingCount: number;
  missingSwift: number;
  missingInvoice: number;
  notSent: number;
  hasReturnIssue: boolean;
};

/** One row per active currency — a reshape of the parallel *ByCurrency
 *  records above into a single array, so a new currency-summary UI reads
 *  one list instead of five separate Records. No new scan: same values,
 *  different shape. */
type CommandCenterCurrencyRow = {
  currency: Currency;
  total: number;
  returned: number;
  net: number;
  count: number;
  incomplete: number;
};

type CommandCenterSummary = {
  date: string;
  totalTransfers: number;
  // Stage 5.1: named explicitly rather than left as "pipeline.complete" /
  // "totalTransfers - pipeline.complete" at every call site.
  fullyCompletedTransfers: number;
  incompleteTransfers: number;
  completionPercentage: number;
  totalsByCurrency: Record<Currency, number>;
  returnsByCurrency: Record<Currency, number>;
  netByCurrency: Record<Currency, number>;
  countByCurrency: Record<Currency, number>;
  incompleteByCurrency: Record<Currency, number>;
  activeCurrencies: Currency[];
  currencySummaries: CommandCenterCurrencyRow[];
  pipeline: { total: number; sentToBank: number; invoiceReceived: number; swiftReceived: number; complete: number };
  unresolved: { notSent: number; missingInvoice: number; missingSwift: number };
  /** Distinct companies with a non-zero returned-money record on this date.
   *  Named per the brief's "transfersWithReturnsCount", but documented
   *  precisely here because returns in this data model are per
   *  (company, date, currency), not per individual transfer — there is no
   *  transfer-level "hasReturn" field to count against. This counts
   *  company+currency return records, i.e. how many distinct companies
   *  have a return the operator should see, which is what the Needs
   *  Attention / insights UI actually needs. */
  transfersWithReturnsCount: number;
  companiesWithMultipleIncomplete: number;
  bankWorkload: CommandCenterBankRow[];
  companyAttention: CommandCenterCompanyRow[];
  activityByHour: { label: string; value: number }[];
};

function buildCommandCenterSummary(data: AppData, selectedDate: string): CommandCenterSummary {
  const todayTransfers = data.transfers.filter((t) => t.date === selectedDate);

  const totalsByCurrency: Record<Currency, number> = { USD: 0, EUR: 0, CNY: 0 };
  const countByCurrency: Record<Currency, number> = { USD: 0, EUR: 0, CNY: 0 };
  const incompleteByCurrency: Record<Currency, number> = { USD: 0, EUR: 0, CNY: 0 };

  let sentToBank = 0;
  let invoiceReceived = 0;
  let swiftReceived = 0;
  let complete = 0;
  let notSent = 0;
  let missingInvoice = 0;
  let missingSwift = 0;

  const byHour = new Map<string, number>();
  const bankMap = new Map<string, CommandCenterBankRow>();
  const companyMap = new Map<string, CommandCenterCompanyRow>();

  for (const t of todayTransfers) {
    totalsByCurrency[t.currency] += t.amount;
    countByCurrency[t.currency] += 1;

    const isComplete = t.preparedConfirmed && t.invoiceConfirmed && t.swiftConfirmed;
    if (t.preparedConfirmed) sentToBank += 1; else notSent += 1;
    if (t.invoiceConfirmed) invoiceReceived += 1; else missingInvoice += 1;
    if (t.swiftConfirmed) swiftReceived += 1; else missingSwift += 1;
    if (isComplete) complete += 1; else incompleteByCurrency[t.currency] += 1;

    let hourLabel = '—';
    try {
      hourLabel = format(parseISO(t.timestamp), 'HH:00');
    } catch {
      // malformed timestamp on old data — skip bucketing this one, don't crash the summary
    }
    if (hourLabel !== '—') {
      byHour.set(hourLabel, (byHour.get(hourLabel) ?? 0) + 1);
    }

    const bank = data.banks.find((b) => b.id === t.bankId);
    if (!bankMap.has(t.bankId)) {
      bankMap.set(t.bankId, {
        bankId: t.bankId,
        bankName: bank?.name ?? '—',
        count: 0,
        totalsByCurrency: { USD: 0, EUR: 0, CNY: 0 },
        incompleteCount: 0,
        completionPct: 100,
        completeCount: 0,
        notSent: 0,
        missingInvoice: 0,
        missingSwift: 0,
        primaryUnresolvedReason: null,
      });
    }
    const bankRow = bankMap.get(t.bankId)!;
    bankRow.count += 1;
    bankRow.totalsByCurrency[t.currency] += t.amount;
    if (isComplete) bankRow.completeCount += 1; else bankRow.incompleteCount += 1;
    if (!t.preparedConfirmed) bankRow.notSent += 1;
    if (!t.invoiceConfirmed) bankRow.missingInvoice += 1;
    if (!t.swiftConfirmed) bankRow.missingSwift += 1;

    const company = data.companies.find((c) => c.id === t.companyId);
    if (!companyMap.has(t.companyId)) {
      companyMap.set(t.companyId, {
        companyId: t.companyId,
        companyName: company?.name ?? '—',
        bankId: t.bankId,
        bankName: bank?.name ?? '—',
        transferCount: 0,
        pendingCount: 0,
        missingSwift: 0,
        missingInvoice: 0,
        notSent: 0,
        hasReturnIssue: false,
      });
    }
    const companyRow = companyMap.get(t.companyId)!;
    companyRow.transferCount += 1;
    if (!isComplete) companyRow.pendingCount += 1;
    if (!t.swiftConfirmed) companyRow.missingSwift += 1;
    if (!t.invoiceConfirmed) companyRow.missingInvoice += 1;
    if (!t.preparedConfirmed) companyRow.notSent += 1;
  }

  const returnsByCurrency: Record<Currency, number> = { USD: 0, EUR: 0, CNY: 0 };
  const dayReturns = data.returns[selectedDate] || {};
  Object.entries(dayReturns).forEach(([companyId, currencyMap]) => {
    (Object.keys(currencyMap) as Currency[]).forEach((cur) => {
      returnsByCurrency[cur] += currencyMap[cur] ?? 0;
    });
    const companyRow = companyMap.get(companyId);
    if (companyRow && Object.values(currencyMap).some((v) => (v ?? 0) > 0)) {
      companyRow.hasReturnIssue = true;
    }
  });

  const netByCurrency: Record<Currency, number> = {
    USD: totalsByCurrency.USD - returnsByCurrency.USD,
    EUR: totalsByCurrency.EUR - returnsByCurrency.EUR,
    CNY: totalsByCurrency.CNY - returnsByCurrency.CNY,
  };

  const activeCurrencies = (['USD', 'EUR', 'CNY'] as Currency[]).filter(
    (cur) => totalsByCurrency[cur] > 0 || returnsByCurrency[cur] > 0
  );

  const bankWorkload = Array.from(bankMap.values())
    .map((b) => {
      // Factual, not judgment-based: whichever unresolved count is
      // largest for this bank, named directly. No "healthy"/"problematic"
      // label — section 6 explicitly forbids that.
      let primaryUnresolvedReason: string | null = null;
      if (b.incompleteCount > 0) {
        const reasons: [number, string][] = [
          [b.notSent, 'Ба бонк фиристода нашуд'],
          [b.missingInvoice, 'Фактура нарасидааст'],
          [b.missingSwift, 'SWIFT нарасидааст'],
        ];
        reasons.sort((x, y) => y[0] - x[0]);
        if (reasons[0][0] > 0) primaryUnresolvedReason = reasons[0][1];
      }
      return {
        ...b,
        completionPct: b.count > 0 ? Math.round((b.completeCount / b.count) * 100) : 100,
        primaryUnresolvedReason,
      };
    })
    .sort((a, b) => b.count - a.count);

  const allCompanyRows = Array.from(companyMap.values());
  const companyAttention = allCompanyRows
    .filter((c) => c.pendingCount > 0 || c.hasReturnIssue)
    .sort((a, b) => (b.missingSwift + b.missingInvoice + b.notSent) - (a.missingSwift + a.missingInvoice + a.notSent))
    .slice(0, 6);

  // See CommandCenterSummary.transfersWithReturnsCount doc comment — this
  // counts companies with a return record, not individual transfers.
  const transfersWithReturnsCount = allCompanyRows.filter((c) => c.hasReturnIssue).length;
  const companiesWithMultipleIncomplete = allCompanyRows.filter((c) => c.pendingCount > 1).length;

  const currencySummaries: CommandCenterCurrencyRow[] = activeCurrencies.map((cur) => ({
    currency: cur,
    total: totalsByCurrency[cur],
    returned: returnsByCurrency[cur],
    net: netByCurrency[cur],
    count: countByCurrency[cur],
    incomplete: incompleteByCurrency[cur],
  }));

  const activityByHour = Array.from(byHour.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));

  return {
    date: selectedDate,
    totalTransfers: todayTransfers.length,
    fullyCompletedTransfers: complete,
    incompleteTransfers: todayTransfers.length - complete,
    completionPercentage: todayTransfers.length > 0 ? Math.round((complete / todayTransfers.length) * 100) : 100,
    totalsByCurrency,
    returnsByCurrency,
    netByCurrency,
    countByCurrency,
    incompleteByCurrency,
    activeCurrencies,
    currencySummaries,
    pipeline: { total: todayTransfers.length, sentToBank, invoiceReceived, swiftReceived, complete },
    unresolved: { notSent, missingInvoice, missingSwift },
    transfersWithReturnsCount,
    companiesWithMultipleIncomplete,
    bankWorkload,
    companyAttention,
    activityByHour,
  };
}

// ── Rule-based operational insights (section 7) ────────────────────────
// Deterministic, inspectable if/else rules over `summary` — not AI, no
// prediction, no hidden scoring. Every sentence traces to a field already
// documented on CommandCenterSummary. Capped at 5, ordered so unresolved
// facts surface before all-clear facts.
function buildOperationalInsights(summary: CommandCenterSummary): string[] {
  const insights: string[] = [];

  if (summary.totalTransfers === 0) return insights;

  if (summary.unresolved.notSent > 0) {
    insights.push(`${summary.unresolved.notSent} гузариш то ҳол ба бонк фиристода нашудааст.`);
  }

  const bankWithMostMissingInvoice = [...summary.bankWorkload].sort((a, b) => b.missingInvoice - a.missingInvoice)[0];
  if (bankWithMostMissingInvoice && bankWithMostMissingInvoice.missingInvoice > 0) {
    insights.push(`«${bankWithMostMissingInvoice.bankName}» ${bankWithMostMissingInvoice.missingInvoice} гузариши интизори фактура дорад.`);
  }

  const companyWithMostIncomplete = summary.companyAttention[0];
  if (companyWithMostIncomplete && companyWithMostIncomplete.pendingCount > 0) {
    insights.push(`«${companyWithMostIncomplete.companyName}» бештарин гузаришҳои нопурраро дорад (${companyWithMostIncomplete.pendingCount}).`);
  }

  if (summary.transfersWithReturnsCount > 0) {
    insights.push(`Барои ${summary.transfersWithReturnsCount} ширкат маблағи баргашта сабт шудааст.`);
  }

  if (summary.unresolved.missingSwift === 0 && summary.totalTransfers > 0) {
    insights.push('Ҳамаи тасдиқҳои SWIFT гирифта шудаанд.');
  }

  if (summary.completionPercentage === 100 && insights.length < 5) {
    insights.push('Ҳамаи амалиёти санаи интихобшуда анҷом ёфтааст.');
  }

  return insights.slice(0, 5);
}

function transferMatchesSearch(transfer: Transfer, searchQuery: string, companyName?: string) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;

  const amountText = String(transfer.amount).toLowerCase();
  const noteText = (transfer.note || '').toLowerCase();
  const timeText = format(parseISO(transfer.timestamp), 'HH:mm').toLowerCase();
  const dateText = transfer.date.toLowerCase();
  const currencyText = transfer.currency.toLowerCase();
  const companyText = (companyName || '').toLowerCase();

  return (
    amountText.includes(query) ||
    noteText.includes(query) ||
    timeText.includes(query) ||
    dateText.includes(query) ||
    currencyText.includes(query) ||
    companyText.includes(query)
  );
}

function formatRangeLabel(selectedDate: string, filterMode: DateFilterMode) {
  const d = parseISO(`${selectedDate}T00:00:00`);

  if (filterMode === 'day') return format(d, 'dd.MM.yyyy');
  if (filterMode === 'week') return `Ҳафта аз ${format(startOfWeek(d, { weekStartsOn: 1 }), 'dd.MM.yyyy')}`;
  if (filterMode === 'month') return format(d, 'MM.yyyy');
  return 'Ҳама давра';
}

function tajikRangeLabel(filterMode: DateFilterMode) {
  if (filterMode === 'day') return 'Рӯз';
  if (filterMode === 'week') return 'Ҳафта';
  if (filterMode === 'month') return 'Моҳ';
  return 'Ҳама';
}

function numberFormat(value: number) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatCurrency(value: number, currency: Currency) {
  return `${currencySymbol(currency)}${numberFormat(value)}`;
}

function summarizeByCurrency(transfers: Transfer[]) {
  return transfers.reduce(
    (acc, t) => {
      acc[t.currency] += t.amount;
      return acc;
    },
    { USD: 0, EUR: 0, CNY: 0 } as Record<Currency, number>
  );
}

function normalizeCurrency(value: unknown): Currency {
  if (value === 'CNY') return 'CNY';
  if (value === 'EUR') return 'EUR';
  return 'USD';
}

function normalizeDate(value: unknown, fallback: string) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }

  return fallback;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value;
  return new Date().toISOString();
}

function mapSupabaseTransfer(row: any, fallbackDate: string): Transfer {
  const date = normalizeDate(row?.transfer_date || row?.date, fallbackDate);
  const timestamp = normalizeTimestamp(row?.created_at || row?.timestamp);

  return {
    id: String(row?.id),
    companyId: String(row?.company_id),
    bankId: String(row?.bank_id),
    amount: Number(row?.amount) || 0,
    currency: normalizeCurrency(row?.currency),
    note: row?.note && row.note !== 'EMPTY' ? String(row.note) : '',
    date,
    timestamp,
    preparedConfirmed: Boolean(row?.prepared_confirmed),
    invoiceConfirmed: Boolean(row?.invoice_confirmed),
    swiftConfirmed: Boolean(row?.swift_confirmed),
  };
}

function mergeTransfer(list: Transfer[], transfer: Transfer) {
  const exists = list.some((item) => item.id === transfer.id);
  if (exists) {
    return list.map((item) => (item.id === transfer.id ? transfer : item));
  }

  return [...list, transfer];
}

function sortTransfersByTime(transfers: Transfer[]) {
  return [...transfers].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return parseISO(a.timestamp).getTime() - parseISO(b.timestamp).getTime();
  });
}


async function fetchAllSupabaseRows<T = any>(
  tableName: string,
  options?: {
    orderBy?: string;
    ascending?: boolean;
    secondOrderBy?: string;
    secondAscending?: boolean;
  }
): Promise<{ data: T[]; error: any }> {
  const pageSize = 1000;
  let from = 0;
  const allRows: T[] = [];

  while (true) {
    let query = supabase
      .from(tableName)
      .select('*')
      .range(from, from + pageSize - 1);

    if (options?.orderBy) {
      query = query.order(options.orderBy, { ascending: options.ascending ?? true });
    }

    if (options?.secondOrderBy) {
      query = query.order(options.secondOrderBy, { ascending: options.secondAscending ?? true });
    }

    const { data, error } = await query;

    if (error) {
      return { data: allRows, error };
    }

    const rows = (data || []) as T[];
    allRows.push(...rows);

    if (rows.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return { data: allRows, error: null };
}

function buildDailySeries(
  transfers: Transfer[],
  returnsMap: AppData['returns'],
  companyIds: string[],
  start: Date,
  end: Date
) {
  const days = eachDayOfInterval({ start, end });

  return days.map((day) => {
    const key = format(day, 'yyyy-MM-dd');
    const dayTransfers = transfers.filter((t) => t.date === key);
    const totals = summarizeByCurrency(dayTransfers);

    const returned = Object.entries(returnsMap[key] || {}).reduce((sum, [companyId, currencyMap]) => {
      if (!companyIds.includes(companyId)) return sum;
      return sum + (currencyMap.USD ?? 0);
    }, 0);

    return {
      key,
      label: format(day, 'dd.MM'),
      totalUsd: totals.USD,
      totalEur: totals.EUR,
      totalCny: totals.CNY,
      returned,
      netUsd: totals.USD - returned
    };
  });
}

function SmallBarChart({
  title,
  data,
  colorClass = 'bg-emerald-500'
}: {
  title: string;
  data: { label: string; value: number }[];
  colorClass?: string;
}) {
  const maxValue = Math.max(...data.map((item) => item.value), 1);

  return (
    <div className="glass-panel rounded-2xl border border-line shadow-sm p-5 overflow-hidden">
      <div className="text-lg font-bold text-ink mb-4">{title}</div>

      <div className="h-64 flex items-end gap-3">
        {data.map((item) => {
          const height = Math.max((item.value / maxValue) * 100, item.value > 0 ? 6 : 0);

          return (
            <div key={item.label} className="bar-tooltip-anchor flex-1 min-w-0 flex flex-col items-center justify-end gap-2">
              <div className="money text-[10px] text-ink-muted font-mono truncate max-w-full">
                {item.value > 0 ? numberFormat(item.value) : ''}
              </div>
              <div className="relative w-full h-44 flex items-end">
                {/* faint reference gridlines at 25/50/75% */}
                <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                  <div className="border-t border-line" />
                  <div className="border-t border-line" />
                  <div className="border-t border-line" />
                  <div className="border-t border-line" />
                </div>
                <div
                  className={cn('bar-reveal relative w-full rounded-t-xl transition-all', colorClass)}
                  style={{ height: `${height}%` }}
                  title={`${item.label}: ${numberFormat(item.value)}`}
                />
                <div className="bar-tooltip absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink text-surface-1 text-[10px] font-mono px-2 py-1 shadow-lg z-10">
                  {item.label}: {numberFormat(item.value)}
                </div>
              </div>
              <div className="text-[11px] text-ink-muted">{item.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const DONUT_COLORS = ['#10b981', '#38bdf8', '#f59e0b', '#94a3b8', '#fb7185', '#2dd4bf', '#c4b5fd', '#facc15'];

function DonutChart({
  title,
  data,
}: {
  title: string;
  data: { label: string; value: number }[];
}) {
  const filtered = data.filter((d) => d.value > 0).slice(0, 8);
  const total = filtered.reduce((sum, d) => sum + d.value, 0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!filtered.length || total <= 0) {
    return null;
  }

  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offsetAcc = 0;

  return (
    <div className="glass-panel rounded-2xl border border-line shadow-sm p-5 overflow-hidden">
      <div className="text-lg font-bold text-ink mb-4">{title}</div>
      <div className="flex flex-col sm:flex-row items-center gap-6">
        <svg viewBox="0 0 100 100" className="w-40 h-40 shrink-0 -rotate-90">
          <circle cx="50" cy="50" r={radius} fill="none" className="stroke-line" strokeWidth="14" />
          {filtered.map((item, i) => {
            const fraction = item.value / total;
            const dash = fraction * circumference;
            const gap = circumference - dash;
            const dashoffset = -offsetAcc;
            offsetAcc += dash;
            const isHovered = hoveredIndex === i;
            const isDimmed = hoveredIndex !== null && !isHovered;
            return (
              <circle
                key={item.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
                strokeWidth={isHovered ? 17 : 14}
                strokeOpacity={isDimmed ? 0.35 : 1}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={dashoffset}
                className="donut-segment"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <title>{`${item.label}: ${numberFormat(item.value)} (${Math.round(fraction * 100)}%)`}</title>
              </circle>
            );
          })}
        </svg>
        <div className="flex-1 min-w-0 w-full space-y-1">
          {filtered.map((item, i) => {
            const isHovered = hoveredIndex === i;
            const isDimmed = hoveredIndex !== null && !isHovered;
            return (
              <div
                key={item.label}
                className={cn(
                  'flex items-center gap-2 text-sm rounded-lg px-2 py-1.5 -mx-2 transition-all cursor-default',
                  isHovered ? 'bg-black/[0.04] dark:bg-white/[0.06]' : 'bg-transparent',
                  isDimmed && 'opacity-50'
                )}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
                />
                <span className="text-ink truncate flex-1">{item.label}</span>
                <span className="text-ink-muted text-xs shrink-0">{Math.round((item.value / total) * 100)}%</span>
                <span className="money font-mono font-semibold text-ink text-xs shrink-0">{numberFormat(item.value)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const AVATAR_COLORS = [
  'bg-emerald-500', 'bg-blue-500', 'bg-amber-500', 'bg-violet-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-orange-500', 'bg-teal-500',
];

function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function CompanyAvatar({ name, selected }: { name: string; selected?: boolean }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow-sm',
        selected ? 'bg-white/25 ring-1 ring-white/40' : avatarColorFor(name)
      )}
    >
      {initial}
    </div>
  );
}

function SkeletonBlock() {
  return (
    <div className="flex flex-col md:flex-row gap-6 items-start">
      <div className="w-full md:w-64 shrink-0 glass-panel rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-3 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-xl shimmer" />
        ))}
      </div>
      <div className="flex-1 min-w-0 w-full glass-panel rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 space-y-3">
        <div className="h-6 w-40 rounded-lg shimmer" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-10 rounded-lg shimmer" />
        ))}
      </div>
    </div>
  );
}

function RotatingShowcase() {
  return (
    <div className="hidden 2xl:block fixed left-2 top-1/2 -translate-y-1/2 z-30 w-[26rem] pointer-events-none select-none character-float">
      <video
        src="/character-rotate-v2.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-auto block drop-shadow-2xl"
      />
    </div>
  );
}

function CoinLogo() {
  const [imgFailed, setImgFailed] = useState(false);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const prefersReducedMotion = useReducedMotion();
  const logoRef = useRef<HTMLDivElement | null>(null);

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = logoRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: py * -10, y: px * 10 });
  };
  const handleLeave = () => setTilt({ x: 0, y: 0 });

  return (
    <div className="coin-spin-wrap shrink-0">
      <div
        ref={logoRef}
        onMouseMove={prefersReducedMotion ? undefined : handleMove}
        onMouseLeave={prefersReducedMotion ? undefined : handleLeave}
        style={prefersReducedMotion ? undefined : { transform: `perspective(300px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
        className={cn(
          'logo-tilt w-11 h-11 rounded-full ring-2 ring-brand-green/40 shadow-[var(--shadow-glow)] overflow-hidden bg-gradient-to-br from-brand-green to-brand-green-dark flex items-center justify-center',
          !prefersReducedMotion && 'logo-idle'
        )}
      >
        {!imgFailed ? (
          <img
            src="/coin-logo.png"
            alt="Saadi Exchange"
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="text-white font-bold text-lg">S</span>
        )}
      </div>
    </div>
  );
}

// ── Command Center ─────────────────────────────────────────────────────────
// The compact operational-overview strip shown above the tracker's bank
// tabs. Everything here is read-only presentation over `summary`
// (buildCommandCenterSummary output) — no Supabase calls, no new stored
// state, no changes to the confirmation/return/filter logic it summarizes.
function AttentionTile({
  icon: Icon,
  label,
  count,
  onClick,
  isActive = false,
}: {
  icon: typeof Send;
  label: string;
  count: number;
  onClick: () => void;
  isActive?: boolean;
}) {
  const isClear = count === 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isClear}
      aria-pressed={isActive}
      className={cn(
        'elevation-2 flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors card-hover',
        isClear
          ? 'bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 cursor-default'
          : isActive
            ? 'bg-amber-100 dark:bg-amber-500/20 border border-amber-400 dark:border-amber-500/50 cursor-pointer shadow-[0_0_0_2px_rgba(245,158,11,0.25),0_0_18px_-6px_rgba(245,158,11,0.6)]'
            : 'bg-amber-50 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/35 hover:bg-amber-100 dark:hover:bg-amber-500/15 cursor-pointer shadow-[0_0_0_1px_rgba(245,158,11,0.12),0_0_18px_-8px_rgba(245,158,11,0.5)]'
      )}
    >
      <div
        className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
          isClear ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
        )}
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div
          className={cn(
            'status-chip money text-xl font-extrabold font-mono leading-none',
            isClear ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
          )}
        >
          {count}
        </div>
        <div className="text-[11px] text-ink-muted mt-1 truncate">{label}</div>
      </div>
    </button>
  );
}

/** Compact SVG progress ring (section 2). Plays one <=220ms fill reveal on
 *  mount via Motion's initial/animate (which only fires once per mount —
 *  App() renders once per page load, so this can't replay on a data
 *  refresh); subsequent percentage changes interpolate smoothly rather
 *  than "replaying". No number-counting animation — the percentage text
 *  itself renders immediately and statically. */
function WorkflowProgressRing({
  percentage,
  prefersReducedMotion,
}: {
  percentage: number;
  prefersReducedMotion: boolean;
}) {
  const size = 44;
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.max(0, Math.min(100, percentage)) / 100) * circumference;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 shrink-0" role="presentation">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-line" />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        stroke="var(--saadi-primary)"
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: prefersReducedMotion ? offset : circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: 'easeOut' }}
      />
    </svg>
  );
}

/** Factual bank status label (section 6) — no "healthy"/"problematic"
 *  judgment, just what the confirmation data actually shows. */
function bankStatusLabel(b: CommandCenterBankRow): { text: string; tone: 'success' | 'warning' } {
  if (b.incompleteCount === 0) return { text: 'Анҷом ёфт', tone: 'success' };
  return { text: 'Ниёз ба таваҷҷуҳ', tone: 'warning' };
}

type AttentionKind = 'notSent' | 'missingInvoice' | 'missingSwift' | 'hasReturnIssue' | 'multiIncomplete';

function CommandCenter({
  summary,
  dateLabel,
  isToday,
  lastSyncedAt,
  onJumpToCompany,
  entryDelay = 0,
  attentionHighlight,
  onSetAttentionHighlight,
  onClearAttentionHighlight,
  onNavigateDate,
}: {
  summary: CommandCenterSummary;
  dateLabel: string;
  isToday: boolean;
  lastSyncedAt: Date | null;
  onJumpToCompany: (companyId: string, bankId: string) => void;
  entryDelay?: number;
  attentionHighlight: { kind: AttentionKind; label: string; companyIds: string[] } | null;
  onSetAttentionHighlight: (kind: AttentionKind, label: string, companyIds: string[]) => void;
  onClearAttentionHighlight: () => void;
  onNavigateDate: (direction: 'prev' | 'next' | 'today') => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [showAllCompanies, setShowAllCompanies] = useState(false);
  const unresolvedTotal = summary.unresolved.notSent + summary.unresolved.missingInvoice + summary.unresolved.missingSwift;
  const maxBankCount = Math.max(...summary.bankWorkload.map((b) => b.count), 1);
  const maxHourCount = Math.max(...summary.activityByHour.map((h) => h.value), 1);
  const insights = useMemo(() => buildOperationalInsights(summary), [summary]);

  const jumpToFirstWith = (kind: AttentionKind, label: string) => {
    const matches = summary.companyAttention.filter((c) => {
      if (kind === 'hasReturnIssue') return c.hasReturnIssue;
      if (kind === 'multiIncomplete') return c.pendingCount > 1;
      return c[kind] > 0;
    });
    if (matches.length === 0) return;
    onSetAttentionHighlight(kind, label, matches.map((c) => c.companyId));
    onJumpToCompany(matches[0].companyId, matches[0].bankId);
  };

  const pipelineSteps: { key: string; label: string; count: number; icon: typeof Send }[] = [
    { key: 'total', label: 'Ҳамагӣ', count: summary.pipeline.total, icon: BarChart3 },
    { key: 'sent', label: 'Ба бонк фиристода шуд', count: summary.pipeline.sentToBank, icon: Send },
    { key: 'invoice', label: 'Фактура гирифта шуд', count: summary.pipeline.invoiceReceived, icon: Receipt },
    { key: 'swift', label: 'SWIFT гирифта шуд', count: summary.pipeline.swiftReceived, icon: Zap },
    { key: 'complete', label: 'Анҷом ёфт', count: summary.pipeline.complete, icon: CheckCircle2 },
  ];

  const workflowLabel = isToday ? "Ҷараёни кории имрӯз" : `Ҷараёни кор барои ${dateLabel}`;
  const completeStateHeading = isToday
    ? 'Ҳама гузаришҳои имрӯза анҷом ёфтаанд'
    : `Ҳама гузаришҳои санаи ${dateLabel} анҷом ёфтаанд`;

  if (summary.totalTransfers === 0) {
    return (
      <motion.div
        initial={prefersReducedMotion ? undefined : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut', delay: entryDelay }}
        className="command-center-surface saadi-beam-top glass-panel rounded-3xl border border-line shadow-sm mb-6 overflow-hidden"
      >
        <div className="text-center py-10 px-5">
          <div className="w-14 h-14 rounded-2xl bg-brand-green/10 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
            <Clock className="w-7 h-7 text-brand-green dark:text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-ink">Барои {dateLabel} гузариш нест</h3>
          <p className="text-ink-muted text-sm mt-1">Ҳамин ки гузаришҳо сабт шаванд, ин ҷо ҳолати умумии рӯз пайдо мешавад.</p>
          <div className="flex items-center justify-center gap-2 mt-4">
            <button
              type="button"
              onClick={() => onNavigateDate('prev')}
              className="px-3 py-2 rounded-xl text-sm font-medium border border-line bg-surface-1 hover:border-brand-green/50 transition-colors"
              aria-label="Рӯзи гузашта"
            >
              ← Рӯзи гузашта
            </button>
            {!isToday && (
              <button
                type="button"
                onClick={() => onNavigateDate('today')}
                className="px-3 py-2 rounded-xl text-sm font-medium border border-brand-green/40 bg-brand-green/10 text-brand-green-dark dark:text-emerald-400 hover:bg-brand-green/20 transition-colors"
              >
                Имрӯз
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigateDate('next')}
              className="px-3 py-2 rounded-xl text-sm font-medium border border-line bg-surface-1 hover:border-brand-green/50 transition-colors"
              aria-label="Рӯзи оянда"
            >
              Рӯзи оянда →
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  const visibleCompanyAttention = showAllCompanies ? summary.companyAttention : summary.companyAttention.slice(0, 4);

  return (
    <motion.div
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut', delay: entryDelay }}
      className="command-center-surface saadi-beam-top glass-panel rounded-3xl border border-line shadow-sm mb-6 overflow-hidden"
    >
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 border-b border-line">
        <span className="text-[11px] font-bold text-brand-green-dark dark:text-emerald-400 uppercase tracking-wider">
          Маркази амалиёт
        </span>
        <span className="text-base font-extrabold text-ink tracking-tight">{dateLabel}</span>
        <span className="text-xs text-ink-muted">{summary.totalTransfers} гузариш</span>
        <span
          className={cn(
            'status-chip text-[10px] px-2 py-0.5 rounded-full font-semibold',
            unresolvedTotal === 0
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
          )}
        >
          {unresolvedTotal === 0 ? 'Ҳама анҷом ёфт' : `${unresolvedTotal} боқимонда`}
        </span>
        <span
          className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-ink-muted bg-black/[0.02] dark:bg-white/[0.04] px-2.5 py-1 rounded-full"
          aria-live="polite"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {lastSyncedAt
            ? `Навсозии охирин: ${format(lastSyncedAt, 'HH:mm')}`
            : 'Дар ҳоли боркунӣ…'}
        </span>
      </div>

      {/* ── Workflow progress (section 2) ── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-line">
        <WorkflowProgressRing percentage={summary.completionPercentage} prefersReducedMotion={!!prefersReducedMotion} />
        <div className="min-w-0">
          <div className="text-kpi-label">{workflowLabel}</div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="money text-lg font-extrabold text-ink">
              {summary.fullyCompletedTransfers} аз {summary.totalTransfers} анҷом ёфт
            </span>
            <span className="money text-sm font-bold text-brand-green-dark dark:text-emerald-400">{summary.completionPercentage}%</span>
            {summary.incompleteTransfers > 0 && (
              <span className="text-[11px] text-ink-muted">· {summary.incompleteTransfers} боқимонда</span>
            )}
          </div>
        </div>
      </div>

      {/* ── 1. Needs Attention — highest visual priority ── */}
      {unresolvedTotal > 0 || summary.transfersWithReturnsCount > 0 || summary.companiesWithMultipleIncomplete > 0 ? (
        <div className="p-5 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <AttentionTile
              icon={Send}
              label="Ба бонк фиристода нашуд"
              count={summary.unresolved.notSent}
              isActive={attentionHighlight?.kind === 'notSent'}
              onClick={() => jumpToFirstWith('notSent', 'Ба бонк фиристода нашуд')}
            />
            <AttentionTile
              icon={Receipt}
              label="Фактура нарасидааст"
              count={summary.unresolved.missingInvoice}
              isActive={attentionHighlight?.kind === 'missingInvoice'}
              onClick={() => jumpToFirstWith('missingInvoice', 'Фактура нарасидааст')}
            />
            <AttentionTile
              icon={Zap}
              label="SWIFT нарасидааст"
              count={summary.unresolved.missingSwift}
              isActive={attentionHighlight?.kind === 'missingSwift'}
              onClick={() => jumpToFirstWith('missingSwift', 'SWIFT нарасидааст')}
            />
            <AttentionTile
              icon={ArrowDownCircle}
              label="Маблағи баргаштаро дорад"
              count={summary.transfersWithReturnsCount}
              isActive={attentionHighlight?.kind === 'hasReturnIssue'}
              onClick={() => jumpToFirstWith('hasReturnIssue', 'Маблағи баргашта')}
            />
            <AttentionTile
              icon={Users}
              label="Якчанд гузариши нопурра"
              count={summary.companiesWithMultipleIncomplete}
              isActive={attentionHighlight?.kind === 'multiIncomplete'}
              onClick={() => jumpToFirstWith('multiIncomplete', 'Якчанд гузариши нопурра')}
            />
          </div>
          {attentionHighlight && (
            <button
              type="button"
              onClick={onClearAttentionHighlight}
              className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-muted hover:text-ink bg-black/[0.03] dark:bg-white/[0.05] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] px-2.5 py-1.5 rounded-full transition-colors"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              «{attentionHighlight.label}» ҷудо шудааст — Бекор кардани ҷудокунӣ
            </button>
          )}
        </div>
      ) : (
        <div className="px-5 py-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-8 h-8 text-emerald-500 shrink-0" />
            <div>
              <p className="font-semibold text-ink text-sm">{completeStateHeading}</p>
              <p className="text-xs text-ink-muted mt-0.5">
                {summary.fullyCompletedTransfers} гузариш анҷом ёфт — ба бонк фиристода, фактура ва SWIFT гирифта шудаанд. Маблағи баргашта сабт нашудааст.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── 2. Currency summary — net-first, currencies never combined ── */}
      {summary.currencySummaries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-5 pb-4">
          {summary.currencySummaries.map((row) => (
            <div key={row.currency} className="elevation-2 rounded-xl border border-line bg-black/[0.012] dark:bg-white/[0.02] px-4 py-3">
              <div className="flex items-center justify-between">
                <span className={cn('text-sm font-bold', CURRENCY_COLOR_MAP[row.currency].text)}>{currencySymbol(row.currency)} {row.currency}</span>
                {row.incomplete > 0 && (
                  <span className="status-chip text-[10px] text-amber-600 dark:text-amber-400 font-semibold">{row.incomplete} боқӣ</span>
                )}
              </div>
              <div
                className={cn('money text-2xl font-extrabold font-mono mt-1 tracking-tight', CURRENCY_COLOR_MAP[row.currency].text)}
                style={{ textShadow: `0 0 24px ${row.currency === 'USD' ? 'rgba(16,185,129,0.25)' : row.currency === 'EUR' ? 'rgba(59,130,246,0.2)' : 'rgba(234,179,8,0.2)'}` }}
              >
                {formatCurrency(row.net, row.currency)}
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-[10px] text-ink-muted">
                <span className="money">Гузариш: {formatCurrency(row.total, row.currency)}</span>
                {row.returned > 0 && (
                  <span className="money text-red-500 dark:text-red-400">Баргашт: {formatCurrency(row.returned, row.currency)}</span>
                )}
                <span className="money ml-auto">{row.count} гузариш</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 3. Operator status summary (section 3) ── */}
      <div className="px-5 pb-4">
        <div className="text-kpi-label mb-2">Ҷараёни коркард</div>
        <div className="flex flex-col sm:flex-row gap-3">
          {pipelineSteps.map((step) => {
            const pct = summary.pipeline.total > 0 ? Math.round((step.count / summary.pipeline.total) * 100) : 0;
            const StepIcon = step.icon;
            return (
              <div key={step.key} className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-[10px] text-ink-muted mb-1">
                  <StepIcon className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{step.label}</span>
                  <span className="money font-mono shrink-0 ml-auto">{step.count}/{summary.pipeline.total} · {pct}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                  <div
                    className="progress-fill h-full rounded-full transition-all duration-200"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 4 & 5. Bank operational health + company attention, side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 px-5 pb-4">
        <div>
          <div className="text-kpi-label mb-2">Ҳолати амалиётии бонкҳо</div>
          <div className="space-y-2.5">
            {summary.bankWorkload.map((b) => {
              const status = bankStatusLabel(b);
              return (
                <div key={b.bankId}>
                  <div className="flex items-center gap-2">
                    <div className="w-24 shrink-0 text-xs font-medium text-ink truncate" title={b.bankName}>{b.bankName}</div>
                    <div className="flex-1 h-1.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] overflow-hidden">
                      <div
                        className="progress-fill h-full rounded-full transition-all duration-200"
                        style={{ width: `${(b.count / maxBankCount) * 100}%` }}
                      />
                    </div>
                    <span className="money text-[11px] text-ink-muted w-6 text-right shrink-0">{b.count}</span>
                    <span
                      className={cn(
                        'status-chip text-[9px] px-1.5 py-0.5 rounded-full shrink-0 font-semibold',
                        status.tone === 'success'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
                      )}
                    >
                      {status.text}
                    </span>
                  </div>
                  {b.primaryUnresolvedReason && (
                    <div className="text-[10px] text-ink-muted ml-[104px] mt-0.5">{b.primaryUnresolvedReason} · {b.completionPct}% анҷом ёфт</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-kpi-label mb-0">Ширкатҳои ниёзманд</div>
            {summary.companyAttention.length > 4 && (
              <button
                type="button"
                onClick={() => setShowAllCompanies((v) => !v)}
                className="text-[10px] font-semibold text-brand-green-dark dark:text-emerald-400 hover:underline"
              >
                {showAllCompanies ? 'Камтар нишон додан' : `Ҳамаро нишон додан (${summary.companyAttention.length})`}
              </button>
            )}
          </div>
          {summary.companyAttention.length > 0 ? (
            <div className="space-y-1.5">
              {visibleCompanyAttention.map((c) => (
                <button
                  key={c.companyId}
                  type="button"
                  onClick={() => onJumpToCompany(c.companyId, c.bankId)}
                  className="w-full flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 -mx-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.05] transition-colors"
                >
                  <span className="text-xs font-semibold text-ink shrink-0">{c.companyName}</span>
                  <span className="text-[10px] text-ink-muted text-right">
                    {c.pendingCount} гузариши нопурра
                    {c.missingInvoice > 0 && <> · {c.missingInvoice} фактураи норасон</>}
                    {c.missingSwift > 0 && <> · {c.missingSwift} SWIFT норасон</>}
                    {c.hasReturnIssue && <> · <span className="text-red-500 dark:text-red-400">баргашт</span></>}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-ink-muted py-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              Ҳама ширкатҳо дар ҳолати хуб
            </div>
          )}
        </div>
      </div>

      {/* ── Rule-based operational insights (section 7) ── */}
      {insights.length > 0 && (
        <div className="px-5 pb-4">
          <div className="text-kpi-label mb-2">Мушоҳидаҳо</div>
          <ul className="space-y-1">
            {insights.map((text, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-ink">
                <Lightbulb className="w-3.5 h-3.5 text-brand-green-dark dark:text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 6. Activity pulse — real timestamps grouped by hour ── */}
      {summary.activityByHour.length > 1 && (
        <div className="px-5 pb-5">
          <div className="text-kpi-label mb-2">Фаъолият аз рӯйи соат</div>
          <div className="flex items-end gap-1 h-12">
            {summary.activityByHour.map((h) => (
              <div key={h.label} className="flex-1 min-w-0 h-full flex items-end" title={`${h.label} — ${h.value} гузариш`}>
                <div
                  className="w-full bg-brand-green/70 dark:bg-emerald-500/60 rounded-t transition-all duration-200"
                  style={{ height: `${Math.max((h.value / maxHourCount) * 100, 8)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[9px] text-ink-muted mt-1">
            <span>{summary.activityByHour[0]?.label}</span>
            <span>{summary.activityByHour[summary.activityByHour.length - 1]?.label}</span>
          </div>
        </div>
      )}
    </motion.div>
  );
}

export default function App() {
  // Gates the disciplined page-entry stagger below (header -> command
  // center -> controls row) — App() only renders once per page load, so
  // this fires on first mount only, never replaying on a data refresh.
  const prefersReducedMotionEntry = useReducedMotion();
  const [data, setData] = useState<AppData>({ banks: [], companies: [], transfers: [], returns: {} });
  const [selectedDate, setSelectedDate] = useState(() =>
    getStoredString('saadi_selected_date', format(new Date(), 'yyyy-MM-dd'))
  );
  const [selectedBankId, setSelectedBankId] = useState<string | null>(() => {
    const stored = getStoredString('saadi_selected_bank_id', '');
    return stored || null;
  });
  const [isAddingBank, setIsAddingBank] = useState(false);
  const [isAddingCompany, setIsAddingCompany] = useState(false);
  const [newBankName, setNewBankName] = useState('');
  const [newCompanyName, setNewCompanyName] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  // Timestamp of the last successful Supabase load — shown honestly in the
  // Command Center as "last updated", never as a claim of live/real-time
  // connectivity (there is none; this app is REST-poll based).
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(() => getStoredString('saadi_theme', 'light') === 'dark');

  useEffect(() => {
    const root = document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem('saadi_theme', isDarkMode ? 'dark' : 'light');
    } catch {
      // ignore storage errors
    }
  }, [isDarkMode]);
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    getStoredString('saadi_view_mode', 'tracker') as ViewMode
  );
  const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>(() =>
    getStoredString('saadi_date_filter_mode', 'day') as DateFilterMode
  );
  const [searchQuery, setSearchQuery] = useState(() =>
    getStoredString('saadi_search_query', '')
  );
  const [companySortMode, setCompanySortMode] = useState<CompanySortMode>(() =>
    getStoredString('saadi_company_sort_mode', 'manual') as CompanySortMode
  );
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(() => {
    const stored = getStoredString('saadi_selected_company_id', '');
    return stored || null;
  });
  const [toasts, setToasts] = useState<{ id: number; message: string; type: 'error' | 'success' }[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    localStorage.setItem('saadi_selected_date', selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    localStorage.setItem('saadi_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('saadi_date_filter_mode', dateFilterMode);
  }, [dateFilterMode]);

  useEffect(() => {
    localStorage.setItem('saadi_search_query', searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem('saadi_company_sort_mode', companySortMode);
  }, [companySortMode]);

  useEffect(() => {
    if (selectedCompanyId) {
      localStorage.setItem('saadi_selected_company_id', selectedCompanyId);
    }
  }, [selectedCompanyId]);

  useEffect(() => {
    if (selectedBankId) {
      localStorage.setItem('saadi_selected_bank_id', selectedBankId);
    }
  }, [selectedBankId]);

//   useEffect(() => {
//   const wsBase =
//     import.meta.env.VITE_WS_URL ||
//     (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
//       ? "ws://localhost:3000"
//       : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`);

//   console.log('Connecting WebSocket to:', wsBase);

//   const socket = new WebSocket(wsBase);
//   socketRef.current = socket;

//   socket.onopen = () => {
//     console.log('WebSocket connected');
//     setWsConnected(true);
//   };

//   socket.onclose = () => {
//     console.log('WebSocket disconnected');
//     setWsConnected(false);
//   };

//   socket.onerror = (error) => {
//     console.error('WebSocket error:', error);
//     setWsConnected(false);
//   };

//   socket.onmessage = (event) => {
//     try {
//       const msg: ServerMessage = JSON.parse(event.data);
//       if (msg.type === 'INIT' || msg.type === 'UPDATE') {
//         setData(msg.data);
//       }
//     } catch (err) {
//       console.error('Failed to parse WebSocket message:', err);
//     }
//   };

//   return () => {
//     socket.close();
//   };
// }, []);

const loadAllFromSupabase = async () => {
  const fallbackDate = selectedDate || format(new Date(), 'yyyy-MM-dd');

  const { data: banksData, error: banksError } = await fetchAllSupabaseRows('banks', {
    orderBy: 'created_at',
    ascending: true,
  });

  if (banksError) {
    console.error('Supabase banks error:', banksError);
    return null;
  }

  const { data: companiesData, error: companiesError } = await fetchAllSupabaseRows('companies', {
    orderBy: 'sort_order',
    ascending: true,
    secondOrderBy: 'created_at',
    secondAscending: true,
  });

  if (companiesError) {
    console.error('Supabase companies error:', companiesError);
    return null;
  }

  const { data: transfersData, error: transfersError } = await fetchAllSupabaseRows('transfers', {
    orderBy: 'created_at',
    ascending: true,
  });

  if (transfersError) {
    console.error('Supabase transfers error:', transfersError);
    return null;
  }

  const { data: returnsData, error: returnsError } = await fetchAllSupabaseRows('returns', {
    orderBy: 'date',
    ascending: true,
  });

  if (returnsError) {
    console.error('Supabase returns error:', returnsError);
    return null;
  }

  const mappedBanks: Bank[] = (banksData || []).map((bank: any) => ({
    id: String(bank.id),
    name: String(bank.name || ''),
  }));

  const mappedCompanies: Company[] = (companiesData || []).map((company: any) => ({
    id: String(company.id),
    name: String(company.name || ''),
    bankId: String(company.bank_id),
    sortOrder: Number(company.sort_order || 0),
  }));

  const mappedTransfers: Transfer[] = sortTransfersByTime(
    (transfersData || []).map((transfer: any) => mapSupabaseTransfer(transfer, fallbackDate))
  );

  const mappedReturns: AppData['returns'] = {};
  (returnsData || []).forEach((item: any) => {
    const d = normalizeDate(item.date, fallbackDate);
    const companyId = String(item.company_id);
    const currency = normalizeCurrency(item.currency);
    if (!mappedReturns[d]) mappedReturns[d] = {};
    if (!mappedReturns[d][companyId]) mappedReturns[d][companyId] = {};
    mappedReturns[d][companyId][currency] = Number(item.amount || 0);
  });

  const freshData: AppData = {
    banks: mappedBanks,
    companies: mappedCompanies,
    transfers: mappedTransfers,
    returns: mappedReturns,
  };

  console.log('SUPABASE LOADED:', {
    banks: mappedBanks.length,
    companies: mappedCompanies.length,
    transfers: mappedTransfers.length,
    returns: returnsData?.length || 0,
  });

  setData(freshData);

  if (mappedBanks.length > 0 && !selectedBankId) {
    setSelectedBankId(mappedBanks[0].id);
  }

  setWsConnected(true);
  setLastSyncedAt(new Date());
  return freshData;
};

useEffect(() => {
  loadAllFromSupabase().finally(() => setIsInitialLoading(false));
}, []);

let toastIdCounter = 0;
const showToast = (message: string, type: 'error' | 'success' = 'error') => {
  const id = ++toastIdCounter;
  setToasts((prev) => [...prev, { id, message, type }]);
  window.setTimeout(() => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, 4500);
};

const sendMessage = async (msg: ClientMessage) => {
  console.log('Supabase action:', msg);

  if (msg.type === 'ADD_BANK') {
    const { error } = await supabase.from('banks').insert({ name: msg.name });
    if (error) return showToast('خطا در افزودن بانک: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'ADD_COMPANY') {
    const { error } = await supabase.from('companies').insert({
      name: msg.name,
      bank_id: msg.bankId,
      sort_order: data.companies.filter((c) => c.bankId === msg.bankId).length,
    });
    if (error) return showToast('خطا در افزودن شرکت: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'ADD_TRANSFER') {
    const payload = {
      company_id: msg.companyId,
      bank_id: msg.bankId,
      amount: Number(msg.amount) || 0,
      note: msg.note || 'EMPTY',
      currency: msg.currency || 'USD',
      transfer_date: msg.date,
      date: msg.date,
    };

    const { data: savedTransfer, error } = await supabase
      .from('transfers')
      .insert(payload)
      .select('*')
      .single();

    if (error || !savedTransfer) {
      console.error('ADD_TRANSFER ERROR:', error);
      showToast('Хато дар иловаи интиқол: ' + (error?.message || 'Маълумот сабт нашуд'));
      return;
    }

    const mappedTransfer = mapSupabaseTransfer(savedTransfer, msg.date);
    console.log('TRANSFER SAVED:', savedTransfer);

    // 1) Дарҳол дар экран нишон медиҳем, то оператор корро идома дода тавонад.
    setData((prev) => ({
      ...prev,
      transfers: sortTransfersByTime(mergeTransfer(prev.transfers, mappedTransfer)),
    }));

    // 2) Пас аз сабти воқеӣ аз Supabase дубора мехонем, то refresh ҳам дуруст кор кунад.
    window.setTimeout(() => {
      loadAllFromSupabase().then((freshData) => {
        if (!freshData) return;

        const existsInFreshData = freshData.transfers.some((transfer) => transfer.id === mappedTransfer.id);

        if (!existsInFreshData) {
          console.warn('Saved transfer was not returned by Supabase reload. Keeping local copy:', mappedTransfer);
          setData((prev) => ({
            ...prev,
            transfers: sortTransfersByTime(mergeTransfer(prev.transfers, mappedTransfer)),
          }));
        }
      });
    }, 300);

    return;
  }

  if (msg.type === 'UPDATE_TRANSFER') {
    const { data: updatedTransfer, error } = await supabase
      .from('transfers')
      .update({
        amount: Number(msg.amount) || 0,
        note: msg.note || 'EMPTY',
        currency: msg.currency || 'USD',
      })
      .eq('id', msg.id)
      .select('*')
      .single();

    if (error || !updatedTransfer) {
      console.error('UPDATE_TRANSFER ERROR:', error);
      showToast('خطا дар вироиши гузариш: ' + (error?.message || 'Маълумот нав нашуд'));
      return;
    }

    const mappedTransfer = mapSupabaseTransfer(updatedTransfer, selectedDate);

    setData((prev) => ({
      ...prev,
      transfers: sortTransfersByTime(mergeTransfer(prev.transfers, mappedTransfer)),
    }));

    window.setTimeout(() => {
      loadAllFromSupabase();
    }, 300);

    return;
  }

  if (msg.type === 'DELETE_TRANSFER') {
    const { error } = await supabase.from('transfers').delete().eq('id', msg.id);

    if (error) {
      console.error('DELETE_TRANSFER ERROR:', error);
      showToast('خطا дар حذف انتقال: ' + error.message);
      return;
    }

    setData((prev) => ({
      ...prev,
      transfers: prev.transfers.filter((t) => t.id !== msg.id),
    }));

    window.setTimeout(() => {
      loadAllFromSupabase();
    }, 300);

    return;
  }

  if (msg.type === 'UPDATE_RETURN') {
    const returnAmount = Number(msg.amount) || 0;
    const returnCurrency = msg.currency || 'USD';

    const { data: savedData, error } = await supabase
      .from('returns')
      .upsert(
        {
          company_id: msg.companyId,
          date: msg.date,
          currency: returnCurrency,
          amount: returnAmount,
        },
        { onConflict: 'company_id,date,currency' }
      )
      .select();

    console.log('RETURN SAVED:', savedData, error);

    if (error) {
      console.error('UPDATE_RETURN ERROR:', error);
      showToast('خطа дар ثبت برگашт: ' + error.message);
      return;
    }

    setData((prev) => {
      const prevDateMap = prev.returns[msg.date] || {};
      const prevCompanyMap = prevDateMap[msg.companyId] || {};
      return {
        ...prev,
        returns: {
          ...prev.returns,
          [msg.date]: {
            ...prevDateMap,
            [msg.companyId]: {
              ...prevCompanyMap,
              [returnCurrency]: returnAmount,
            },
          },
        },
      };
    });

    return;
  }

  if (msg.type === 'MOVE_COMPANY') {
    const company = data.companies.find((c) => c.id === msg.companyId);
    if (!company) return;

    const bankCompanies = [...data.companies]
      .filter((c) => c.bankId === company.bankId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    const idx = bankCompanies.findIndex((c) => c.id === msg.companyId);
    if (idx === -1) return;

    const targetIdx = msg.direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= bankCompanies.length) return;

    const current = bankCompanies[idx];
    const target = bankCompanies[targetIdx];
    const currentOrder = current.sortOrder ?? idx;
    const targetOrder = target.sortOrder ?? targetIdx;

    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('companies').update({ sort_order: targetOrder }).eq('id', current.id),
      supabase.from('companies').update({ sort_order: currentOrder }).eq('id', target.id),
    ]);

    if (e1 || e2) return showToast('Хато дар иваз кардани ҷой: ' + (e1?.message || e2?.message));
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'MOVE_TO_TOP') {
    const company = data.companies.find((c) => c.id === msg.companyId);
    if (!company) return;

    const bankCompanies = [...data.companies]
      .filter((c) => c.bankId === company.bankId)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    const minOrder = bankCompanies.length > 0 ? (bankCompanies[0].sortOrder ?? 0) : 0;

    const { error } = await supabase
      .from('companies')
      .update({ sort_order: minOrder - 1 })
      .eq('id', msg.companyId);

    if (error) return showToast('Хато: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'DELETE_COMPANY') {
    const { error } = await supabase.from('companies').delete().eq('id', msg.id);
    if (error) return showToast('خطا дар حذف ширкат: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'DELETE_BANK') {
    const { error } = await supabase.from('banks').delete().eq('id', msg.id);
    if (error) return showToast('خطا дар حذف бонк: ' + error.message);
    await loadAllFromSupabase();
    return;
  }
};

const updateTransferConfirmation = async (
  id: string,
  field: 'prepared' | 'invoice' | 'swift',
  value: boolean
) => {
  const column =
    field === 'prepared' ? 'prepared_confirmed' : field === 'invoice' ? 'invoice_confirmed' : 'swift_confirmed';
  const key =
    field === 'prepared' ? 'preparedConfirmed' : field === 'invoice' ? 'invoiceConfirmed' : 'swiftConfirmed';

  // Танҳо ҳамин майдон тағйир меёбад — тартиби гузаришҳо ва дигар маълумот дахл намекунад
  setData((prev) => ({
    ...prev,
    transfers: prev.transfers.map((t) => (t.id === id ? { ...t, [key]: value } : t)),
  }));

  const { error } = await supabase
    .from('transfers')
    .update({ [column]: value })
    .eq('id', id);

  if (error) {
    console.error('updateTransferConfirmation ERROR:', error);
    showToast('Хато дар сабти тасдиқ: ' + error.message);
    // Бозгашт ба ҳолати қаблӣ дар сурати хато
    setData((prev) => ({
      ...prev,
      transfers: prev.transfers.map((t) => (t.id === id ? { ...t, [key]: !value } : t)),
    }));
  }
};

  const selectedBank = useMemo(() => {
    if (!data.banks || data.banks.length === 0) return null;
    return data.banks.find((b) => b.id === selectedBankId) || data.banks[0];
  }, [data.banks, selectedBankId]);

  useEffect(() => {
    if (data.banks.length > 0) {
      const bankStillExists = selectedBankId && data.banks.some((b) => b.id === selectedBankId);
      if (!bankStillExists) setSelectedBankId(data.banks[0].id);
    } else {
      setSelectedBankId(null);
    }
  }, [data.banks, selectedBankId]);

  const filteredCompanies = useMemo(() => {
    if (!selectedBank) return [];
    return data.companies.filter((c) => c.bankId === selectedBank.id);
  }, [data.companies, selectedBank]);

  const activeRange = useMemo(() => getActiveRange(selectedDate, dateFilterMode), [selectedDate, dateFilterMode]);

  const getCompanyTransfersForCurrentFilter = (companyId: string) => {
    return data.transfers
      .filter((transfer) => transfer.companyId === companyId)
      .filter((transfer) => {
        if (!activeRange) return true;
        return isDateWithinRange(transfer.date, activeRange.start, activeRange.end);
      })
      .sort((a, b) => parseISO(a.timestamp).getTime() - parseISO(b.timestamp).getTime());
  };

  const getVisibleCompanyTransfers = (companyId: string, companyName?: string) => {
    return getCompanyTransfersForCurrentFilter(companyId).filter((transfer) =>
      transferMatchesSearch(transfer, searchQuery, companyName)
    );
  };

  const getCompanyReturnForCurrentFilter = (companyId: string): import('./types').ReturnsByCurrency => {
    if (dateFilterMode === 'day') {
      return data.returns[selectedDate]?.[companyId] || {};
    }

    const result: import('./types').ReturnsByCurrency = {};
    Object.entries(data.returns).forEach(([dateKey, companyReturns]) => {
      if (dateFilterMode !== 'all' && activeRange) {
        if (!isDateWithinRange(dateKey, activeRange.start, activeRange.end)) return;
      }
      const currencyMap = companyReturns[companyId];
      if (!currencyMap) return;
      (Object.keys(currencyMap) as Currency[]).forEach((cur) => {
        result[cur] = (result[cur] ?? 0) + (currencyMap[cur] ?? 0);
      });
    });
    return result;
  };

  const sortedCompanies = useMemo(() => {
    const base = [...filteredCompanies];

    const getNet = (companyId: string) => {
      const transfers = getCompanyTransfersForCurrentFilter(companyId).filter((t) => t.currency === 'USD');
      const totalTransfers = transfers.reduce((sum, t) => sum + t.amount, 0);
      const returned = getCompanyReturnForCurrentFilter(companyId);
      return totalTransfers - (returned.USD ?? 0);
    };

    const getCount = (companyId: string) => getCompanyTransfersForCurrentFilter(companyId).length;

    base.sort((a, b) => {
      if (companySortMode === 'manual') {
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      }

      switch (companySortMode) {
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'net-desc':
          return getNet(b.id) - getNet(a.id);
        case 'net-asc':
          return getNet(a.id) - getNet(b.id);
        case 'count-desc':
          return getCount(b.id) - getCount(a.id);
        case 'count-asc':
          return getCount(a.id) - getCount(b.id);
        case 'name-asc':
        default:
          return a.name.localeCompare(b.name);
      }
    });

    return base;
  }, [filteredCompanies, companySortMode, data.transfers, data.returns, selectedDate, dateFilterMode]);

  useEffect(() => {
    if (sortedCompanies.length === 0) {
      if (selectedCompanyId !== null) setSelectedCompanyId(null);
      return;
    }
    const stillExists = selectedCompanyId && sortedCompanies.some((c) => c.id === selectedCompanyId);
    if (!stillExists) setSelectedCompanyId(sortedCompanies[0].id);
  }, [sortedCompanies, selectedCompanyId]);

  const selectedCompany = useMemo(
    () => filteredCompanies.find((c) => c.id === selectedCompanyId) || null,
    [filteredCompanies, selectedCompanyId]
  );

  const visibleCompanies = useMemo(() => {
    if (!searchQuery.trim()) return sortedCompanies;

    const normalized = searchQuery.trim().toLowerCase();

    return sortedCompanies.filter((company) => {
      const companyNameMatch = company.name.toLowerCase().includes(normalized);
      const hasMatchingTransfer = getVisibleCompanyTransfers(company.id, company.name).length > 0;
      return companyNameMatch || hasMatchingTransfer;
    });
  }, [sortedCompanies, searchQuery, data.transfers, selectedDate, dateFilterMode]);

  const calculateBankTotals = () => {
    return filteredCompanies.reduce(
      (acc, company) => {
        const transfers = getCompanyTransfersForCurrentFilter(company.id);
        const totals = summarizeByCurrency(transfers);
        const returned = getCompanyReturnForCurrentFilter(company.id);

        acc.USD += totals.USD - (returned.USD ?? 0);
        acc.EUR += totals.EUR - (returned.EUR ?? 0);
        acc.CNY += totals.CNY - (returned.CNY ?? 0);
        return acc;
      },
      { USD: 0, EUR: 0, CNY: 0 }
    );
  };

  // calculateBankTotals reads filteredCompanies directly, plus data.transfers/
  // data.returns/activeRange/dateFilterMode/selectedDate via the two helper
  // closures above — all six are listed below so this only recomputes when
  // one of them actually changes.
  const bankTotals = useMemo(
    () => calculateBankTotals(),
    [filteredCompanies, data.transfers, data.returns, activeRange, dateFilterMode, selectedDate]
  );
  const canEditDailyFields = dateFilterMode === 'day';

  // Single derived operational summary for the Command Center — one pass
  // over data.transfers (filtered to selectedDate) per (data, selectedDate)
  // change, independent of the tracker's own bank/company selection or its
  // Рӯз/Ҳафта/Моҳ/Ҳама filter, so it always reads as "today" regardless of
  // what the operator is currently drilling into below it.
  const commandCenterSummary = useMemo(
    () => buildCommandCenterSummary(data, selectedDate),
    [data, selectedDate]
  );

  const jumpToCompany = (companyId: string, bankId: string) => {
    if (bankId !== selectedBankId) setSelectedBankId(bankId);
    setSelectedCompanyId(companyId);
    if (viewMode !== 'tracker') setViewMode('tracker');
    const prefersReduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      document
        .getElementById(`company-pill-${companyId}`)
        ?.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'nearest' });
    });
  };

  // Reversible highlight only — no filtering/hiding of the company list,
  // no persistence, cleared by the visible reset action rendered next to
  // it in CommandCenter or by picking a different attention category.
  const [attentionHighlight, setAttentionHighlightState] = useState<{ kind: AttentionKind; label: string; companyIds: string[] } | null>(null);
  const setAttentionHighlight = (kind: AttentionKind, label: string, companyIds: string[]) => {
    setAttentionHighlightState({ kind, label, companyIds });
  };
  const clearAttentionHighlight = () => setAttentionHighlightState(null);

  const isToday = selectedDate === format(new Date(), 'yyyy-MM-dd');
  const navigateCommandCenterDate = (direction: 'prev' | 'next' | 'today') => {
    if (direction === 'today') {
      setSelectedDate(format(new Date(), 'yyyy-MM-dd'));
      return;
    }
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + (direction === 'next' ? 1 : -1));
    setSelectedDate(format(d, 'yyyy-MM-dd'));
  };

  const handleDeleteCompany = (company: Company) => {
    const confirmDelete = window.confirm(
      `Ширкати "${company.name}" нест карда шавад?\n\nҲамаи гузаришҳо ва маблағҳои баргаштӣ ҳам нест мешаванд.`
    );
    if (!confirmDelete) return;
    sendMessage({ type: 'DELETE_COMPANY', id: company.id });
  };

  const handleDeleteBank = (bank: Bank) => {
    const confirmDelete = window.confirm(
      `Бонки "${bank.name}" нест карда шавад?\n\nҲамаи ширкатҳо, гузаришҳо ва баргаштҳо ҳам нест мешаванд.`
    );
    if (!confirmDelete) return;
    sendMessage({ type: 'DELETE_BANK', id: bank.id });
  };

  const exportAnalyticsExcel = () => {
    if (!selectedBank) return;

    const wb = XLSX.utils.book_new();
    const transferSheetRows: (string | number)[][] = [];

    filteredCompanies.forEach((company) => {
      const transfers = getCompanyTransfersForCurrentFilter(company.id);
      const returned = getCompanyReturnForCurrentFilter(company.id);
      const totals = summarizeByCurrency(transfers);

      transferSheetRows.push([`Ширкат: ${company.name}`]);
      transferSheetRows.push(['№', 'Сана', 'Соат', 'Асъор', 'Маблағ', 'Рақами ҳисоб / Эзоҳ']);

      transfers.forEach((transfer, index) => {
        transferSheetRows.push([
          index + 1,
          transfer.date,
          format(parseISO(transfer.timestamp), 'HH:mm'),
          transfer.currency,
          transfer.amount,
          transfer.note || '',
        ]);
      });

      transferSheetRows.push(['', '', '', 'USD', totals.USD, '']);
      transferSheetRows.push(['', '', '', 'EUR', totals.EUR, '']);
      transferSheetRows.push(['', '', '', 'CNY', totals.CNY, '']);
      transferSheetRows.push(['', '', '', 'Баргашт USD', returned.USD ?? 0, '']);
      transferSheetRows.push(['', '', '', 'Баргашт EUR', returned.EUR ?? 0, '']);
      transferSheetRows.push(['', '', '', 'Баргашт CNY', returned.CNY ?? 0, '']);
      transferSheetRows.push([]);
      transferSheetRows.push([]);
    });

    const wsTransfers = XLSX.utils.aoa_to_sheet(transferSheetRows);
    XLSX.utils.book_append_sheet(wb, wsTransfers, 'Гузаришҳо');
    XLSX.writeFile(
      wb,
      `hisobot-${selectedBank.name.replace(/\s+/g, '-').toLowerCase()}-${dateFilterMode}-${selectedDate}.xlsx`
    );
  };

  const exportAnalyticsPDF = () => {
    if (!selectedBank) return;

    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(`Saadi Swift - ${selectedBank.name}`, 14, 16);
    doc.setFontSize(10);
    doc.text(`Range: ${formatRangeLabel(selectedDate, dateFilterMode)}`, 14, 24);

    const companyRows = filteredCompanies.map((company) => {
      const transfers = getCompanyTransfersForCurrentFilter(company.id);
      const totals = summarizeByCurrency(transfers);
      const returned = getCompanyReturnForCurrentFilter(company.id);

      return [
        company.name,
        String(transfers.length),
        numberFormat(totals.USD),
        numberFormat(totals.EUR),
        numberFormat(totals.CNY),
        numberFormat(returned.USD ?? 0),
        numberFormat(returned.EUR ?? 0),
        numberFormat(returned.CNY ?? 0),
      ];
    });

    autoTable(doc, {
      startY: 32,
      head: [['Company', 'Count', 'USD', 'EUR', 'CNY', 'Ret.USD', 'Ret.EUR', 'Ret.CNY']],
      body: companyRows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [16, 185, 129] },
    });

    doc.save(
      `report-${selectedBank.name.replace(/\s+/g, '-').toLowerCase()}-${dateFilterMode}-${selectedDate}.pdf`
    );
  };

  const printProfessionalReport = () => {
    if (!selectedBank) return;

    const companyRows = filteredCompanies.map((company) => {
      const transfers = getCompanyTransfersForCurrentFilter(company.id);
      const totals = summarizeByCurrency(transfers);
      const returned = getCompanyReturnForCurrentFilter(company.id);
      return {
        name: company.name,
        count: transfers.length,
        usd: totals.USD,
        eur: totals.EUR,
        cny: totals.CNY,
        retUsd: returned.USD ?? 0,
        retEur: returned.EUR ?? 0,
        retCny: returned.CNY ?? 0,
      };
    });

    const win = window.open('', '_blank', 'width=1200,height=900');
    if (!win) return;

    const rowsHtml = companyRows
      .map(
        (row) => `
          <tr>
            <td>${row.name}</td>
            <td>${row.count}</td>
            <td>$${numberFormat(row.usd)}</td>
            <td>${row.eur > 0 ? '&euro;' + numberFormat(row.eur) : '-'}</td>
            <td>${row.cny > 0 ? '&yen;' + numberFormat(row.cny) : '-'}</td>
            <td>${row.retUsd > 0 ? '$' + numberFormat(row.retUsd) : '-'}</td>
            <td>${row.retEur > 0 ? '&euro;' + numberFormat(row.retEur) : '-'}</td>
            <td>${row.retCny > 0 ? '&yen;' + numberFormat(row.retCny) : '-'}</td>
          </tr>
        `
      )
      .join('');

    const html = `
      <html>
        <head>
          <title>Ҳисобот</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #111827; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #e5e7eb; padding: 10px 12px; text-align: left; }
            th { background: #ecfdf5; color: #065f46; }
          </style>
        </head>
        <body>
          <h2>Saadi Swift - ${selectedBank.name}</h2>
          <p>${formatRangeLabel(selectedDate, dateFilterMode)}</p>
          <table>
            <thead>
              <tr>
                <th>Ширкат</th>
                <th>Шумора</th>
                <th>USD</th>
                <th>EUR</th>
                <th>CNY</th>
                <th>Барг.USD</th>
                <th>Барг.EUR</th>
                <th>Барг.CNY</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <script>window.onload = () => window.print()</script>
        </body>
      </html>
    `;

    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  return (
    <div className="min-h-screen flex flex-col max-w-7xl mx-auto px-4 py-6 bg-surface-0 dark:bg-transparent transition-colors">
      <motion.header
        initial={prefersReducedMotionEntry ? undefined : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="header-gradient saadi-beam-top flex flex-col gap-4 mb-8 rounded-3xl p-5 border border-gray-100 dark:border-gray-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CoinLogo />
            <div>
              <h1 className="text-3xl font-bold text-brand-green-dark">
                Saadi Exchange
              </h1>
              <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">Системаи назорати гузаришҳои рӯзона</p>
            </div>
          </div>

          <div className="flex items-center gap-3 glass-panel p-2 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
            <button
              type="button"
              onClick={() => {
                const d = new Date(selectedDate);
                d.setDate(d.getDate() - 1);
                setSelectedDate(format(d, 'yyyy-MM-dd'));
              }}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              aria-label="Рӯзи гузашта"
            >
              <ChevronLeft className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>

            <div className="flex items-center gap-2 px-2 font-medium text-gray-700 dark:text-gray-200">
              <CalendarIcon className="w-4 h-4 text-brand-green" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent border-none focus:ring-0 cursor-pointer"
              />
            </div>

            <button
              type="button"
              onClick={() => {
                const d = new Date(selectedDate);
                d.setDate(d.getDate() + 1);
                setSelectedDate(format(d, 'yyyy-MM-dd'));
              }}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              aria-label="Рӯзи оянда"
            >
              <ChevronRight className="w-5 h-5 text-gray-600 dark:text-gray-300" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsDarkMode((prev) => !prev)}
            title={isDarkMode ? 'Гузариш ба ҳолати равшан' : 'Гузариш ба ҳолати торик'}
            className="p-2.5 bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 hover:border-brand-green/50 transition-colors shrink-0"
          >
            {isDarkMode ? (
              <Sun className="w-5 h-5 text-yellow-400" />
            ) : (
              <Moon className="w-5 h-5 text-gray-600" />
            )}
          </button>
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setViewMode('tracker')}
              className={cn(
                'px-4 py-2 rounded-xl text-sm font-semibold border transition-colors',
                viewMode === 'tracker'
                  ? 'bg-brand-green text-white border-brand-green dark:bg-emerald-900/70 dark:border-emerald-500/40 dark:text-white dark:backdrop-blur-md dark:shadow-[0_0_16px_-4px_rgba(16,185,129,0.5)]'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-brand-green/50'
              )}
            >
              Сабт
            </button>

            <button
              type="button"
              onClick={() => setViewMode('analytics')}
              className={cn(
                'px-4 py-2 rounded-xl text-sm font-semibold border transition-colors flex items-center gap-2',
                viewMode === 'analytics'
                  ? 'bg-brand-green text-white border-brand-green dark:bg-emerald-900/70 dark:border-emerald-500/40 dark:text-white dark:backdrop-blur-md dark:shadow-[0_0_16px_-4px_rgba(16,185,129,0.5)]'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-brand-green/50'
              )}
            >
              <BarChart3 className="w-4 h-4" />
              Таҳлил
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Filter className="w-4 h-4" />
              <span className="font-medium">Давра:</span>
            </div>

            {(['day', 'week', 'month', 'all'] as DateFilterMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDateFilterMode(mode)}
                className={cn(
                  'px-3 py-2 rounded-xl text-sm font-medium border transition-colors',
                  dateFilterMode === mode
                    ? 'bg-brand-green text-white border-brand-green dark:bg-emerald-900/70 dark:border-emerald-500/40 dark:text-white dark:backdrop-blur-md dark:shadow-[0_0_16px_-4px_rgba(16,185,129,0.5)]'
                    : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-brand-green/50'
                )}
              >
                {tajikRangeLabel(mode)}
              </button>
            ))}
          </div>
        </div>
      </motion.header>

      {viewMode === 'tracker' && !isInitialLoading && (
        <CommandCenter
          summary={commandCenterSummary}
          dateLabel={format(parseISO(`${selectedDate}T00:00:00`), 'dd.MM.yyyy')}
          isToday={isToday}
          lastSyncedAt={lastSyncedAt}
          onJumpToCompany={jumpToCompany}
          entryDelay={prefersReducedMotionEntry ? 0 : 0.05}
          attentionHighlight={attentionHighlight}
          onSetAttentionHighlight={setAttentionHighlight}
          onClearAttentionHighlight={clearAttentionHighlight}
          onNavigateDate={navigateCommandCenterDate}
        />
      )}

      <motion.div
        initial={prefersReducedMotionEntry ? undefined : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut', delay: prefersReducedMotionEntry ? 0 : 0.1 }}
        className="flex flex-col gap-4 mb-6"
      >
        <div className="flex flex-wrap items-center gap-2">
          {data.banks.map((bank) => (
            <button
              key={bank.id}
              type="button"
              onClick={() => setSelectedBankId(bank.id)}
              className={cn(
                'px-4 py-2 rounded-full text-sm font-medium transition-all border',
                selectedBankId === bank.id
                  ? 'bg-brand-green text-white border-brand-green dark:bg-emerald-900/70 dark:border-emerald-500/40 dark:text-white dark:backdrop-blur-md dark:shadow-[0_0_16px_-4px_rgba(16,185,129,0.5)] shadow-md shadow-brand-green/20'
                  : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-brand-green/50'
              )}
            >
              {bank.name}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setIsAddingBank(true)}
            className="p-2 rounded-full bg-white dark:bg-gray-900 border border-dashed border-gray-300 text-gray-400 dark:text-gray-500 hover:text-brand-green hover:border-brand-green transition-colors"
            aria-label="Иловаи бонк"
          >
            <Plus className="w-5 h-5" />
          </button>

          {selectedBank && (
            <button
              type="button"
              onClick={() => handleDeleteBank(selectedBank)}
              className="px-3 py-2 rounded-xl bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors text-sm font-medium flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Нести бонк
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_auto_auto_auto] gap-3">
          <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl px-4 py-3 shadow-sm flex items-center gap-3">
            <Search className="w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              placeholder="Ҷустуҷӯ аз рӯйи маблағ, асъор, рақами ҳисоб, соат, сана ё ширкат..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-transparent outline-none text-sm text-gray-700 dark:text-gray-200 placeholder:text-gray-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-xs px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200"
              >
                Пок
              </button>
            )}
          </div>

          <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl px-4 py-3 shadow-sm flex items-center gap-3">
            <ArrowUpDown className="w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={companySortMode}
              onChange={(e) => setCompanySortMode(e.target.value as CompanySortMode)}
              className="bg-transparent outline-none text-sm text-gray-700 dark:text-gray-200"
            >
              <option value="manual">Ҷойи дастӣ</option>
              <option value="name-asc">Ном A-Я</option>
              <option value="name-desc">Ном Я-A</option>
              <option value="net-desc">USD соф калон-кам</option>
              <option value="net-asc">USD соф кам-калон</option>
              <option value="count-desc">Шумора калон-кам</option>
              <option value="count-asc">Шумора кам-калон</option>
            </select>
          </div>

          <button
            type="button"
            onClick={exportAnalyticsExcel}
            disabled={!selectedBank}
            className="px-4 py-3 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 flex items-center gap-2"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            Excel
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={exportAnalyticsPDF}
              disabled={!selectedBank}
              className="px-4 py-3 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 flex items-center gap-2"
            >
              <FileText className="w-4 h-4 text-red-500" />
              PDF
            </button>

            <button
              type="button"
              onClick={printProfessionalReport}
              disabled={!selectedBank}
              className="px-4 py-3 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 flex items-center gap-2"
            >
              <Printer className="w-4 h-4 text-blue-500" />
              Чоп
            </button>
          </div>
        </div>
      </motion.div>

      <main className="flex-1">
        {isInitialLoading ? (
          <SkeletonBlock />
        ) : viewMode === 'tracker' ? (
          selectedBank ? (
            <div className="flex flex-col md:flex-row gap-6 items-start">
              <div className="w-full md:w-64 shrink-0 glass-panel rounded-2xl border border-line shadow-sm p-3 md:sticky md:top-4">
                <div className="flex md:flex-col gap-2 overflow-x-auto md:overflow-visible pb-1 md:pb-0">
                  {visibleCompanies.map((company) => {
                    const isSelected = company.id === selectedCompanyId;
                    const isAttentionHighlighted = !isSelected && !!attentionHighlight?.companyIds.includes(company.id);
                    const companyTransfersForBadge = getCompanyTransfersForCurrentFilter(company.id);
                    const companyTotals = summarizeByCurrency(companyTransfersForBadge);
                    const unconfirmedCount = companyTransfersForBadge.filter(
                      (t) => !t.preparedConfirmed || !t.invoiceConfirmed || !t.swiftConfirmed
                    ).length;

                    return (
                      <button
                        key={company.id}
                        id={`company-pill-${company.id}`}
                        type="button"
                        onClick={() => setSelectedCompanyId(company.id)}
                        className={cn(
                          'relative text-left px-3 py-2.5 rounded-xl border card-hover transition-colors shrink-0 md:w-full whitespace-nowrap md:whitespace-normal',
                          isSelected
                            ? 'bg-brand-green text-white border-brand-green dark:bg-emerald-900/70 dark:border-emerald-500/40 dark:text-white dark:backdrop-blur-md shadow-[var(--shadow-glow)]'
                            : isAttentionHighlighted
                              ? 'bg-amber-50 dark:bg-amber-500/10 text-gray-700 dark:text-gray-200 border-amber-400 dark:border-amber-500/50 shadow-[0_0_0_2px_rgba(245,158,11,0.2)]'
                              : 'bg-surface-1 text-gray-600 dark:text-gray-300 border-line hover:border-brand-green/40 hover:bg-brand-green-light/40 dark:hover:bg-emerald-950/50 dark:hover:border-emerald-500/30'
                        )}
                      >
                        {unconfirmedCount > 0 && (
                          <span
                            title={`${unconfirmedCount} гузариши тасдиқнашуда`}
                            className={cn(
                              'absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center shadow',
                              isSelected ? 'bg-white dark:bg-gray-900 text-red-500' : 'bg-red-500 text-white'
                            )}
                          >
                            {unconfirmedCount}
                          </span>
                        )}
                        <div className="flex items-center gap-2">
                          <CompanyAvatar name={company.name} selected={isSelected} />
                          <div className="min-w-0">
                            <div className="font-semibold text-sm truncate">{company.name}</div>
                            <div className={cn('text-[10px] mt-0.5 font-mono', isSelected ? 'text-white/80' : 'text-gray-400 dark:text-gray-500')}>
                              {formatCurrency(companyTotals.USD, 'USD')}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => setIsAddingCompany(true)}
                  className="mt-2 w-full border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl py-2.5 flex items-center justify-center gap-2 text-gray-400 dark:text-gray-500 hover:text-brand-green hover:border-brand-green transition-all text-sm font-medium shrink-0"
                >
                  <Plus className="w-4 h-4" /> Иловаи ширкат
                </button>
              </div>

              <div className="flex-1 min-w-0 w-full">
                {selectedCompany ? (
                  <AnimatePresence mode="popLayout">
                    <CompanyCard
                      key={selectedCompany.id}
                      company={selectedCompany}
                      transfers={getCompanyTransfersForCurrentFilter(selectedCompany.id)}
                      visibleTransfers={getVisibleCompanyTransfers(selectedCompany.id, selectedCompany.name)}
                      returnedAmounts={getCompanyReturnForCurrentFilter(selectedCompany.id)}
                      canAddTransfers={canEditDailyFields}
                      canEditReturn={canEditDailyFields}
                      filterLabel={tajikRangeLabel(dateFilterMode)}
                      isIbt={selectedBank.name.toUpperCase() === 'IBT'}
                      canMoveUp={companySortMode === 'manual' && sortedCompanies.findIndex((c) => c.id === selectedCompany.id) > 0}
                      canMoveDown={companySortMode === 'manual' && sortedCompanies.findIndex((c) => c.id === selectedCompany.id) < sortedCompanies.length - 1}
                      onMoveUp={() => sendMessage({ type: 'MOVE_COMPANY', companyId: selectedCompany.id, direction: 'up' })}
                      onMoveDown={() => sendMessage({ type: 'MOVE_COMPANY', companyId: selectedCompany.id, direction: 'down' })}
                      onMoveToTop={() => sendMessage({ type: 'MOVE_TO_TOP', companyId: selectedCompany.id })}
                      onAddTransfer={(amount, note, currency) =>
                        sendMessage({
                          type: 'ADD_TRANSFER',
                          companyId: selectedCompany.id,
                          bankId: selectedBank.id,
                          amount,
                          note,
                          date: selectedDate,
                          currency
                        })
                      }
                      onUpdateTransfer={(id, amount, note, currency) =>
                        sendMessage({
                          type: 'UPDATE_TRANSFER',
                          id,
                          amount,
                          note,
                          currency
                        })
                      }
                      onUpdateConfirmation={(id, field, value) =>
                        updateTransferConfirmation(id, field, value)
                      }
                      onUpdateReturn={(amount, currency) =>
                        sendMessage({
                          type: 'UPDATE_RETURN',
                          companyId: selectedCompany.id,
                          amount,
                          date: selectedDate,
                          currency
                        })
                      }
                      onDeleteTransfer={(id) => sendMessage({ type: 'DELETE_TRANSFER', id })}
                      onDeleteCompany={() => handleDeleteCompany(selectedCompany)}
                    />
                  </AnimatePresence>
                ) : (
                  <div className="text-center py-20 glass-panel rounded-3xl border border-line shadow-sm">
                    <div className="w-16 h-16 rounded-2xl bg-brand-green/10 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
                      <Building2 className="w-8 h-8 text-brand-green dark:text-emerald-400" />
                    </div>
                    <h3 className="text-xl font-semibold text-ink">Ширкат вуҷуд надорад</h3>
                    <p className="text-ink-muted mt-2">Аввал ширкат илова кунед</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-20 glass-panel rounded-3xl border border-line shadow-sm">
              <div className="w-16 h-16 rounded-2xl bg-brand-green/10 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
                <Building2 className="w-8 h-8 text-brand-green dark:text-emerald-400" />
              </div>
              <h3 className="text-xl font-semibold text-ink">Бонк вуҷуд надорад</h3>
              <p className="text-ink-muted mt-2">Аввал бонк илова кунед</p>
            </div>
          )
        ) : (
          <AnalyticsView
            data={data}
            selectedDate={selectedDate}
            selectedBank={selectedBank}
            companies={filteredCompanies}
          />
        )}
      </main>

      {selectedBank && viewMode === 'tracker' && (
        <div className="mt-10 bg-brand-green-dark dark:bg-gradient-to-br dark:from-emerald-950 dark:via-emerald-900 dark:to-gray-950 dark:border dark:border-emerald-500/25 dark:backdrop-blur-xl text-white p-6 rounded-3xl shadow-xl dark:shadow-emerald-500/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center">
              <TrendingUp className="w-6 h-6" />
            </div>
            <div>
              <p className="text-brand-green-light text-sm font-medium uppercase tracking-wider">
                Ҳамагӣ барои {selectedBank.name}
              </p>
              <p className="text-xs opacity-70">{formatRangeLabel(selectedDate, dateFilterMode)}</p>
            </div>
          </div>

          <div className="text-right space-y-1">
            <div className="font-mono text-2xl font-bold">$ {numberFormat(bankTotals.USD)}</div>
            {bankTotals.EUR > 0 && (
              <div className="font-mono text-xl font-bold text-blue-300">€ {numberFormat(bankTotals.EUR)}</div>
            )}
            {bankTotals.CNY > 0 && (
              <div className="font-mono text-xl font-bold text-yellow-300">¥ {numberFormat(bankTotals.CNY)}</div>
            )}
          </div>
        </div>
      )}

      <Modal isOpen={isAddingBank} onClose={() => setIsAddingBank(false)} title="Иловаи бонк">
        <div className="space-y-4">
          <input
            type="text"
            placeholder="Номи бонк"
            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-brand-green focus:border-transparent outline-none"
            value={newBankName}
            onChange={(e) => setNewBankName(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            disabled={!newBankName.trim()}
            onClick={() => {
              sendMessage({ type: 'ADD_BANK', name: newBankName });
              setNewBankName('');
              setIsAddingBank(false);
            }}
            className="w-full py-3 bg-brand-green text-white rounded-xl font-semibold disabled:opacity-50"
          >
            Сабт
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={isAddingCompany}
        onClose={() => setIsAddingCompany(false)}
        title={`Иловаи ширкат ба ${selectedBank?.name || ''}`}
      >
        <div className="space-y-4">
          <input
            type="text"
            placeholder="Номи ширкат"
            className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-700 focus:ring-2 focus:ring-brand-green focus:border-transparent outline-none"
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            disabled={!newCompanyName.trim()}
            onClick={() => {
              if (selectedBankId) {
                sendMessage({ type: 'ADD_COMPANY', bankId: selectedBankId, name: newCompanyName });
                setNewCompanyName('');
                setIsAddingCompany(false);
              }
            }}
            className="w-full py-3 bg-brand-green text-white rounded-xl font-semibold disabled:opacity-50"
          >
            Сабт
          </button>
        </div>
      </Modal>

      {/* wsConnected really only means "a Supabase load has completed at
          least once" — this app has no live/websocket connection to
          report on (see section 11 audit), so the label says exactly
          that and nothing more. */}
      <div
        className={cn(
          'fixed bottom-4 right-4 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest',
          wsConnected ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'
        )}
      >
        {wsConnected ? 'Маълумот бор шуд' : 'Дар ҳоли боркунӣ…'}
      </div>

      <div className="fixed bottom-4 left-4 z-[60] flex flex-col gap-2 w-full max-w-xs pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: -20, scale: 0.95 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className={cn(
                'pointer-events-auto rounded-xl shadow-lg border px-4 py-3 text-sm font-medium flex items-start gap-2',
                t.type === 'error'
                  ? 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                  : 'bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
              )}
            >
              <span className="flex-1 break-words">{t.message}</span>
              <button
                type="button"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="opacity-50 hover:opacity-100 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

type CompanyCardProps = {
  company: Company;
  transfers: Transfer[];
  visibleTransfers: Transfer[];
  returnedAmounts: import('./types').ReturnsByCurrency;
  canAddTransfers: boolean;
  canEditReturn: boolean;
  filterLabel: string;
  isIbt: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveToTop: () => void;
  onAddTransfer: (amount: number, note: string, currency: Currency) => void;
  onUpdateTransfer: (id: string, amount: number, note: string, currency: Currency) => void;
  onUpdateConfirmation: (id: string, field: 'prepared' | 'invoice' | 'swift', value: boolean) => void;
  onUpdateReturn: (amount: number, currency: Currency) => void;
  onDeleteTransfer: (id: string) => void;
  onDeleteCompany: () => void;
};

function CompanyCard({
  company,
  transfers,
  visibleTransfers,
  returnedAmounts,
  canAddTransfers,
  canEditReturn,
  filterLabel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onAddTransfer,
  onUpdateTransfer,
  onUpdateConfirmation,
  onUpdateReturn,
  onDeleteTransfer,
  onDeleteCompany
}: CompanyCardProps) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [isAdding, setIsAdding] = useState(false);
  const [editingTransferId, setEditingTransferId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editCurrency, setEditCurrency] = useState<Currency>('USD');
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const [returnInput, setReturnInput] = useState('');
  const [returnCurrency, setReturnCurrency] = useState<Currency>('USD');
  const [returnError, setReturnError] = useState<string | null>(null);
  const isReturnFieldFocused = useRef(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    // Any unrelated data reload elsewhere in the app (another company's
    // transfer being added/edited/deleted, etc.) re-renders this component
    // with a brand-new `returnedAmounts` object. Skipping the resync while
    // the operator has this field focused stops that reload from wiping out
    // an unsaved keystroke; the field still syncs normally on mount, on
    // currency switch, and after this field loses focus.
    if (isReturnFieldFocused.current) return;
    const val = returnedAmounts[returnCurrency];
    setReturnInput(val ? String(val) : '');
    setReturnError(null);
  }, [returnedAmounts, returnCurrency]);

  const totals = summarizeByCurrency(transfers);
  const returnedUsd = returnedAmounts.USD ?? 0;
  const returnedEur = returnedAmounts.EUR ?? 0;
  const returnedCny = returnedAmounts.CNY ?? 0;
  const netUsd = totals.USD - returnedUsd;
  const netEur = totals.EUR - returnedEur;
  const netCny = totals.CNY - returnedCny;

  useEffect(() => {
    if (isAdding) amountInputRef.current?.focus();
  }, [isAdding]);

  useEffect(() => {
    if (!canAddTransfers) setIsAdding(false);
  }, [canAddTransfers]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(amount);
    if (!isNaN(val) && val > 0) {
      onAddTransfer(val, note, currency);
      setAmount('');
      setNote('');
      setCurrency('USD');
      setTimeout(() => amountInputRef.current?.focus(), 0);
    }
  };

  const startEdit = (transfer: Transfer) => {
    setEditingTransferId(transfer.id);
    setEditAmount(String(transfer.amount));
    setEditNote(transfer.note || '');
    setEditCurrency(transfer.currency);
  };

  const saveEdit = () => {
    if (!editingTransferId) return;
    const value = parseFloat(editAmount);
    if (isNaN(value) || value <= 0) return;

    onUpdateTransfer(editingTransferId, value, editNote, editCurrency);
    setEditingTransferId(null);
    setEditAmount('');
    setEditNote('');
    setEditCurrency('USD');
  };

  const cancelEdit = () => {
    setEditingTransferId(null);
    setEditAmount('');
    setEditNote('');
    setEditCurrency('USD');
  };

  return (
    <motion.div
      layout={!prefersReducedMotion}
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="rounded-2xl"
    >
      <div
        className="glass-panel card-hover rounded-2xl border border-line border-t-2 border-t-brand-green/25 shadow-sm overflow-hidden flex flex-col min-h-[720px]"
      >
      <div className="p-5 border-b border-line flex items-center justify-between bg-black/[0.015] dark:bg-white/[0.02]">
        <div>
          <h3 className="font-bold text-ink text-lg">{company.name}</h3>
          <div className="text-xs text-ink-muted mt-1">Намоиш: {filterLabel}</div>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="p-1 rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-30 transition-colors"
              title="Боло"
              aria-label="Ба боло гузарондан"
            >
              <ChevronUp className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="p-1 rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] disabled:opacity-30 transition-colors"
              title="Поён"
              aria-label="Ба поён гузарондан"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          </div>

          <button
            type="button"
            onClick={onMoveToTop}
            disabled={!canMoveUp}
            className="px-2 py-1 rounded bg-brand-green/10 text-brand-green-dark border border-brand-green/20 text-[10px] font-bold hover:bg-brand-green/20 disabled:opacity-30 transition-colors"
            title="Ба боло"
          >
            ↑ Ба боло
          </button>

          <div className="text-[10px] font-mono px-1.5 py-1 text-ink-muted opacity-70" title={company.id}>
            #{company.id.slice(0, 4)}
          </div>
          <button
            type="button"
            onClick={onDeleteCompany}
            className="p-2 rounded-lg text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            title="Нести ширкат"
            aria-label="Нести ширкат"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-5 flex-1 flex flex-col space-y-4">
        {canAddTransfers ? (
          !isAdding ? (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className="w-full py-3 px-4 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl text-sm text-gray-500 dark:text-gray-400 hover:border-brand-green hover:text-brand-green transition-colors flex items-center justify-center gap-2 shrink-0"
            >
              <Plus className="w-4 h-4" /> Иловаи гузариш
            </button>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-2 bg-gray-50 dark:bg-gray-900 p-3 rounded-xl border border-gray-100 dark:border-gray-800 shrink-0">
              <div className="flex gap-2">
                <input
                  ref={amountInputRef}
                  type="number"
                  placeholder={`Маблағ (${currency})`}
                  className="flex-1 p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:ring-1 focus:ring-brand-green outline-none"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  step="0.01"
                />

                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                  className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm outline-none"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="CNY">CNY</option>
                </select>

                <button
                  type="submit"
                  className="bg-brand-green text-white px-4 rounded-lg text-sm font-bold hover:bg-brand-green-dark transition-colors"
                >
                  Сабт
                </button>
              </div>

              <input
                type="text"
                placeholder="Рақами ҳисоб / Эзоҳ"
                className="w-full p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs focus:ring-1 focus:ring-brand-green outline-none"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              <div className="flex justify-between items-center">
                <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase font-bold">Enter барои сабт</span>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 uppercase font-bold"
                >
                  Бекор
                </button>
              </div>
            </form>
          )
        ) : (
          <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
            Барои илова ё таҳрир ба филтри <span className="font-semibold">Рӯз</span> гузаред.
          </div>
        )}

        <div className="space-y-2 pr-2 border border-line rounded-xl p-3 bg-black/[0.01] dark:bg-white/[0.015]">
          {visibleTransfers.length === 0 ? (
            <div className="text-center py-10">
              <Receipt className="w-6 h-6 text-ink-muted opacity-40 mx-auto mb-2" />
              <p className="text-xs text-ink-muted italic">
                {transfers.length === 0 ? 'Дар ин давра гузариш нест' : 'Аз рӯйи ҷустуҷӯ чизе ёфт нашуд'}
              </p>
            </div>
          ) : (
            visibleTransfers.map((t, index) => {
              const isEditing = editingTransferId === t.id;

              const status = getTransferStatus(t);

              return (
                <div
                  key={t.id}
                  className={cn(
                    'border-b border-line pb-2 last:border-b-0 px-2 -mx-2 rounded-lg transition-colors',
                    index % 2 === 1 && 'bg-black/[0.015] dark:bg-white/[0.02]',
                    'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                  )}
                >
                  {!isEditing ? (
                    <div className="flex items-start justify-between gap-2 flex-wrap group">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="text-[10px] text-white bg-gray-400 rounded-full w-5 h-5 flex items-center justify-center font-bold mt-0.5 shrink-0">
                          {index + 1}
                        </div>
                        <div className="money text-[10px] text-ink-muted font-mono pt-1 min-w-[34px] shrink-0">
                          {format(parseISO(t.timestamp), 'HH:mm')}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="money text-sm font-bold text-gray-700 dark:text-white break-all">
                              {formatCurrency(t.amount, t.currency)}
                            </div>
                            <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-semibold', CURRENCY_COLOR_MAP[t.currency].badge)}>
                              {t.currency}
                            </span>
                            <span className={cn('status-chip text-[9px] px-1.5 py-0.5 rounded-full font-semibold', TRANSFER_STATUS_CLASS[status])}>
                              {TRANSFER_STATUS_LABEL[status]}
                            </span>
                          </div>
                          {t.note && (
                            <div className="text-[10px] text-ink-muted mt-0.5 break-all">{t.note}</div>
                          )}
                          <div className="text-[10px] text-gray-300 dark:text-gray-600 mt-0.5">{t.date}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap justify-end ml-auto shrink-0">
                        <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1">
                          <motion.label whileTap={{ scale: 0.9 }} transition={{ duration: 0.1 }} className="flex items-center gap-1 cursor-pointer select-none rounded-md px-1 py-1 -my-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors" title="Омода / Ба бонк фиристода шуд">
                            <input
                              type="checkbox"
                              checked={t.preparedConfirmed}
                              onChange={(e) => onUpdateConfirmation(t.id, 'prepared', e.target.checked)}
                              className="confirm-check"
                            />
                            <span className="text-[9px] font-semibold text-ink-muted whitespace-nowrap">Омода</span>
                          </motion.label>
                          <motion.label whileTap={{ scale: 0.9 }} transition={{ duration: 0.1 }} className="flex items-center gap-1 cursor-pointer select-none rounded-md px-1 py-1 -my-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors" title="Фактура гирифта шуд">
                            <input
                              type="checkbox"
                              checked={t.invoiceConfirmed}
                              onChange={(e) => onUpdateConfirmation(t.id, 'invoice', e.target.checked)}
                              className="confirm-check"
                            />
                            <span className="text-[9px] font-semibold text-ink-muted whitespace-nowrap">Фактура</span>
                          </motion.label>
                          <motion.label whileTap={{ scale: 0.9 }} transition={{ duration: 0.1 }} className="flex items-center gap-1 cursor-pointer select-none rounded-md px-1 py-1 -my-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors" title="SWIFT гирифта шуд">
                            <input
                              type="checkbox"
                              checked={t.swiftConfirmed}
                              onChange={(e) => onUpdateConfirmation(t.id, 'swift', e.target.checked)}
                              className="confirm-check"
                            />
                            <span className="text-[9px] font-semibold text-ink-muted whitespace-nowrap">SWIFT</span>
                          </motion.label>
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                          <button
                            type="button"
                            onClick={() => startEdit(t)}
                            className="p-1 text-gray-300 dark:text-gray-600 hover:text-blue-500 transition-all"
                            aria-label="Таҳрири гузариш"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteTransfer(t.id)}
                            className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-all"
                            aria-label="Нест кардани гузариш"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={editAmount}
                          onChange={(e) => setEditAmount(e.target.value)}
                          className="flex-1 p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm focus:ring-1 focus:ring-brand-green outline-none"
                          step="0.01"
                        />

                        <select
                          value={editCurrency}
                          onChange={(e) => setEditCurrency(e.target.value as Currency)}
                          className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm outline-none"
                        >
                          <option value="USD">USD</option>
                          <option value="EUR">EUR</option>
                          <option value="CNY">CNY</option>
                        </select>

                        <button
                          type="button"
                          onClick={saveEdit}
                          className="p-2 rounded-lg bg-brand-green text-white hover:bg-brand-green-dark transition-colors"
                          aria-label="Захира кардан"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="p-2 rounded-lg bg-gray-200 text-gray-700 dark:text-gray-200 hover:bg-gray-300 transition-colors"
                          aria-label="Бекор кардан"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <input
                        type="text"
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="Рақами ҳисоб / Эзоҳ..."
                        className="w-full p-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs focus:ring-1 focus:ring-brand-green outline-none"
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="p-5 bg-black/[0.02] dark:bg-white/[0.03] border-t border-line space-y-4">
        <div className="space-y-2 text-sm text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-between gap-3">
            <span>Ҳамагӣ USD</span>
            <span className="font-mono font-medium text-gray-700 dark:text-gray-200 text-right break-all">
              {formatCurrency(totals.USD, 'USD')}
            </span>
          </div>

          {totals.EUR > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span>Ҳамагӣ EUR</span>
              <span className="font-mono font-medium text-blue-700 text-right break-all">
                {formatCurrency(totals.EUR, 'EUR')}
              </span>
            </div>
          )}

          {totals.CNY > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span>Ҳамагӣ CNY</span>
              <span className="font-mono font-medium text-gray-700 dark:text-gray-200 text-right break-all">
                {formatCurrency(totals.CNY, 'CNY')}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm text-red-500 font-medium">
              <ArrowDownCircle className="w-4 h-4" />
              <span>Баргашт</span>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={returnCurrency}
                onChange={(e) => setReturnCurrency(e.target.value as Currency)}
                disabled={!canEditReturn}
                className={cn(
                  'p-1 rounded border text-xs outline-none',
                  canEditReturn ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900' : 'border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500'
                )}
              >
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="CNY">CNY</option>
              </select>
              <input
                type="number"
                disabled={!canEditReturn}
                className={cn(
                  'w-28 border rounded-lg px-3 py-2 text-sm font-mono text-right outline-none',
                  canEditReturn
                    ? returnError
                      ? 'bg-white dark:bg-gray-900 border-red-400 focus:ring-1 focus:ring-red-500'
                      : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 focus:ring-1 focus:ring-red-400'
                    : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                )}
                value={returnInput}
                onFocus={() => {
                  isReturnFieldFocused.current = true;
                }}
                onChange={(e) => {
                  setReturnInput(e.target.value);
                  if (returnError) setReturnError(null);
                }}
                onBlur={() => {
                  isReturnFieldFocused.current = false;
                  if (!canEditReturn) return;

                  const trimmed = returnInput.trim();
                  if (trimmed === '') {
                    setReturnError('Маблағро ворид кунед ё "0" нависед');
                    return;
                  }
                  const parsed = Number(trimmed);
                  if (!Number.isFinite(parsed)) {
                    setReturnError('Рақами дуруст ворид кунед');
                    return;
                  }
                  if (parsed < 0) {
                    setReturnError('Маблағ наметавонад манфӣ бошад');
                    return;
                  }

                  setReturnError(null);
                  onUpdateReturn(parsed, returnCurrency);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                placeholder="0.00"
                step="0.01"
                aria-invalid={returnError ? true : undefined}
                aria-describedby={returnError ? `return-error-${company.id}` : undefined}
              />
            </div>
          </div>
          {returnError && (
            <p id={`return-error-${company.id}`} className="text-xs text-red-500 text-right">
              {returnError}
            </p>
          )}
        </div>

        <div className="pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-bold text-gray-800 dark:text-white">Софӣ USD</span>
            <span
              className={cn(
                'money text-[clamp(1.5rem,2.2vw,2rem)] font-extrabold font-mono leading-none text-right break-all max-w-[60%] tracking-tight',
                netUsd >= 0 ? 'text-brand-green-dark dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
              )}
              style={{ textShadow: netUsd >= 0 ? '0 0 26px rgba(16,185,129,0.25)' : '0 0 26px rgba(239,68,68,0.22)' }}
            >
              {formatCurrency(netUsd, 'USD')}
            </span>
          </div>

          {(totals.EUR > 0 || returnedEur > 0) && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-bold text-gray-800 dark:text-white">Софӣ EUR</span>
              <span
                className={cn(
                  'money text-[clamp(1.3rem,2vw,1.8rem)] font-extrabold font-mono text-right break-all max-w-[60%] tracking-tight',
                  netEur >= 0 ? 'text-blue-700 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
                )}
                style={{ textShadow: netEur >= 0 ? '0 0 24px rgba(59,130,246,0.22)' : '0 0 24px rgba(239,68,68,0.2)' }}
              >
                {formatCurrency(netEur, 'EUR')}
              </span>
            </div>
          )}

          {(totals.CNY > 0 || returnedCny > 0) && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-bold text-gray-800 dark:text-white">Софӣ CNY</span>
              <span
                className={cn(
                  'money text-[clamp(1.3rem,2vw,1.8rem)] font-extrabold font-mono text-right break-all max-w-[60%] tracking-tight',
                  netCny >= 0 ? 'text-yellow-700 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'
                )}
                style={{ textShadow: netCny >= 0 ? '0 0 24px rgba(234,179,8,0.2)' : '0 0 24px rgba(239,68,68,0.2)' }}
              >
                {formatCurrency(netCny, 'CNY')}
              </span>
            </div>
          )}
        </div>
      </div>
      </div>
    </motion.div>
  );
}

// ── Analytics dashboard types ────────────────────────────────────────────
type AnalyticsPeriod = 'day' | 'week' | 'month' | 'all';
type AnalyticsCurrencyFilter = 'ALL' | Currency;

/** Sum returns per currency for a set of companyIds inside an optional date range */
function sumReturnsByCurrencyInRange(
  returnsMap: AppData['returns'],
  companyIds: string[],
  start: Date | null,
  end: Date | null
): Record<Currency, number> {
  const result: Record<Currency, number> = { USD: 0, EUR: 0, CNY: 0 };
  Object.entries(returnsMap).forEach(([dateKey, companyMap]) => {
    if (start && end && !isDateWithinRange(dateKey, start, end)) return;
    Object.entries(companyMap).forEach(([companyId, currencyMap]) => {
      if (companyIds.length && !companyIds.includes(companyId)) return;
      (Object.keys(currencyMap) as Currency[]).forEach((cur) => {
        result[cur] = (result[cur] || 0) + (currencyMap[cur] ?? 0);
      });
    });
  });
  return result;
}

function getPeriodRange(selectedDate: string, period: AnalyticsPeriod): { start: Date; end: Date } | null {
  if (period === 'all') return null;
  const d = parseISO(`${selectedDate}T00:00:00`);
  if (period === 'day') return { start: d, end: d };
  if (period === 'week') return {
    start: startOfWeek(d, { weekStartsOn: 1 }),
    end: endOfWeek(d, { weekStartsOn: 1 }),
  };
  return { start: startOfMonth(d), end: endOfMonth(d) };
}

function getPeriodLabel(selectedDate: string, period: AnalyticsPeriod): string {
  const d = parseISO(`${selectedDate}T00:00:00`);
  if (period === 'day') return format(d, 'dd.MM.yyyy');
  if (period === 'week') {
    const s = startOfWeek(d, { weekStartsOn: 1 });
    const e = endOfWeek(d, { weekStartsOn: 1 });
    return `${format(s, 'dd.MM')} – ${format(e, 'dd.MM.yyyy')}`;
  }
  if (period === 'month') return format(d, 'MM.yyyy');
  return 'Ҳамаи давра';
}

type TrendPoint = {
  label: string;
  key: string;
  netUsd: number; netEur: number; netCny: number;
  totalUsd: number; totalEur: number; totalCny: number;
  count: number;
};

function buildAnalyticsTrend(
  transfers: Transfer[],
  returnsMap: AppData['returns'],
  companyIds: string[],
  period: AnalyticsPeriod,
  selectedDate: string
): TrendPoint[] {
  if (period === 'day') {
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
    const dayD = parseISO(`${selectedDate}T00:00:00`);
    const ret = sumReturnsByCurrencyInRange(returnsMap, companyIds, dayD, dayD);
    const totalCount = dayTransfers.length;
    return usedHours.map((hour) => {
      const ht = buckets.get(hour) ?? [];
      const totals = summarizeByCurrency(ht);
      const share = totalCount > 0 ? ht.length / totalCount : 0;
      return {
        label: `${String(hour).padStart(2, '0')}:00`,
        key: `h${hour}`,
        netUsd: totals.USD - ret.USD * share,
        netEur: totals.EUR - ret.EUR * share,
        netCny: totals.CNY - ret.CNY * share,
        totalUsd: totals.USD,
        totalEur: totals.EUR,
        totalCny: totals.CNY,
        count: ht.length,
      };
    });
  }

  if (period === 'all') {
    if (!transfers.length) return [];
    const allDates = [...new Set(transfers.map((t) => t.date))].sort();
    const firstMonth = startOfMonth(parseISO(`${allDates[0]}T00:00:00`));
    const months = eachMonthOfInterval({ start: firstMonth, end: endOfMonth(new Date()) });
    return months.map((monthStart) => {
      const end = endOfMonth(monthStart);
      const mt = transfers.filter((t) => isDateWithinRange(t.date, monthStart, end));
      const totals = summarizeByCurrency(mt);
      const ret = sumReturnsByCurrencyInRange(returnsMap, companyIds, monthStart, end);
      return {
        label: format(monthStart, 'MM.yy'),
        key: format(monthStart, 'yyyy-MM'),
        netUsd: totals.USD - ret.USD,
        netEur: totals.EUR - ret.EUR,
        netCny: totals.CNY - ret.CNY,
        totalUsd: totals.USD,
        totalEur: totals.EUR,
        totalCny: totals.CNY,
        count: mt.length,
      };
    });
  }

  const range = getPeriodRange(selectedDate, period);
  if (!range) return [];
  const days = eachDayOfInterval({ start: range.start, end: range.end });
  const labelFmt = period === 'month' ? 'dd' : 'dd.MM';

  return days.map((day) => {
    const key = format(day, 'yyyy-MM-dd');
    const dayD = parseISO(`${key}T00:00:00`);
    const dt = transfers.filter((t) => t.date === key);
    const totals = summarizeByCurrency(dt);
    const ret = sumReturnsByCurrencyInRange(returnsMap, companyIds, dayD, dayD);
    return {
      label: format(day, labelFmt),
      key,
      netUsd: totals.USD - ret.USD,
      netEur: totals.EUR - ret.EUR,
      netCny: totals.CNY - ret.CNY,
      totalUsd: totals.USD,
      totalEur: totals.EUR,
      totalCny: totals.CNY,
      count: dt.length,
    };
  });
}

// ── AnalyticsViewProps (unchanged interface) ──────────────────────────────
type AnalyticsViewProps = {
  data: AppData;
  selectedDate: string;
  selectedBank: Bank | null;
  companies: Company[];
};

function AnalyticsView({ data, selectedDate, selectedBank, companies }: AnalyticsViewProps) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('day');
  const [currencyFilter, setCurrencyFilter] = useState<AnalyticsCurrencyFilter>('ALL');

  if (!selectedBank) {
    return (
      <div className="text-center py-20 glass-panel rounded-3xl border border-line shadow-sm">
        <div className="w-16 h-16 rounded-2xl bg-brand-green/10 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
          <BarChart3 className="w-8 h-8 text-brand-green dark:text-emerald-400" />
        </div>
        <h3 className="text-xl font-semibold text-ink">Бонк интихоб нашудааст</h3>
        <p className="text-ink-muted mt-2">Барои дидани таҳлил аввал бонкро интихоб кунед.</p>
      </div>
    );
  }

  const companyIds = useMemo(() => companies.map((c) => c.id), [companies]);

  const bankTransfers = useMemo(
    () => data.transfers.filter((t) => t.bankId === selectedBank.id),
    [data.transfers, selectedBank.id]
  );

  const range = useMemo(() => getPeriodRange(selectedDate, period), [selectedDate, period]);

  const periodTransfers = useMemo(() => {
    if (!range) return bankTransfers;
    return bankTransfers.filter((t) => isDateWithinRange(t.date, range.start, range.end));
  }, [bankTransfers, range]);

  const transferTotals = useMemo(() => summarizeByCurrency(periodTransfers), [periodTransfers]);

  const periodReturns = useMemo(
    () => sumReturnsByCurrencyInRange(data.returns, companyIds, range?.start ?? null, range?.end ?? null),
    [data.returns, companyIds, range]
  );

  const netTotals = useMemo<Record<Currency, number>>(
    () => ({
      USD: transferTotals.USD - periodReturns.USD,
      EUR: transferTotals.EUR - periodReturns.EUR,
      CNY: transferTotals.CNY - periodReturns.CNY,
    }),
    [transferTotals, periodReturns]
  );

  const countByCurrency = useMemo(
    () => ({
      USD: periodTransfers.filter((t) => t.currency === 'USD').length,
      EUR: periodTransfers.filter((t) => t.currency === 'EUR').length,
      CNY: periodTransfers.filter((t) => t.currency === 'CNY').length,
    }),
    [periodTransfers]
  );

  const avgByCurrency = useMemo<Record<Currency, number>>(
    () => ({
      USD: countByCurrency.USD > 0 ? transferTotals.USD / countByCurrency.USD : 0,
      EUR: countByCurrency.EUR > 0 ? transferTotals.EUR / countByCurrency.EUR : 0,
      CNY: countByCurrency.CNY > 0 ? transferTotals.CNY / countByCurrency.CNY : 0,
    }),
    [transferTotals, countByCurrency]
  );

  const trendData = useMemo(
    () => buildAnalyticsTrend(bankTransfers, data.returns, companyIds, period, selectedDate),
    [bankTransfers, data.returns, companyIds, period, selectedDate]
  );

  const companyBreakdown = useMemo(() => {
    return companies
      .map((company) => {
        const ct = periodTransfers.filter((t) => t.companyId === company.id);
        const totals = summarizeByCurrency(ct);
        const ret = sumReturnsByCurrencyInRange(
          data.returns, [company.id], range?.start ?? null, range?.end ?? null
        );
        return {
          name: company.name,
          count: ct.length,
          usd: totals.USD, eur: totals.EUR, cny: totals.CNY,
          retUsd: ret.USD, retEur: ret.EUR, retCny: ret.CNY,
          netUsd: totals.USD - ret.USD,
          netEur: totals.EUR - ret.EUR,
          netCny: totals.CNY - ret.CNY,
        };
      })
      .filter((c) => c.count > 0)
      .sort((a, b) => (b.usd + b.eur + b.cny) - (a.usd + a.eur + a.cny));
  }, [companies, periodTransfers, data.returns, range]);

  const periodLabel = getPeriodLabel(selectedDate, period);
  const hasAnyData = periodTransfers.length > 0;
  const hasEur = transferTotals.EUR > 0 || periodReturns.EUR > 0;
  const hasCny = transferTotals.CNY > 0 || periodReturns.CNY > 0;
  const showChart = trendData.length > 0;

  const chartPeriodLabel =
    period === 'all' ? 'Тренди моҳона' :
    period === 'month' ? 'Рӯзона дар моҳ' :
    period === 'week' ? 'Рӯзона дар ҳафта' : 'Соатона имрӯз';

  const usdTrend = useMemo(
    () => trendData.map((p) => ({ label: p.label, value: Math.max(p.netUsd, 0) })),
    [trendData]
  );
  const eurTrend = useMemo(
    () => trendData.map((p) => ({ label: p.label, value: Math.max(p.netEur, 0) })),
    [trendData]
  );
  const cnyTrend = useMemo(
    () => trendData.map((p) => ({ label: p.label, value: Math.max(p.netCny, 0) })),
    [trendData]
  );

  // Same shared currency identity the Command Center and transfer rows
  // use — see CURRENCY_COLOR_MAP's own comment for why this used to be a
  // separate, independently-maintained copy.
  const colorMap = CURRENCY_COLOR_MAP;

  const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
    day: 'Рӯз', week: 'Ҳафта', month: 'Моҳ', all: 'Ҳама',
  };

  const activeCurrencies: Currency[] = (['USD', 'EUR', 'CNY'] as Currency[]).filter(
    (cur) => currencyFilter === 'ALL' || currencyFilter === cur
  );

  return (
    <div className="space-y-6">
      {/* ── Controls ── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Period tabs */}
        <div className="flex gap-1 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-1 shadow-sm">
          {(['day', 'week', 'month', 'all'] as AnalyticsPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
                period === p ? 'bg-brand-green text-white' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              )}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Currency filter */}
        <div className="flex gap-1 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl p-1 shadow-sm">
          {(['ALL', 'USD', 'EUR', 'CNY'] as AnalyticsCurrencyFilter[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCurrencyFilter(c)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
                currencyFilter === c
                  ? c === 'USD' ? 'bg-emerald-500 text-white'
                    : c === 'EUR' ? 'bg-blue-500 text-white'
                    : c === 'CNY' ? 'bg-yellow-500 text-white'
                    : 'bg-brand-green text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              )}
            >
              {c === 'ALL' ? 'Ҳама' : c}
            </button>
          ))}
        </div>

        <span className="text-sm font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl px-3 py-2 shadow-sm">
          {selectedBank.name} · {periodLabel}
        </span>

        {period === 'all' && bankTransfers.length > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl px-3 py-2 shadow-sm">
            Ҳамагӣ {bankTransfers.length} гузариш
          </span>
        )}
      </div>

      {/* ── Per-currency summary blocks (bento grid) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {activeCurrencies.map((cur, curIdx) => {
          const gross = transferTotals[cur];
          const ret = periodReturns[cur];
          const net = netTotals[cur];
          const cnt = countByCurrency[cur];
          const avg = avgByCurrency[cur];
          if (currencyFilter === 'ALL' && gross === 0 && ret === 0) return null;
          return (
            <div
              key={cur}
              className={cn(
                'glass-panel rounded-2xl border border-line shadow-sm overflow-hidden',
                curIdx === 0 ? 'lg:col-span-2' : 'lg:col-span-1'
              )}
            >
              {/* currency header */}
              <div className={cn('px-5 py-3 border-b border-line flex items-center gap-3', colorMap[cur].bg)}>
                <span className={cn('font-bold text-lg tracking-wide', colorMap[cur].text)}>
                  {currencySymbol(cur)} {cur}
                </span>
                <span className={cn('text-[10px] px-2 py-1 rounded-full font-semibold ml-auto', TRANSFER_STATUS_CLASS[cnt > 0 ? 'complete' : 'waiting'])}>
                  {cnt} гузариш
                </span>
              </div>
              {/* metric columns — net figure leads, count/avg step back */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 divide-x divide-line">
                <div className="px-5 py-4">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold">Гузариш</p>
                  <p className={cn('money text-lg font-semibold font-mono mt-2', colorMap[cur].text)}>
                    {formatCurrency(gross, cur)}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold">Баргашт</p>
                  <p className="money text-lg font-semibold font-mono mt-2 text-red-500 dark:text-red-400">
                    {ret > 0 ? formatCurrency(ret, cur) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  </p>
                </div>
                <div className="px-5 py-4 bg-black/[0.015] dark:bg-white/[0.03]">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Соф</p>
                  <p className={cn('money text-2xl font-extrabold font-mono mt-2 tracking-tight', net >= 0 ? colorMap[cur].text : 'text-red-600 dark:text-red-400')}>
                    {formatCurrency(net, cur)}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold">Шумора</p>
                  <p className="money text-sm font-medium font-mono mt-2 text-ink-muted">{cnt}</p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold">Миёна</p>
                  <p className="money text-sm font-medium font-mono mt-2 text-ink-muted">
                    {avg > 0 ? formatCurrency(avg, cur) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                  </p>
                </div>
              </div>
            </div>
          );
        })}

        {!hasAnyData && (
          <div className="text-center py-16 glass-panel rounded-2xl border border-line shadow-sm">
            <div className="w-12 h-12 rounded-xl bg-brand-green/10 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-3">
              <BarChart3 className="w-6 h-6 text-brand-green dark:text-emerald-400" />
            </div>
            <p className="text-ink-muted font-medium">Дар ин давра маълумоте вуҷуд надорад</p>
          </div>
        )}
      </div>

      {/* ── Trend charts ── */}
      {showChart && (
        <div
          className={cn(
            'grid gap-6',
            (currencyFilter === 'ALL' ? 1 + (hasEur ? 1 : 0) + (hasCny ? 1 : 0) : 1) >= 3
              ? 'xl:grid-cols-3'
              : (currencyFilter === 'ALL' ? 1 + (hasEur ? 1 : 0) + (hasCny ? 1 : 0) : 1) >= 2
              ? 'xl:grid-cols-2'
              : 'grid-cols-1'
          )}
        >
          {(currencyFilter === 'ALL' || currencyFilter === 'USD') && transferTotals.USD > 0 && (
            <SmallBarChart
              title={`${chartPeriodLabel} · USD Соф`}
              data={usdTrend}
              colorClass="bg-emerald-500"
            />
          )}
          {(currencyFilter === 'ALL' || currencyFilter === 'EUR') && hasEur && (
            <SmallBarChart
              title={`${chartPeriodLabel} · EUR Соф`}
              data={eurTrend}
              colorClass="bg-blue-500"
            />
          )}
          {(currencyFilter === 'ALL' || currencyFilter === 'CNY') && hasCny && (
            <SmallBarChart
              title={`${chartPeriodLabel} · CNY Соф`}
              data={cnyTrend}
              colorClass="bg-yellow-500"
            />
          )}
        </div>
      )}

      {/* ── Company share donut ── */}
      {companyBreakdown.length > 1 && (
        <DonutChart
          title={`Ҳиссаи ширкатҳо · ${currencyFilter === 'ALL' ? 'USD' : currencyFilter}`}
          data={companyBreakdown.map((row) => ({
            label: row.name,
            value: currencyFilter === 'EUR' ? row.eur : currencyFilter === 'CNY' ? row.cny : row.usd,
          }))}
        />
      )}

      {/* ── Company breakdown table ── */}
      {companyBreakdown.length > 0 && (
        <div className="glass-panel rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center gap-3">
            <h3 className="font-bold text-gray-800 dark:text-gray-100">Таҳлил аз рӯйи ширкат</h3>
            <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">{companyBreakdown.length} ширкат</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-max">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-500 text-[10px] uppercase tracking-wider">
                  <th className="text-left px-4 py-3 font-semibold sticky left-0 bg-gray-50 dark:bg-gray-900">Ширкат</th>
                  <th className="text-right px-4 py-3 font-semibold">Шум.</th>
                  {(currencyFilter === 'ALL' || currencyFilter === 'USD') && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-emerald-600 dark:text-emerald-400">USD</th>
                      <th className="text-right px-4 py-3 font-semibold text-red-400 dark:text-red-400">Барг.$</th>
                      <th className="text-right px-4 py-3 font-semibold text-emerald-700 dark:text-emerald-400">Соф$</th>
                    </>
                  )}
                  {(currencyFilter === 'ALL' || currencyFilter === 'EUR') && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-blue-600 dark:text-blue-400">EUR</th>
                      <th className="text-right px-4 py-3 font-semibold text-red-400 dark:text-red-400">Барг.€</th>
                      <th className="text-right px-4 py-3 font-semibold text-blue-700 dark:text-blue-400">Соф€</th>
                    </>
                  )}
                  {(currencyFilter === 'ALL' || currencyFilter === 'CNY') && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-yellow-600 dark:text-yellow-400">CNY</th>
                      <th className="text-right px-4 py-3 font-semibold text-red-400 dark:text-red-400">Барг.¥</th>
                      <th className="text-right px-4 py-3 font-semibold text-yellow-700 dark:text-yellow-400">Соф¥</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {companyBreakdown.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50/70 dark:hover:bg-gray-800/70 transition-colors">
                    <td className="px-4 py-3 font-semibold text-gray-800 dark:text-white sticky left-0 bg-white dark:bg-gray-900">{row.name}</td>
                    <td className="text-right px-4 py-3 font-mono text-gray-500 dark:text-gray-300">{row.count}</td>
                    {(currencyFilter === 'ALL' || currencyFilter === 'USD') && (
                      <>
                        <td className="text-right px-4 py-3 font-mono text-emerald-700 dark:text-emerald-400">
                          {row.usd > 0 ? formatCurrency(row.usd, 'USD') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                        <td className="text-right px-4 py-3 font-mono text-red-400 dark:text-red-400">
                          {row.retUsd > 0 ? formatCurrency(row.retUsd, 'USD') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                        <td className={cn('text-right px-4 py-3 font-mono font-bold', row.netUsd >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                          {formatCurrency(row.netUsd, 'USD')}
                        </td>
                      </>
                    )}
                    {(currencyFilter === 'ALL' || currencyFilter === 'EUR') && (
                      <>
                        <td className="text-right px-4 py-3 font-mono text-blue-700 dark:text-blue-400">
                          {row.eur > 0 ? formatCurrency(row.eur, 'EUR') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                        <td className="text-right px-4 py-3 font-mono text-red-400 dark:text-red-400">
                          {row.retEur > 0 ? formatCurrency(row.retEur, 'EUR') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                        <td className={cn('text-right px-4 py-3 font-mono font-bold', row.netEur >= 0 ? 'text-blue-700 dark:text-blue-400' : 'text-red-600 dark:text-red-400')}>
                          {row.eur > 0 || row.retEur > 0 ? formatCurrency(row.netEur, 'EUR') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                      </>
                    )}
                    {(currencyFilter === 'ALL' || currencyFilter === 'CNY') && (
                      <>
                        <td className="text-right px-4 py-3 font-mono text-yellow-700 dark:text-yellow-400">
                          {row.cny > 0 ? formatCurrency(row.cny, 'CNY') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                        <td className="text-right px-4 py-3 font-mono text-red-400 dark:text-red-400">
                          {row.retCny > 0 ? formatCurrency(row.retCny, 'CNY') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                        <td className={cn('text-right px-4 py-3 font-mono font-bold', row.netCny >= 0 ? 'text-yellow-700 dark:text-yellow-400' : 'text-red-600 dark:text-red-400')}>
                          {row.cny > 0 || row.retCny > 0 ? formatCurrency(row.netCny, 'CNY') : <span className="text-gray-200 dark:text-gray-600">—</span>}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
type MetricCardProps = {
  title: string;
  subtitle: string;
  value: string;
  extra: string;
};

function MetricCard({ title, subtitle, value, extra }: MetricCardProps) {
  return (
    <div className="glass-panel rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 min-w-0 overflow-hidden">
      <p className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{title}</p>
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 break-words">{subtitle}</p>
      <div className="mt-4 font-bold font-mono text-brand-green-dark dark:text-emerald-400 leading-tight whitespace-nowrap overflow-hidden text-ellipsis text-[clamp(1rem,1.6vw,1.6rem)]">
        <span className="tracking-tight">{value}</span>
      </div>
      <div className="mt-3 text-xs text-gray-500 dark:text-gray-400 break-words">{extra}</div>
    </div>
  );
}

function Modal({
  isOpen,
  onClose,
  title,
  children
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="glass-panel elevation-3 rounded-3xl w-full max-w-md overflow-hidden"
      >
        <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors" aria-label="Пӯшидан">
            <Plus className="w-6 h-6 rotate-45 text-gray-400 dark:text-gray-500" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </motion.div>
    </div>
  );
}