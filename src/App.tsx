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
  Printer
} from 'lucide-react';
import {
  format,
  parseISO,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval
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
  return currency === 'CNY' ? '¥' : '$';
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
    { USD: 0, CNY: 0 } as Record<Currency, number>
  );
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

    const returned = Object.entries(returnsMap[key] || {}).reduce((sum, [companyId, amount]) => {
      if (!companyIds.includes(companyId)) return sum;
      return sum + amount;
    }, 0);

    return {
      key,
      label: format(day, 'dd.MM'),
      totalUsd: totals.USD,
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
  const { data: banksData, error: banksError } = await supabase
    .from('banks')
    .select('*')
    .order('created_at', { ascending: true })

  if (banksError) {
    console.error('Supabase banks error:', banksError);
    return;
  }

  const { data: companiesData, error: companiesError } = await supabase
    .from('companies')
    .select('*')
    .order('created_at', { ascending: true })

  if (companiesError) {
    console.error('Supabase companies error:', companiesError);
    return;
  }

  const { data: transfersData, error: transfersError } = await supabase
    .from('transfers')
    .select('*')
    .order('created_at', { ascending: true })

  if (transfersError) {
    console.error('Supabase transfers error:', transfersError);
    return;
  }

  const { data: returnsData, error: returnsError } = await supabase
    .from('returns')
    .select('*');

  if (returnsError) {
    console.error('Supabase returns error:', returnsError);
    return;
  }

  const mappedBanks: Bank[] = (banksData || []).map((bank) => ({
    id: bank.id,
    name: bank.name,
  }));

  const mappedCompanies: Company[] = (companiesData || []).map((company) => ({
    id: company.id,
    name: company.name,
    bankId: company.bank_id,
    sortOrder: company.sort_order || 0,
  }));

  const mappedTransfers = transfersData.map((t: any) => ({
    id: t.id,
    amount: Number(t.amount || 0),
    currency: t.currency || "USD",
    note: t.note || "",
    date: t.transfer_date || t.date,
    timestamp: t.timestamp || t.created_at,
    bankId: t.bank_id,
    companyId: t.company_id,
  }));

  const mappedReturns: AppData['returns'] = {};
  (returnsData || []).forEach((item) => {
    if (!mappedReturns[item.return_date]) mappedReturns[item.return_date] = {};
    mappedReturns[item.return_date][item.company_id] = Number(item.amount || 0);
  });

  setData({
    banks: mappedBanks,
    companies: mappedCompanies,
    transfers: mappedTransfers,
    returns: mappedReturns,
  });

  if (mappedBanks.length > 0 && !selectedBankId) {
    setSelectedBankId(mappedBanks[0].id);
  }

  setWsConnected(true);
};

