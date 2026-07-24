import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface HoloStats {
  aktiv: { count: number; amount: number; currency: 'USD' };
  ibt: { count: number; amount: number; currency: 'USD' };
  totalTransfers: number;
}

export interface HoloDiagnostics {
  supabaseStatus: 'ok' | 'error' | 'pending';
  realtimeStatus: RealtimeStatus;
  lastRefresh: string | null;
  dushanbeDate: string;
  aktivRecords: number;
  ibtRecords: number;
  lastError: string | null;
  demoActive: boolean;
}

export interface HoloDataState {
  stats: HoloStats;
  loading: boolean;
  dataLost: boolean;
  diagnostics: HoloDiagnostics;
  refresh: () => void;
}

const EMPTY_STATS: HoloStats = {
  aktiv: { count: 0, amount: 0, currency: 'USD' },
  ibt: { count: 0, amount: 0, currency: 'USD' },
  totalTransfers: 0,
};

export const DEMO_STATS: HoloStats = {
  aktiv: { count: 12, amount: 840000, currency: 'USD' },
  ibt: { count: 8, amount: 3250000, currency: 'USD' },
  totalTransfers: 20,
};

/** Today's date (YYYY-MM-DD) in Asia/Dushanbe, independent of device timezone. */
export function getDushanbeDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dushanbe',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

interface BankIds {
  aktiv: string | null;
  ibt: string | null;
}

async function fetchBankIds(): Promise<BankIds> {
  const { data, error } = await supabase.from('banks').select('id, name');
  if (error) throw new Error(`banks: ${error.message}`);

  const ids: BankIds = { aktiv: null, ibt: null };
  for (const bank of data ?? []) {
    const name = String(bank.name ?? '').toUpperCase();
    if (name.includes('AKTIV')) ids.aktiv = bank.id;
    else if (name.includes('IBT')) ids.ibt = bank.id;
  }
  return ids;
}

export function useHoloData(demoMode: boolean): HoloDataState {
  const [stats, setStats] = useState<HoloStats>(demoMode ? DEMO_STATS : EMPTY_STATS);
  const [loading, setLoading] = useState(true);
  const [dataLost, setDataLost] = useState(false);
  const [diagnostics, setDiagnostics] = useState<HoloDiagnostics>({
    supabaseStatus: 'pending',
    realtimeStatus: 'connecting',
    lastRefresh: null,
    dushanbeDate: getDushanbeDate(),
    aktivRecords: 0,
    ibtRecords: 0,
    lastError: null,
    demoActive: false,
  });

  const bankIdsRef = useRef<BankIds | null>(null);
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);
  const pendingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (fetchingRef.current) {
      pendingRef.current = true;
      return;
    }
    fetchingRef.current = true;

    try {
      if (!bankIdsRef.current) {
        bankIdsRef.current = await fetchBankIds();
      }
      const banks = bankIdsRef.current;
      const today = getDushanbeDate();

      // Only the minimal columns needed — no account numbers, names, SWIFT, etc.
      const { data, error } = await supabase
        .from('transfers')
        .select('bank_id, amount, currency, transfer_date, date')
        .or(`transfer_date.eq.${today},date.eq.${today}`);

      if (error) throw new Error(`transfers: ${error.message}`);

      let aktivCount = 0;
      let aktivAmount = 0;
      let ibtCount = 0;
      let ibtAmount = 0;

      for (const row of data ?? []) {
        const amount = Number(row.amount) || 0;
        if (banks.aktiv && row.bank_id === banks.aktiv) {
          aktivCount += 1;
          aktivAmount += amount;
        } else if (banks.ibt && row.bank_id === banks.ibt) {
          ibtCount += 1;
          ibtAmount += amount;
        }
      }

      if (!mountedRef.current) return;

      setStats({
        aktiv: { count: aktivCount, amount: aktivAmount, currency: 'USD' },
        ibt: { count: ibtCount, amount: ibtAmount, currency: 'USD' },
        totalTransfers: aktivCount + ibtCount,
      });
      setDataLost(false);
      setLoading(false);
      setDiagnostics((d) => ({
        ...d,
        supabaseStatus: 'ok',
        lastRefresh: new Date().toISOString(),
        dushanbeDate: today,
        aktivRecords: aktivCount,
        ibtRecords: ibtCount,
        lastError: null,
        demoActive: false,
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setLoading(false);
      setDiagnostics((d) => ({
        ...d,
        supabaseStatus: 'error',
        dushanbeDate: getDushanbeDate(),
        lastError: message,
        demoActive: demoMode,
      }));
      if (demoMode) {
        // Demo fallback only when explicitly requested via ?demo=true
        setStats(DEMO_STATS);
        setDataLost(false);
      } else {
        setDataLost(true);
      }
    } finally {
      fetchingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void refresh();
      }
    }
  }, [demoMode]);

  // Initial fetch + Dushanbe midnight rollover check
  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const dayCheck = window.setInterval(() => {
      setDiagnostics((d) => {
        const today = getDushanbeDate();
        if (d.dushanbeDate !== today) void refresh();
        return d;
      });
    }, 60_000);

    return () => {
      mountedRef.current = false;
      window.clearInterval(dayCheck);
    };
  }, [refresh]);

  // Realtime subscription (single channel, cleaned up on unmount)
  useEffect(() => {
    const channel = supabase
      .channel('holo-transfers')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transfers' },
        () => {
          // Never trust the payload for totals — always refetch today's data.
          void refresh();
        }
      )
      .subscribe((status) => {
        if (!mountedRef.current) return;
        setDiagnostics((d) => ({
          ...d,
          realtimeStatus:
            status === 'SUBSCRIBED'
              ? 'connected'
              : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT'
                ? 'reconnecting'
                : status === 'CLOSED'
                  ? 'offline'
                  : 'connecting',
        }));
        // Supabase JS auto-rejoins with backoff; refresh once reconnected
        if (status === 'SUBSCRIBED') void refresh();
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  return { stats, loading, dataLost, diagnostics, refresh };
}
