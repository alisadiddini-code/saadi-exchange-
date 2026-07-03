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
  Banknote,
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
  Send
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
import { motion, AnimatePresence } from 'motion/react';
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
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 overflow-hidden">
      <div className="text-lg font-bold text-gray-800 mb-4">{title}</div>

      <div className="h-64 flex items-end gap-3">
        {data.map((item) => {
          const height = Math.max((item.value / maxValue) * 100, item.value > 0 ? 6 : 0);

          return (
            <div key={item.label} className="flex-1 min-w-0 flex flex-col items-center justify-end gap-2">
              <div className="text-[10px] text-gray-400 font-mono truncate max-w-full">
                {item.value > 0 ? numberFormat(item.value) : ''}
              </div>
              <div className="w-full h-44 flex items-end">
                <div
                  className={cn('w-full rounded-t-xl transition-all', colorClass)}
                  style={{ height: `${height}%` }}
                  title={`${item.label}: ${numberFormat(item.value)}`}
                />
              </div>
              <div className="text-[11px] text-gray-500">{item.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
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
  return freshData;
};

useEffect(() => {
  loadAllFromSupabase();
}, []);


const sendMessage = async (msg: ClientMessage) => {
  console.log('Supabase action:', msg);

  if (msg.type === 'ADD_BANK') {
    const { error } = await supabase.from('banks').insert({ name: msg.name });
    if (error) return alert('خطا در افزودن بانک: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'ADD_COMPANY') {
    const { error } = await supabase.from('companies').insert({
      name: msg.name,
      bank_id: msg.bankId,
      sort_order: data.companies.filter((c) => c.bankId === msg.bankId).length,
    });
    if (error) return alert('خطا در افزودن شرکت: ' + error.message);
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
      alert('Хато дар иловаи интиқол: ' + (error?.message || 'Маълумот сабт нашуд'));
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
      alert('خطا дар вироиши гузариш: ' + (error?.message || 'Маълумот нав нашуд'));
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
      alert('خطا дар حذف انتقال: ' + error.message);
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
    alert('Хато дар сабти тасдиқ: ' + error.message);
    // Бозгашт ба ҳолати қаблӣ дар сурати хато
    setData((prev) => ({
      ...prev,
      transfers: prev.transfers.map((t) => (t.id === id ? { ...t, [key]: !value } : t)),
    }));
  }
};

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
      alert('خطа дар ثبت برگашт: ' + error.message);
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

    if (e1 || e2) return alert('Хато дар иваз кардани ҷой: ' + (e1?.message || e2?.message));
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

    if (error) return alert('Хато: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'DELETE_COMPANY') {
    const { error } = await supabase.from('companies').delete().eq('id', msg.id);
    if (error) return alert('خطا дар حذف ширкат: ' + error.message);
    await loadAllFromSupabase();
    return;
  }

  if (msg.type === 'DELETE_BANK') {
    const { error } = await supabase.from('banks').delete().eq('id', msg.id);
    if (error) return alert('خطا дар حذف бонк: ' + error.message);
    await loadAllFromSupabase();
    return;
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

  const bankTotals = calculateBankTotals();
  const canEditDailyFields = dateFilterMode === 'day';

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
    <div className="min-h-screen flex flex-col max-w-7xl mx-auto px-4 py-6">
      <header className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-brand-green-dark flex items-center gap-2">
              <Banknote className="w-8 h-8" />
              Saadi Exchange
            </h1>
            <p className="text-gray-500 text-sm mt-1">Системаи назорати гузаришҳои рӯзона</p>
          </div>

          <div className="flex items-center gap-3 bg-white p-2 rounded-xl shadow-sm border border-gray-100">
            <button
              type="button"
              onClick={() => {
                const d = new Date(selectedDate);
                d.setDate(d.getDate() - 1);
                setSelectedDate(format(d, 'yyyy-MM-dd'));
              }}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ChevronLeft className="w-5 h-5 text-gray-600" />
            </button>

            <div className="flex items-center gap-2 px-2 font-medium text-gray-700">
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
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ChevronRight className="w-5 h-5 text-gray-600" />
            </button>
          </div>
        </div>

        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setViewMode('tracker')}
              className={cn(
                'px-4 py-2 rounded-xl text-sm font-semibold border transition-colors',
                viewMode === 'tracker'
                  ? 'bg-brand-green text-white border-brand-green'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-brand-green/50'
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
                  ? 'bg-brand-green text-white border-brand-green'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-brand-green/50'
              )}
            >
              <BarChart3 className="w-4 h-4" />
              Таҳлил
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-sm text-gray-500">
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
                    ? 'bg-brand-green text-white border-brand-green'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-brand-green/50'
                )}
              >
                {tajikRangeLabel(mode)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-4 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          {data.banks.map((bank) => (
            <button
              key={bank.id}
              type="button"
              onClick={() => setSelectedBankId(bank.id)}
              className={cn(
                'px-4 py-2 rounded-full text-sm font-medium transition-all border',
                selectedBankId === bank.id
                  ? 'bg-brand-green text-white border-brand-green shadow-md shadow-brand-green/20'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-brand-green/50'
              )}
            >
              {bank.name}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setIsAddingBank(true)}
            className="p-2 rounded-full bg-white border border-dashed border-gray-300 text-gray-400 hover:text-brand-green hover:border-brand-green transition-colors"
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
          <div className="bg-white border border-gray-100 rounded-2xl px-4 py-3 shadow-sm flex items-center gap-3">
            <Search className="w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Ҷустуҷӯ аз рӯйи маблағ, асъор, рақами ҳисоб, соат, сана ё ширкат..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-transparent outline-none text-sm text-gray-700 placeholder:text-gray-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200"
              >
                Пок
              </button>
            )}
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl px-4 py-3 shadow-sm flex items-center gap-3">
            <ArrowUpDown className="w-4 h-4 text-gray-400" />
            <select
              value={companySortMode}
              onChange={(e) => setCompanySortMode(e.target.value as CompanySortMode)}
              className="bg-transparent outline-none text-sm text-gray-700"
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
            className="px-4 py-3 rounded-2xl bg-white border border-gray-100 shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            Excel
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={exportAnalyticsPDF}
              disabled={!selectedBank}
              className="px-4 py-3 rounded-2xl bg-white border border-gray-100 shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
            >
              <FileText className="w-4 h-4 text-red-500" />
              PDF
            </button>

            <button
              type="button"
              onClick={printProfessionalReport}
              disabled={!selectedBank}
              className="px-4 py-3 rounded-2xl bg-white border border-gray-100 shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
            >
              <Printer className="w-4 h-4 text-blue-500" />
              Чоп
            </button>
          </div>
        </div>
      </div>

      <main className="flex-1">
        {viewMode === 'tracker' ? (
          selectedBank ? (
            <div className="flex flex-col md:flex-row gap-6 items-start">
              <div className="w-full md:w-64 shrink-0 bg-white rounded-2xl border border-gray-100 shadow-sm p-3 md:sticky md:top-4">
                <div className="flex md:flex-col gap-2 overflow-x-auto md:overflow-visible pb-1 md:pb-0">
                  {visibleCompanies.map((company) => {
                    const isSelected = company.id === selectedCompanyId;
                    const companyTotals = summarizeByCurrency(getCompanyTransfersForCurrentFilter(company.id));

                    return (
                      <button
                        key={company.id}
                        type="button"
                        onClick={() => setSelectedCompanyId(company.id)}
                        className={cn(
                          'text-left px-3 py-2.5 rounded-xl border transition-colors shrink-0 md:w-full whitespace-nowrap md:whitespace-normal',
                          isSelected
                            ? 'bg-brand-green text-white border-brand-green shadow-sm'
                            : 'bg-white text-gray-600 border-gray-100 hover:border-brand-green/40 hover:bg-brand-green-light/40'
                        )}
                      >
                        <div className="font-semibold text-sm">{company.name}</div>
                        <div className={cn('text-[10px] mt-0.5 font-mono', isSelected ? 'text-white/80' : 'text-gray-400')}>
                          {formatCurrency(companyTotals.USD, 'USD')}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => setIsAddingCompany(true)}
                  className="mt-2 w-full border-2 border-dashed border-gray-200 rounded-xl py-2.5 flex items-center justify-center gap-2 text-gray-400 hover:text-brand-green hover:border-brand-green transition-all text-sm font-medium shrink-0"
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
                  <div className="text-center py-20 bg-white rounded-3xl border border-gray-100 shadow-sm">
                    <Building2 className="w-16 h-16 text-gray-200 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-gray-700">Ширкат вуҷуд надорад</h3>
                    <p className="text-gray-500 mt-2">Аввал ширкат илова кунед</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-20 bg-white rounded-3xl border border-gray-100 shadow-sm">
              <Building2 className="w-16 h-16 text-gray-200 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-gray-700">Бонк вуҷуд надорад</h3>
              <p className="text-gray-500 mt-2">Аввал бонк илова кунед</p>
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
        <div className="mt-10 bg-brand-green-dark text-white p-6 rounded-3xl shadow-xl flex flex-col md:flex-row items-center justify-between gap-4">
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
            className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-brand-green focus:border-transparent outline-none"
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
            className="w-full p-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-brand-green focus:border-transparent outline-none"
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

      <div
        className={cn(
          'fixed bottom-4 right-4 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest',
          wsConnected ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'
        )}
      >
        {wsConnected ? 'Пайваст шуд' : 'Пайвастшавӣ...'}
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

  useEffect(() => {
    const val = returnedAmounts[returnCurrency];
    setReturnInput(val ? String(val) : '');
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
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex flex-col min-h-[720px]"
    >
      <div className="p-5 border-b border-gray-50 flex items-center justify-between bg-gray-50/30">
        <div>
          <h3 className="font-bold text-gray-800 text-lg">{company.name}</h3>
          <div className="text-xs text-gray-400 mt-1">Намоиш: {filterLabel}</div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="p-1 rounded bg-white border border-gray-200 disabled:opacity-30"
              title="Боло"
            >
              <ChevronUp className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="p-1 rounded bg-white border border-gray-200 disabled:opacity-30"
              title="Поён"
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

          <div className="text-xs font-mono bg-white px-2 py-1 rounded border border-gray-100 text-gray-500">
            ID: {company.id.slice(0, 4)}
          </div>
          <button
            type="button"
            onClick={onDeleteCompany}
            className="p-2 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
            title="Нести ширкат"
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
              className="w-full py-3 px-4 border border-dashed border-gray-200 rounded-xl text-sm text-gray-500 hover:border-brand-green hover:text-brand-green transition-colors flex items-center justify-center gap-2 shrink-0"
            >
              <Plus className="w-4 h-4" /> Иловаи гузариш
            </button>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-2 bg-gray-50 p-3 rounded-xl border border-gray-100 shrink-0">
              <div className="flex gap-2">
                <input
                  ref={amountInputRef}
                  type="number"
                  placeholder={`Маблағ (${currency})`}
                  className="flex-1 p-2 rounded-lg border border-gray-200 text-sm focus:ring-1 focus:ring-brand-green outline-none"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  step="0.01"
                />

                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                  className="p-2 rounded-lg border border-gray-200 text-sm outline-none"
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
                className="w-full p-2 rounded-lg border border-gray-200 text-xs focus:ring-1 focus:ring-brand-green outline-none"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              <div className="flex justify-between items-center">
                <span className="text-[10px] text-gray-400 uppercase font-bold">Enter барои сабт</span>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="text-[10px] text-gray-400 hover:text-gray-600 uppercase font-bold"
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

        <div className="space-y-2 pr-2 border border-gray-100 rounded-xl p-3 bg-white">
          {visibleTransfers.length === 0 ? (
            <p className="text-center text-xs text-gray-400 py-10 italic">
              {transfers.length === 0 ? 'Дар ин давра гузариш нест' : 'Аз рӯйи ҷустуҷӯ чизе ёфт нашуд'}
            </p>
          ) : (
            visibleTransfers.map((t, index) => {
              const isEditing = editingTransferId === t.id;

              return (
                <div key={t.id} className="border-b border-gray-50 pb-2 last:border-b-0">
                  {!isEditing ? (
                    <div className="flex items-start justify-between gap-2 flex-wrap group">
                      <div className="flex items-start gap-3 min-w-0">
                        <div className="text-[10px] text-white bg-gray-400 rounded-full w-5 h-5 flex items-center justify-center font-bold mt-0.5 shrink-0">
                          {index + 1}
                        </div>
                        <div className="text-[10px] text-gray-400 font-mono pt-1 min-w-[34px] shrink-0">
                          {format(parseISO(t.timestamp), 'HH:mm')}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="text-sm font-bold text-gray-700 break-all">
                              {formatCurrency(t.amount, t.currency)}
                            </div>
                            <span className={cn(
                              'text-[10px] px-2 py-0.5 rounded-full font-semibold',
                              t.currency === 'USD'
                                ? 'bg-emerald-100 text-emerald-700'
                                : t.currency === 'EUR'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-yellow-100 text-yellow-700'
                            )}>
                              {t.currency}
                            </span>
                          </div>
                          {t.note && (
                            <div className="text-[10px] text-gray-500 mt-0.5 break-all">{t.note}</div>
                          )}
                          <div className="text-[10px] text-gray-300 mt-0.5">{t.date}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap justify-end ml-auto shrink-0">
                        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                          <label className="flex items-center gap-1 cursor-pointer select-none" title="Омода / Ба бонк фиристода шуд">
                            <input
                              type="checkbox"
                              checked={t.preparedConfirmed}
                              onChange={(e) => onUpdateConfirmation(t.id, 'prepared', e.target.checked)}
                              className="w-3.5 h-3.5 rounded-sm border-gray-300 accent-brand-green cursor-pointer"
                            />
                            <span className="text-[9px] font-semibold text-gray-500 whitespace-nowrap">Омода</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer select-none" title="Фактура гирифта шуд">
                            <input
                              type="checkbox"
                              checked={t.invoiceConfirmed}
                              onChange={(e) => onUpdateConfirmation(t.id, 'invoice', e.target.checked)}
                              className="w-3.5 h-3.5 rounded-sm border-gray-300 accent-brand-green cursor-pointer"
                            />
                            <span className="text-[9px] font-semibold text-gray-500 whitespace-nowrap">Фактура</span>
                          </label>
                          <label className="flex items-center gap-1 cursor-pointer select-none" title="SWIFT гирифта шуд">
                            <input
                              type="checkbox"
                              checked={t.swiftConfirmed}
                              onChange={(e) => onUpdateConfirmation(t.id, 'swift', e.target.checked)}
                              className="w-3.5 h-3.5 rounded-sm border-gray-300 accent-brand-green cursor-pointer"
                            />
                            <span className="text-[9px] font-semibold text-gray-500 whitespace-nowrap">SWIFT</span>
                          </label>
                        </div>

                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                          <button
                            type="button"
                            onClick={() => startEdit(t)}
                            className="p-1 text-gray-300 hover:text-blue-500 transition-all"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteTransfer(t.id)}
                            className="p-1 text-gray-300 hover:text-red-500 transition-all"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          value={editAmount}
                          onChange={(e) => setEditAmount(e.target.value)}
                          className="flex-1 p-2 rounded-lg border border-gray-200 text-sm focus:ring-1 focus:ring-brand-green outline-none"
                          step="0.01"
                        />

                        <select
                          value={editCurrency}
                          onChange={(e) => setEditCurrency(e.target.value as Currency)}
                          className="p-2 rounded-lg border border-gray-200 text-sm outline-none"
                        >
                          <option value="USD">USD</option>
                          <option value="EUR">EUR</option>
                          <option value="CNY">CNY</option>
                        </select>

                        <button
                          type="button"
                          onClick={saveEdit}
                          className="p-2 rounded-lg bg-brand-green text-white hover:bg-brand-green-dark transition-colors"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="p-2 rounded-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <input
                        type="text"
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="Рақами ҳисоб / Эзоҳ..."
                        className="w-full p-2 rounded-lg border border-gray-200 text-xs focus:ring-1 focus:ring-brand-green outline-none"
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="p-5 bg-gray-50/50 border-t border-gray-100 space-y-4">
        <div className="space-y-2 text-sm text-gray-500">
          <div className="flex items-center justify-between gap-3">
            <span>Ҳамагӣ USD</span>
            <span className="font-mono font-medium text-gray-700 text-right break-all">
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
              <span className="font-mono font-medium text-gray-700 text-right break-all">
                {formatCurrency(totals.CNY, 'CNY')}
              </span>
            </div>
          )}
        </div>

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
                canEditReturn ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-100 text-gray-400'
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
                  ? 'bg-white border-gray-200 focus:ring-1 focus:ring-red-400'
                  : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
              )}
              value={returnInput}
              onChange={(e) => setReturnInput(e.target.value)}
              onBlur={() => {
                if (!canEditReturn) return;
                onUpdateReturn(parseFloat(returnInput) || 0, returnCurrency);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              placeholder="0.00"
              step="0.01"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-gray-200 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-bold text-gray-800">Софӣ USD</span>
            <span
              className={cn(
                'text-[clamp(1.5rem,2.2vw,2rem)] font-bold font-mono leading-none text-right break-all max-w-[60%]',
                netUsd >= 0 ? 'text-brand-green-dark' : 'text-red-600'
              )}
            >
              {formatCurrency(netUsd, 'USD')}
            </span>
          </div>

          {(totals.EUR > 0 || returnedEur > 0) && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-bold text-gray-800">Софӣ EUR</span>
              <span
                className={cn(
                  'text-[clamp(1.3rem,2vw,1.8rem)] font-bold font-mono text-right break-all max-w-[60%]',
                  netEur >= 0 ? 'text-blue-700' : 'text-red-600'
                )}
              >
                {formatCurrency(netEur, 'EUR')}
              </span>
            </div>
          )}

          {(totals.CNY > 0 || returnedCny > 0) && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-bold text-gray-800">Софӣ CNY</span>
              <span
                className={cn(
                  'text-[clamp(1.3rem,2vw,1.8rem)] font-bold font-mono text-right break-all max-w-[60%]',
                  netCny >= 0 ? 'text-yellow-700' : 'text-red-600'
                )}
              >
                {formatCurrency(netCny, 'CNY')}
              </span>
            </div>
          )}
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
  if (period === 'day') return [];

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
      <div className="text-center py-20 bg-white rounded-3xl border border-gray-100 shadow-sm">
        <BarChart3 className="w-16 h-16 text-gray-200 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-gray-700">Бонк интихоб нашудааст</h3>
        <p className="text-gray-500 mt-2">Барои дидани таҳлил аввал бонкро интихоб кунед.</p>
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
  const showChart = period !== 'day' && trendData.length > 0;

  const chartPeriodLabel =
    period === 'all' ? 'Тренди моҳона' :
    period === 'month' ? 'Рӯзона дар моҳ' : 'Рӯзона дар ҳафта';

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

  const colorMap: Record<Currency, { text: string; bg: string; btnActive: string }> = {
    USD: { text: 'text-emerald-700', bg: 'bg-emerald-50', btnActive: 'bg-emerald-500 text-white' },
    EUR: { text: 'text-blue-700',    bg: 'bg-blue-50',    btnActive: 'bg-blue-500 text-white'    },
    CNY: { text: 'text-yellow-700',  bg: 'bg-yellow-50',  btnActive: 'bg-yellow-500 text-white'  },
  };

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
        <div className="flex gap-1 bg-white border border-gray-100 rounded-xl p-1 shadow-sm">
          {(['day', 'week', 'month', 'all'] as AnalyticsPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
                period === p ? 'bg-brand-green text-white' : 'text-gray-500 hover:bg-gray-100'
              )}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Currency filter */}
        <div className="flex gap-1 bg-white border border-gray-100 rounded-xl p-1 shadow-sm">
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
                  : 'text-gray-500 hover:bg-gray-100'
              )}
            >
              {c === 'ALL' ? 'Ҳама' : c}
            </button>
          ))}
        </div>

        <span className="text-sm font-medium text-gray-600 bg-white border border-gray-100 rounded-xl px-3 py-2 shadow-sm">
          {selectedBank.name} · {periodLabel}
        </span>

        {period === 'all' && bankTransfers.length > 0 && (
          <span className="text-xs text-gray-400 bg-white border border-gray-100 rounded-xl px-3 py-2 shadow-sm">
            Ҳамагӣ {bankTransfers.length} гузариш
          </span>
        )}
      </div>

      {/* ── Per-currency summary blocks ── */}
      <div className="grid grid-cols-1 gap-4">
        {activeCurrencies.map((cur) => {
          const gross = transferTotals[cur];
          const ret = periodReturns[cur];
          const net = netTotals[cur];
          const cnt = countByCurrency[cur];
          const avg = avgByCurrency[cur];
          if (currencyFilter === 'ALL' && gross === 0 && ret === 0) return null;
          return (
            <div key={cur} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              {/* currency header */}
              <div className={cn('px-5 py-3 border-b border-gray-100 flex items-center gap-3', colorMap[cur].bg)}>
                <span className={cn('font-bold text-lg tracking-wide', colorMap[cur].text)}>
                  {currencySymbol(cur)} {cur}
                </span>
                <span className="text-xs text-gray-400 ml-auto">{cnt} гузариш</span>
              </div>
              {/* metric columns */}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 divide-x divide-gray-50">
                <div className="px-5 py-4">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Гузариш</p>
                  <p className={cn('text-xl font-bold font-mono mt-2', colorMap[cur].text)}>
                    {formatCurrency(gross, cur)}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Баргашт</p>
                  <p className="text-xl font-bold font-mono mt-2 text-red-500">
                    {ret > 0 ? formatCurrency(ret, cur) : <span className="text-gray-300">—</span>}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Соф</p>
                  <p className={cn('text-xl font-bold font-mono mt-2', net >= 0 ? colorMap[cur].text : 'text-red-600')}>
                    {formatCurrency(net, cur)}
                  </p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Шумора</p>
                  <p className="text-xl font-bold font-mono mt-2 text-gray-700">{cnt}</p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Миёна</p>
                  <p className="text-xl font-bold font-mono mt-2 text-gray-500">
                    {avg > 0 ? formatCurrency(avg, cur) : <span className="text-gray-300">—</span>}
                  </p>
                </div>
              </div>
            </div>
          );
        })}

        {!hasAnyData && (
          <div className="text-center py-16 bg-white rounded-2xl border border-gray-100 shadow-sm">
            <BarChart3 className="w-12 h-12 text-gray-200 mx-auto mb-3" />
            <p className="text-gray-400 font-medium">Дар ин давра маълумоте вуҷуд надорад</p>
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

      {/* ── Company breakdown table ── */}
      {companyBreakdown.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
            <h3 className="font-bold text-gray-800">Таҳлил аз рӯйи ширкат</h3>
            <span className="text-xs text-gray-400 ml-auto">{companyBreakdown.length} ширкат</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-max">
              <thead>
                <tr className="bg-gray-50 text-gray-400 text-[10px] uppercase tracking-wider">
                  <th className="text-left px-4 py-3 font-semibold sticky left-0 bg-gray-50">Ширкат</th>
                  <th className="text-right px-4 py-3 font-semibold">Шум.</th>
                  {(currencyFilter === 'ALL' || currencyFilter === 'USD') && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-emerald-600">USD</th>
                      <th className="text-right px-4 py-3 font-semibold text-red-400">Барг.$</th>
                      <th className="text-right px-4 py-3 font-semibold text-emerald-700">Соф$</th>
                    </>
                  )}
                  {(currencyFilter === 'ALL' || currencyFilter === 'EUR') && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-blue-600">EUR</th>
                      <th className="text-right px-4 py-3 font-semibold text-red-400">Барг.€</th>
                      <th className="text-right px-4 py-3 font-semibold text-blue-700">Соф€</th>
                    </>
                  )}
                  {(currencyFilter === 'ALL' || currencyFilter === 'CNY') && (
                    <>
                      <th className="text-right px-4 py-3 font-semibold text-yellow-600">CNY</th>
                      <th className="text-right px-4 py-3 font-semibold text-red-400">Барг.¥</th>
                      <th className="text-right px-4 py-3 font-semibold text-yellow-700">Соф¥</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {companyBreakdown.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50/70 transition-colors">
                    <td className="px-4 py-3 font-semibold text-gray-800 sticky left-0 bg-white">{row.name}</td>
                    <td className="text-right px-4 py-3 font-mono text-gray-500">{row.count}</td>
                    {(currencyFilter === 'ALL' || currencyFilter === 'USD') && (
                      <>
                        <td className="text-right px-4 py-3 font-mono text-emerald-700">
                          {row.usd > 0 ? formatCurrency(row.usd, 'USD') : <span className="text-gray-200">—</span>}
                        </td>
                        <td className="text-right px-4 py-3 font-mono text-red-400">
                          {row.retUsd > 0 ? formatCurrency(row.retUsd, 'USD') : <span className="text-gray-200">—</span>}
                        </td>
                        <td className={cn('text-right px-4 py-3 font-mono font-bold', row.netUsd >= 0 ? 'text-emerald-700' : 'text-red-600')}>
                          {formatCurrency(row.netUsd, 'USD')}
                        </td>
                      </>
                    )}
                    {(currencyFilter === 'ALL' || currencyFilter === 'EUR') && (
                      <>
                        <td className="text-right px-4 py-3 font-mono text-blue-700">
                          {row.eur > 0 ? formatCurrency(row.eur, 'EUR') : <span className="text-gray-200">—</span>}
                        </td>
                        <td className="text-right px-4 py-3 font-mono text-red-400">
                          {row.retEur > 0 ? formatCurrency(row.retEur, 'EUR') : <span className="text-gray-200">—</span>}
                        </td>
                        <td className={cn('text-right px-4 py-3 font-mono font-bold', row.netEur >= 0 ? 'text-blue-700' : 'text-red-600')}>
                          {row.eur > 0 || row.retEur > 0 ? formatCurrency(row.netEur, 'EUR') : <span className="text-gray-200">—</span>}
                        </td>
                      </>
                    )}
                    {(currencyFilter === 'ALL' || currencyFilter === 'CNY') && (
                      <>
                        <td className="text-right px-4 py-3 font-mono text-yellow-700">
                          {row.cny > 0 ? formatCurrency(row.cny, 'CNY') : <span className="text-gray-200">—</span>}
                        </td>
                        <td className="text-right px-4 py-3 font-mono text-red-400">
                          {row.retCny > 0 ? formatCurrency(row.retCny, 'CNY') : <span className="text-gray-200">—</span>}
                        </td>
                        <td className={cn('text-right px-4 py-3 font-mono font-bold', row.netCny >= 0 ? 'text-yellow-700' : 'text-red-600')}>
                          {row.cny > 0 || row.retCny > 0 ? formatCurrency(row.netCny, 'CNY') : <span className="text-gray-200">—</span>}
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
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 min-w-0 overflow-hidden">
      <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{title}</p>
      <p className="text-xs text-gray-400 mt-1 break-words">{subtitle}</p>
      <div className="mt-4 font-bold font-mono text-brand-green-dark leading-tight whitespace-nowrap overflow-hidden text-ellipsis text-[clamp(1rem,1.6vw,1.6rem)]">
        <span className="tracking-tight">{value}</span>
      </div>
      <div className="mt-3 text-xs text-gray-500 break-words">{extra}</div>
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
        className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden"
      >
        <div className="p-6 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-800">{title}</h2>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <Plus className="w-6 h-6 rotate-45 text-gray-400" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </motion.div>
    </div>
  );
}