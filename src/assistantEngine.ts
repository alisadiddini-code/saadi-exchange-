// Stage 7 — deterministic operational assistant engine.
//
// Deliberately isolated from App.tsx: this file contains zero React, zero
// Supabase calls, and zero runtime imports from App.tsx (only type-only
// imports, which are erased at compile time — no circular runtime
// dependency). Every function here is a pure function of
// (CommandCenterSummary, AssistantContext) -> data. It never mutates
// anything and never reaches outside the values it's given.
//
// This is explicitly NOT generative AI. Every response is produced by
// explicit if/else rules over fields that already exist on
// CommandCenterSummary (itself one pass over the day's transfers, built in
// App.tsx's buildCommandCenterSummary). No prediction, no invented
// causality, no financial advice.

import type {
  CommandCenterSummary,
  CommandCenterCompanyRow,
  AttentionKind,
} from './App';
import type { Currency } from './types';

// ── Presentation-only currency formatting ──────────────────────────────
// Deliberately duplicated (not imported) from App.tsx's currencySymbol/
// formatCurrency to avoid a runtime circular import between this file and
// App.tsx. Same output, same rounding — purely cosmetic, not a calculation.
const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', EUR: '€', CNY: '¥' };
function formatMoney(value: number, currency: Currency): string {
  return `${CURRENCY_SYMBOL[currency]}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ── Context model (section 2) ──────────────────────────────────────────
// Purely in-memory UI state, mirrored from App() — never persisted by this
// engine or anywhere else.
export type AssistantContext = {
  dateLabel: string;
  isToday: boolean;
  bankId: string | null;
  bankName: string | null;
  companyId: string | null;
  companyName: string | null;
  viewMode: 'tracker' | 'analytics';
  activeFilterLabel: string | null;
};

// ── Safe actions (section 6) ───────────────────────────────────────────
// Descriptors only — this engine never calls a handler itself. App.tsx
// pattern-matches on `type` and calls the one already-existing handler it
// names. Every action here is reversible and non-destructive by
// construction: none of them write to Supabase or touch a confirmation
// checkbox.
export type AssistantAction =
  | { type: 'selectCompany'; companyId: string; bankId: string; label: string }
  | { type: 'switchBank'; bankId: string; label: string }
  | {
      type: 'setAttentionFilter';
      kind: AttentionKind;
      label: string;
      companyIds: string[];
      jumpCompanyId: string;
      jumpBankId: string;
    }
  | { type: 'resetFilters'; label: string }
  | { type: 'scrollMissionControl'; label: string }
  | { type: 'openAnalytics'; label: string }
  | { type: 'jumpToday'; label: string };

// ── Message cards (section 7) ──────────────────────────────────────────
export type AssistantMessageType = 'summary' | 'attention' | 'success' | 'navigation' | 'limitation';

export type AssistantMessageCard = {
  id: string;
  /** Present on Q&A responses (the clicked chip's label); absent on the
   *  passive auto-generated insight cards. */
  questionLabel?: string;
  type: AssistantMessageType;
  title: string;
  paragraph: string;
  facts: string[];
  sourceContext: string;
  action?: AssistantAction;
};

let cardSeq = 0;
function card(
  type: AssistantMessageType,
  title: string,
  paragraph: string,
  facts: string[],
  sourceContext: string,
  questionLabel?: string,
  action?: AssistantAction
): AssistantMessageCard {
  cardSeq += 1;
  return {
    id: `assistant-card-${Date.now()}-${cardSeq}`,
    questionLabel,
    type,
    title,
    paragraph,
    facts,
    sourceContext,
    action,
  };
}

// ── Suggested questions (section 4) ────────────────────────────────────
export type AssistantIntentId =
  | 'attention'
  | 'topCompany'
  | 'bankIncomplete'
  | 'invoicesStatus'
  | 'swiftStatus'
  | 'returns'
  | 'summarizeDate'
  | 'summarizeCompany';

export type AssistantIntent = { id: AssistantIntentId; label: string };

const ALL_INTENTS: AssistantIntent[] = [
  { id: 'attention', label: 'Ба кадом чиз бояд диққат кард?' },
  { id: 'topCompany', label: 'Кадом ширкатро аввал бинам?' },
  { id: 'bankIncomplete', label: 'Кадом бонк гузаришҳои нопурра дорад?' },
  { id: 'invoicesStatus', label: 'Ҳама фактураҳо гирифта шудаанд?' },
  { id: 'swiftStatus', label: 'Ҳама SWIFT тасдиқ шудаанд?' },
  { id: 'returns', label: 'Ширкатҳои бо баргаштро нишон бидеҳ' },
  { id: 'summarizeDate', label: 'Ин санаро ҷамъбаст кун' },
  { id: 'summarizeCompany', label: 'Ширкати интихобшударо ҷамъбаст кун' },
];

/** "Summarize selected company" only makes sense — and only appears — once
 *  a company is actually selected in the tracker. Every other question is
 *  always answerable (even if the answer is "no data"). */
export function getSuggestedIntents(context: AssistantContext): AssistantIntent[] {
  return ALL_INTENTS.filter((intent) => intent.id !== 'summarizeCompany' || !!context.companyId);
}

export function getIntentLabel(intentId: AssistantIntentId): string {
  return ALL_INTENTS.find((i) => i.id === intentId)?.label ?? '';
}

// ── Passive insights (section 3) ───────────────────────────────────────
// 3-6 cards where the data supports that many; never padded with filler.
// Ordered so unresolved facts surface before an all-clear message.
export function buildAssistantInsights(summary: CommandCenterSummary, dateLabel: string): AssistantMessageCard[] {
  const src = `Дар асоси гузоришҳои санаи ${dateLabel}`;

  if (summary.totalTransfers === 0) {
    return [
      card(
        'limitation',
        'Барои ин сана гузориш нест',
        `Ягон гузариш барои санаи ${dateLabel} сабт нашудааст.`,
        [],
        src
      ),
    ];
  }

  const cards: AssistantMessageCard[] = [];

  if (summary.unresolved.notSent > 0) {
    cards.push(
      card(
        'attention',
        'Ба бонк фиристода нашудаанд',
        `${summary.unresolved.notSent} гузариш то ҳол ба бонк фиристода нашудааст.`,
        [`${summary.unresolved.notSent} гузариш`],
        src
      )
    );
  }
  if (summary.unresolved.missingSwift > 0) {
    cards.push(
      card(
        'attention',
        'Тасдиқи SWIFT норасон',
        `${summary.unresolved.missingSwift} тасдиқи SWIFT то ҳол норасон аст.`,
        [`${summary.unresolved.missingSwift} гузариш`],
        src
      )
    );
  }
  if (summary.unresolved.missingInvoice > 0) {
    cards.push(
      card(
        'attention',
        'Фактура норасон',
        `${summary.unresolved.missingInvoice} фактура то ҳол норасон аст.`,
        [`${summary.unresolved.missingInvoice} гузариш`],
        src
      )
    );
  }
  const top = summary.companyAttention[0];
  if (top) {
    cards.push(
      card(
        'attention',
        `«${top.companyName}» бузургтарин ҳаҷми корро дорад`,
        `«${top.companyName}» ҳоло ${top.pendingCount} гузариши нопурра дорад.`,
        [top.primaryReason ?? `${top.pendingCount} гузариши нопурра`],
        src,
        undefined,
        { type: 'selectCompany', companyId: top.companyId, bankId: top.bankId, label: `Кушодани ${top.companyName}` }
      )
    );
  }
  if (summary.transfersWithReturnsCount > 0) {
    cards.push(
      card(
        'attention',
        'Маблағи баргашта сабт шудааст',
        `Барои ${summary.transfersWithReturnsCount} ширкат маблағи баргашта сабт шудааст.`,
        [],
        src
      )
    );
  }

  if (cards.length === 0) {
    return [
      card(
        'success',
        'Ҳама гузаришҳо анҷом ёфтаанд',
        `Ҳамаи ${summary.totalTransfers} гузариши санаи ${dateLabel} тасдиқ шудаанд.`,
        [],
        src
      ),
    ];
  }

  return cards.slice(0, 6);
}

// ── Local response engine (section 5) ──────────────────────────────────
// Input: a predefined intent + the current CommandCenterSummary + the
// current UI context. Output: one message card. Never invents a value,
// never combines currencies, never returns advice beyond the facts already
// in `summary`.
export function answerIntent(
  intentId: AssistantIntentId,
  summary: CommandCenterSummary,
  context: AssistantContext
): AssistantMessageCard {
  const src = `Дар асоси санаи ${context.dateLabel}`;
  const q = getIntentLabel(intentId);

  switch (intentId) {
    case 'attention': {
      if (summary.totalTransfers === 0) {
        return card('limitation', 'Гузориш нест', `Барои санаи ${context.dateLabel} гузориш сабт нашудааст.`, [], src, q);
      }
      const total = summary.unresolved.notSent + summary.unresolved.missingInvoice + summary.unresolved.missingSwift;
      if (total === 0 && summary.transfersWithReturnsCount === 0) {
        return card(
          'success',
          'Ҳама чиз тартиб аст',
          `Ҳамаи ${summary.totalTransfers} гузариши ин сана анҷом ёфтаанд.`,
          [],
          src,
          q
        );
      }
      const facts: string[] = [];
      if (summary.unresolved.notSent > 0) facts.push(`${summary.unresolved.notSent} ба бонк фиристода нашуд`);
      if (summary.unresolved.missingInvoice > 0) facts.push(`${summary.unresolved.missingInvoice} фактура норасон`);
      if (summary.unresolved.missingSwift > 0) facts.push(`${summary.unresolved.missingSwift} SWIFT норасон`);
      if (summary.transfersWithReturnsCount > 0) facts.push(`${summary.transfersWithReturnsCount} ширкат бо баргашт`);
      const top = summary.companyAttention[0];
      return card(
        'attention',
        'Диққат лозим аст',
        `${total} гузариш дар ин сана ҳанӯз нопурра аст.`,
        facts,
        src,
        q,
        top ? { type: 'selectCompany', companyId: top.companyId, bankId: top.bankId, label: `Кушодани ${top.companyName}` } : undefined
      );
    }

    case 'topCompany': {
      const top = summary.companyAttention[0];
      if (!top) {
        return card(
          'success',
          'Ҳеҷ ширкате диққат намехоҳад',
          'Дар айни ҳол ягон ширкат гузариши нопурра надорад.',
          [],
          src,
          q
        );
      }
      const facts: string[] = [];
      if (top.notSent > 0) facts.push(`${top.notSent} ба бонк фиристода нашуд`);
      if (top.missingInvoice > 0) facts.push(`${top.missingInvoice} фактура норасон`);
      if (top.missingSwift > 0) facts.push(`${top.missingSwift} SWIFT норасон`);
      if (top.hasReturnIssue) facts.push('Маблағи баргашта сабт шудааст');
      return card(
        'attention',
        top.companyName,
        `«${top.companyName}» ҳоло бузургтарин ҳаҷми кори нопурраро дорад (${top.pendingCount} гузариш).`,
        facts,
        src,
        q,
        { type: 'selectCompany', companyId: top.companyId, bankId: top.bankId, label: `Кушодани ${top.companyName}` }
      );
    }

    case 'bankIncomplete': {
      const incomplete = summary.bankWorkload.filter((b) => b.incompleteCount > 0);
      if (incomplete.length === 0) {
        return card(
          'success',
          'Ҳама бонкҳо анҷом ёфтаанд',
          'Дар ҳама бонкҳо гузаришҳои ин сана анҷом ёфтаанд.',
          [],
          src,
          q
        );
      }
      const worst = [...incomplete].sort((a, b) => b.incompleteCount - a.incompleteCount)[0];
      const facts = incomplete.map((b) => `${b.bankName}: ${b.incompleteCount} нопурра (${b.completionPct}% анҷом ёфт)`);
      return card(
        'attention',
        'Бонкҳои бо кори нопурра',
        `${incomplete.length} бонк гузаришҳои нопурра дорад.`,
        facts,
        src,
        q,
        { type: 'switchBank', bankId: worst.bankId, label: `Гузариш ба ${worst.bankName}` }
      );
    }

    case 'invoicesStatus': {
      if (context.bankId && context.bankName) {
        const bank = summary.bankWorkload.find((b) => b.bankId === context.bankId);
        const missing = bank?.missingInvoice ?? 0;
        if (missing === 0) {
          return card(
            'success',
            `${context.bankName}: ҳама фактураҳо гирифта шудаанд`,
            `Барои «${context.bankName}» ҳамаи фактураҳо тасдиқ шудаанд.`,
            [],
            src,
            q
          );
        }
        return card(
          'attention',
          `${context.bankName}: фактура норасон`,
          `Барои «${context.bankName}» ${missing} фактура норасон аст.`,
          [`${missing} фактура`],
          src,
          q,
          { type: 'switchBank', bankId: context.bankId, label: `Гузариш ба ${context.bankName}` }
        );
      }
      const missing = summary.unresolved.missingInvoice;
      if (missing === 0) {
        return card('success', 'Ҳама фактураҳо гирифта шудаанд', 'Барои ин сана ҳамаи фактураҳо тасдиқ шудаанд.', [], src, q);
      }
      return card('attention', 'Фактура норасон', `${missing} фактура барои ин сана норасон аст.`, [`${missing} гузариш`], src, q);
    }

    case 'swiftStatus': {
      if (context.bankId && context.bankName) {
        const bank = summary.bankWorkload.find((b) => b.bankId === context.bankId);
        const missing = bank?.missingSwift ?? 0;
        if (missing === 0) {
          return card(
            'success',
            `${context.bankName}: ҳама SWIFT тасдиқ шудаанд`,
            `Барои «${context.bankName}» ҳамаи тасдиқҳои SWIFT гирифта шудаанд.`,
            [],
            src,
            q
          );
        }
        return card(
          'attention',
          `${context.bankName}: SWIFT норасон`,
          `Барои «${context.bankName}» ${missing} тасдиқи SWIFT норасон аст.`,
          [`${missing} гузариш`],
          src,
          q,
          { type: 'switchBank', bankId: context.bankId, label: `Гузариш ба ${context.bankName}` }
        );
      }
      const missing = summary.unresolved.missingSwift;
      if (missing === 0) {
        return card('success', 'Ҳама SWIFT тасдиқ шудаанд', 'Барои ин сана ҳамаи тасдиқҳои SWIFT гирифта шудаанд.', [], src, q);
      }
      return card('attention', 'SWIFT норасон', `${missing} тасдиқи SWIFT барои ин сана норасон аст.`, [`${missing} гузариш`], src, q);
    }

    case 'returns': {
      const withReturns = summary.allCompanyRows.filter((c) => c.hasReturnIssue);
      if (withReturns.length === 0) {
        return card('success', 'Маблағи баргашта нест', 'Барои ин сана маблағи баргашта сабт нашудааст.', [], src, q);
      }
      const facts = withReturns.map((c) => c.companyName);
      const first = withReturns[0];
      return card(
        'attention',
        'Ширкатҳо бо маблағи баргашта',
        `${withReturns.length} ширкат маблағи баргашта дорад.`,
        facts,
        src,
        q,
        {
          type: 'setAttentionFilter',
          kind: 'hasReturnIssue',
          label: 'Маблағи баргашта',
          companyIds: withReturns.map((c) => c.companyId),
          jumpCompanyId: first.companyId,
          jumpBankId: first.bankId,
        }
      );
    }

    case 'summarizeDate': {
      if (summary.totalTransfers === 0) {
        return card('limitation', 'Гузориш нест', `Барои санаи ${context.dateLabel} гузориш сабт нашудааст.`, [], src, q);
      }
      const facts = summary.currencySummaries.map(
        (row) => `${row.currency}: ${formatMoney(row.net, row.currency)} софӣ · ${row.count} гузариш`
      );
      return card(
        'summary',
        `Ҷамъбасти санаи ${context.dateLabel}`,
        `${summary.totalTransfers} гузариш, ${summary.fullyCompletedTransfers} анҷом ёфт (${summary.completionPercentage}%).`,
        facts,
        src,
        q
      );
    }

    case 'summarizeCompany': {
      if (!context.companyId) {
        return card('limitation', 'Ширкат интихоб нашудааст', 'Барои ҷамъбаст аввал як ширкатро интихоб кунед.', [], src, q);
      }
      const row: CommandCenterCompanyRow | undefined = summary.allCompanyRows.find((c) => c.companyId === context.companyId);
      if (!row) {
        return card(
          'limitation',
          `${context.companyName ?? 'Ширкат'}: гузориш нест`,
          `Барои «${context.companyName ?? ''}» дар санаи ${context.dateLabel} гузориш сабт нашудааст.`,
          [],
          src,
          q
        );
      }
      const facts: string[] = [`${row.transferCount} гузариш`];
      if (row.pendingCount === 0) {
        return card(
          'success',
          `${row.companyName}: анҷом ёфт`,
          `Ҳамаи ${row.transferCount} гузариши «${row.companyName}» анҷом ёфтааст.`,
          facts,
          src,
          q
        );
      }
      if (row.notSent > 0) facts.push(`${row.notSent} ба бонк фиристода нашуд`);
      if (row.missingInvoice > 0) facts.push(`${row.missingInvoice} фактура норасон`);
      if (row.missingSwift > 0) facts.push(`${row.missingSwift} SWIFT норасон`);
      if (row.hasReturnIssue) facts.push('Маблағи баргашта сабт шудааст');
      return card(
        'attention',
        `${row.companyName}: ${row.pendingCount} нопурра`,
        `«${row.companyName}» ${row.pendingCount} гузариши нопурра дорад.`,
        facts,
        src,
        q
      );
    }
  }
}