useEffect(() => {
  loadAllFromSupabase();
}, []);


  const sendMessage = async (msg: ClientMessage) => {
    console.log('Supabase action:', msg);

    

    if (msg.type === 'ADD_BANK') {
      const { error } = await supabase.from('banks').insert({ name: msg.name });
      if (error) return alert('خطا در افزودن بانک');
    }
    
    if (msg.type === 'ADD_COMPANY') {
      const { error } = await supabase.from('companies').insert({
        name: msg.name,
        bank_id: msg.bankId,
        sort_order: data.companies.filter((c) => c.bankId === msg.bankId).length,
      });
      if (error) return alert('خطا در افزودن شرکت');
    }

    if (msg.type === "ADD_TRANSFER") {
      const { error } = await supabase.from("transfers").insert({
        amount: Number(msg.amount),
        note: msg.note || "",
        currency: msg.currency || "USD",
        date: selectedDate,
        transfer_date: selectedDate,
        timestamp: new Date().toISOString(),
        bank_id: msg.bankId,
        company_id: msg.companyId,
      });

      if (error) {
        console.error("ADD_TRANSFER ERROR:", error);
        alert("خطا در افزودن انتقال: " + error.message);
        return;
      }

      await loadAllFromSupabase();
    }

    if (msg.type === 'UPDATE_TRANSFER') {
      const { error } = await supabase
        .from('transfers')
        .update({
          amount: msg.amount,
          note: msg.note || '',
          currency: msg.currency || 'USD',
        })
        .eq('id', msg.id);

      if (error) return alert('خطا در ویرایش انتقال');
    }

    if (msg.type === 'DELETE_TRANSFER') {
      const { error } = await supabase.from('transfers').delete().eq('id', msg.id);
      if (error) return alert('خطا در حذف انتقال');
    }

    if (msg.type === 'UPDATE_RETURN') {
      const { data, error } = await supabase
        .from('returns')
        .upsert(
          {
            company_id: msg.companyId,
            date: msg.date,
            amount: Number(msg.amount) || 0,
          },
          {
            onConflict: 'company_id,date',
          }
        )
        .select();

      console.log('RETURN SAVED:', data, error);

      if (error) {
        console.error('UPDATE_RETURN ERROR:', error);
        alert('خطا در ثبت برگشت: ' + error.message);
        return;
      }

      await loadSupabaseData();
      return;
    }

    if (msg.type === 'DELETE_COMPANY') {
      const { error } = await supabase.from('companies').delete().eq('id', msg.id);
      if (error) return alert('خطا در حذف شرکت');
    }

    if (msg.type === 'DELETE_BANK') {
      const { error } = await supabase.from('banks').delete().eq('id', msg.id);
      if (error) return alert('خطا در حذف بانک');
    }

    await loadAllFromSupabase();
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

  const getCompanyReturnForCurrentFilter = (companyId: string) => {
    if (dateFilterMode === 'day') {
      return data.returns[selectedDate]?.[companyId] || 0;
    }

    return Object.entries(data.returns).reduce((sum, [dateKey, companyReturns]) => {
      if (dateFilterMode !== 'all' && activeRange) {
        if (!isDateWithinRange(dateKey, activeRange.start, activeRange.end)) return sum;
      }
      return sum + (companyReturns[companyId] || 0);
    }, 0);
  };

  const sortedCompanies = useMemo(() => {
    const base = [...filteredCompanies];

    const getNet = (companyId: string) => {
      const transfers = getCompanyTransfersForCurrentFilter(companyId).filter((t) => t.currency === 'USD');
      const totalTransfers = transfers.reduce((sum, t) => sum + t.amount, 0);
      const returned = getCompanyReturnForCurrentFilter(companyId);
      return totalTransfers - returned;
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

        acc.USD += totals.USD - returned;
        acc.CNY += totals.CNY;
        return acc;
      },
      { USD: 0, CNY: 0 }
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
      transferSheetRows.push(['', '', '', 'CNY', totals.CNY, '']);
      transferSheetRows.push(['', '', '', 'Баргашт', returned, '']);
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
        numberFormat(totals.CNY),
        numberFormat(returned),
      ];
    });

    autoTable(doc, {
      startY: 32,
      head: [['Company', 'Count', 'USD', 'CNY', 'Returned']],
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
        cny: totals.CNY,
        returned,
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
            <td>¥${numberFormat(row.cny)}</td>
            <td>$${numberFormat(row.returned)}</td>
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
                <th>CNY</th>
                <th>Баргашт</th>
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <AnimatePresence mode="popLayout">
                {visibleCompanies.map((company, index) => (
                  <CompanyCard
                    key={company.id}
                    company={company}
                    transfers={getCompanyTransfersForCurrentFilter(company.id)}
                    visibleTransfers={getVisibleCompanyTransfers(company.id, company.name)}
                    returnedAmount={getCompanyReturnForCurrentFilter(company.id)}
                    canAddTransfers={canEditDailyFields}
                    canEditReturn={canEditDailyFields}
                    filterLabel={tajikRangeLabel(dateFilterMode)}
                    isIbt={selectedBank.name.toUpperCase() === 'IBT'}
                    canMoveUp={companySortMode === 'manual' && index > 0}
                    canMoveDown={companySortMode === 'manual' && index < visibleCompanies.length - 1}
                    onMoveUp={() => sendMessage({ type: 'MOVE_COMPANY', companyId: company.id, direction: 'up' })}
                    onMoveDown={() => sendMessage({ type: 'MOVE_COMPANY', companyId: company.id, direction: 'down' })}
                    onAddTransfer={(amount, note, currency) =>
                      sendMessage({
                        type: 'ADD_TRANSFER',
                        companyId: company.id,
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
                    onUpdateReturn={(amount) =>
                      sendMessage({
                        type: 'UPDATE_RETURN',
                        companyId: company.id,
                        amount,
                        date: selectedDate
                      })
                    }
                    onDeleteTransfer={(id) => sendMessage({ type: 'DELETE_TRANSFER', id })}
                    onDeleteCompany={() => handleDeleteCompany(company)}
                  />
                ))}
              </AnimatePresence>

              <button
                type="button"
                onClick={() => setIsAddingCompany(true)}
                className="border-2 border-dashed border-gray-200 rounded-2xl p-8 flex flex-col items-center justify-center text-gray-400 hover:text-brand-green hover:border-brand-green transition-all group min-h-[220px]"
              >
                <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center mb-3 group-hover:bg-brand-green-light transition-colors">
                  <Plus className="w-6 h-6" />
                </div>
                <span className="font-medium">Иловаи ширкат</span>
              </button>
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
  returnedAmount: number;
  canAddTransfers: boolean;
  canEditReturn: boolean;
  filterLabel: string;
  isIbt: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddTransfer: (amount: number, note: string, currency: Currency) => void;
  onUpdateTransfer: (id: string, amount: number, note: string, currency: Currency) => void;
  onUpdateReturn: (amount: number) => void;
  onDeleteTransfer: (id: string) => void;
  onDeleteCompany: () => void;
};

function CompanyCard({
  company,
  transfers,
  visibleTransfers,
  returnedAmount,
  canAddTransfers,
  canEditReturn,
  filterLabel,
  isIbt,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onAddTransfer,
  onUpdateTransfer,
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

  const totals = summarizeByCurrency(transfers);
  const netUsd = totals.USD - returnedAmount;

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
                  {isIbt && <option value="CNY">CNY</option>}
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

        <div className="space-y-2 h-96 overflow-y-auto pr-2 border border-gray-100 rounded-xl p-3 bg-white">
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
                    <div className="flex items-start justify-between group">
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
                              t.currency === 'USD' ? 'bg-emerald-100 text-emerald-700' : 'bg-yellow-100 text-yellow-700'
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
                          {isIbt && <option value="CNY">CNY</option>}
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
            <span>Баргашт (USD)</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">$</span>
            <input
              type="number"
              disabled={!canEditReturn}
              className={cn(
                'w-32 border rounded-lg px-3 py-2 text-sm font-mono text-right outline-none',
                canEditReturn
                  ? 'bg-white border-gray-200 focus:ring-1 focus:ring-red-400'
                  : 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
              )}
              value={returnedAmount || ''}
              onBlur={(e) => {
                if (!canEditReturn) return;
                onUpdateReturn(parseFloat(e.target.value) || 0);
              }}
              placeholder="0.00"
              step="0.01"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-gray-200 flex items-center justify-between gap-3">
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

        {totals.CNY > 0 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-base font-bold text-gray-800">Ҳамагӣ CNY</span>
            <span className="text-[clamp(1.3rem,2vw,1.8rem)] font-bold font-mono text-yellow-700">
              {formatCurrency(totals.CNY, 'CNY')}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

type AnalyticsViewProps = {
  data: AppData;
  selectedDate: string;
  selectedBank: Bank | null;
  companies: Company[];
};

function AnalyticsView({
  data,
  selectedDate,
  selectedBank,
  companies
}: AnalyticsViewProps) {
  if (!selectedBank) {
    return (
      <div className="text-center py-20 bg-white rounded-3xl border border-gray-100 shadow-sm">
        <BarChart3 className="w-16 h-16 text-gray-200 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-gray-700">Бонк интихоб нашудааст</h3>
        <p className="text-gray-500 mt-2">Барои дидани таҳлил аввал бонкро интихоб кунед.</p>
      </div>
    );
  }

  const companyIds = companies.map((company) => company.id);
  const bankTransfers = data.transfers.filter((transfer) => transfer.bankId === selectedBank.id);

  const selectedDateObj = parseISO(`${selectedDate}T00:00:00`);
  const weekStart = startOfWeek(selectedDateObj, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(selectedDateObj, { weekStartsOn: 1 });
  const monthStart = startOfMonth(selectedDateObj);
  const monthEnd = endOfMonth(selectedDateObj);

  const getReturnedTotalInRange = (start: Date, end: Date) => {
    return Object.entries(data.returns).reduce((sum, [dateKey, dateReturns]) => {
      if (!isDateWithinRange(dateKey, start, end)) return sum;

      return (
        sum +
        Object.entries(dateReturns).reduce((innerSum, [companyId, amount]) => {
          if (!companyIds.includes(companyId)) return innerSum;
          return innerSum + amount;
        }, 0)
      );
    }, 0);
  };

  const dailyTransfers = bankTransfers.filter((transfer) => transfer.date === selectedDate);
  const weeklyTransfers = bankTransfers.filter((transfer) => isDateWithinRange(transfer.date, weekStart, weekEnd));
  const monthlyTransfers = bankTransfers.filter((transfer) => isDateWithinRange(transfer.date, monthStart, monthEnd));

  const dailyTotals = summarizeByCurrency(dailyTransfers);
  const weeklyTotals = summarizeByCurrency(weeklyTransfers);
  const monthlyTotals = summarizeByCurrency(monthlyTransfers);

  const dailyReturnTotal = getReturnedTotalInRange(selectedDateObj, selectedDateObj);
  const weeklyReturnTotal = getReturnedTotalInRange(weekStart, weekEnd);
  const monthlyReturnTotal = getReturnedTotalInRange(monthStart, monthEnd);

  const chartSeries = buildDailySeries(
    bankTransfers,
    data.returns,
    companyIds,
    weekStart,
    weekEnd
  );

  const usdSeries = chartSeries.map((item) => ({ label: item.label, value: item.netUsd }));
  const cnySeries = chartSeries.map((item) => ({ label: item.label, value: item.totalCny }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <MetricCard
          title="USD рӯз"
          subtitle={format(parseISO(selectedDate), 'dd.MM.yyyy')}
          value={formatCurrency(dailyTotals.USD - dailyReturnTotal, 'USD')}
          extra={`Шумора: ${dailyTransfers.length}`}
        />
        <MetricCard
          title="CNY рӯз"
          subtitle={format(parseISO(selectedDate), 'dd.MM.yyyy')}
          value={formatCurrency(dailyTotals.CNY, 'CNY')}
          extra={`IBT ва дигар ҳисобҳо`}
        />
        <MetricCard
          title="USD ҳафта"
          subtitle={`${format(weekStart, 'dd.MM')} - ${format(weekEnd, 'dd.MM')}`}
          value={formatCurrency(weeklyTotals.USD - weeklyReturnTotal, 'USD')}
          extra={`Шумора: ${weeklyTransfers.length}`}
        />
        <MetricCard
          title="CNY ҳафта"
          subtitle={`${format(weekStart, 'dd.MM')} - ${format(weekEnd, 'dd.MM')}`}
          value={formatCurrency(weeklyTotals.CNY, 'CNY')}
          extra="Ҳаҷми юан"
        />
        <MetricCard
          title="USD моҳ"
          subtitle={format(monthStart, 'MM.yyyy')}
          value={formatCurrency(monthlyTotals.USD - monthlyReturnTotal, 'USD')}
          extra={`Шумора: ${monthlyTransfers.length}`}
        />
        <MetricCard
          title="CNY моҳ"
          subtitle={format(monthStart, 'MM.yyyy')}
          value={formatCurrency(monthlyTotals.CNY, 'CNY')}
          extra="Ҳаҷми юан"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SmallBarChart title="Софии USD дар ҳафта" data={usdSeries} colorClass="bg-emerald-500" />
        <SmallBarChart title="Ҳаҷми CNY дар ҳафта" data={cnySeries} colorClass="bg-yellow-500" />
      </div>
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