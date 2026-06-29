// src/orders.ts — ExchangeOS Phase 2A
// Yusuf Mode adapter: loads AppData from v_saadi_orders.
// The UI is source-agnostic — it always reads AppData.
// Future: loadArchiveOrders() follows the same pattern in Phase 3.

import { supabase } from './lib/supabase';
import { AppData, Bank, Company, Currency, Order, Transfer } from './types';

function normalizeCurrencyLocal(value: unknown): Currency {
  if (value === 'CNY') return 'CNY';
  if (value === 'EUR') return 'EUR';
  return 'USD';
}

function deriveCompanyId(row: any): string {
  if (row.beneficiary_company_id) return String(row.beneficiary_company_id);
  if (row.company_name) return '_cn_' + String(row.company_name).trim().toLowerCase();
  return '_unmatched_' + String(row.bank_id || 'unknown');
}

function mapYusufRow(row: any): Order {
  const transferDate = typeof row.transfer_date === 'string'
    ? row.transfer_date.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return {
    id: String(row.source_id),
    companyId: deriveCompanyId(row),
    bankId: row.bank_id ? String(row.bank_id) : '',
    amount: Number(row.amount) || 0,
    currency: normalizeCurrencyLocal(row.currency),
    note: row.notes || '',
    timestamp: row.created_at || new Date().toISOString(),
    date: transferDate,
    sourceType: 'whatsapp',
    workflowStatus: row.workflow_status || 'received',
    extractionStatus: row.extraction_status ?? undefined,
    confidenceScore: row.confidence_score != null ? Number(row.confidence_score) : undefined,
    orderNumber: row.order_number ? Number(row.order_number) : undefined,
    contractNumber: row.contract_number || undefined,
    companyName: row.company_name || undefined,
    bankName: row.bank_name || undefined,
  };
}

function buildSyntheticCompanies(orders: Order[]): Company[] {
  const seen = new Map<string, Company>();
  for (const order of orders) {
    if (!seen.has(order.companyId)) {
      seen.set(order.companyId, {
        id: order.companyId,
        bankId: order.bankId,
        name: order.companyName || 'شرکت نامشخص',
        sortOrder: 0,
      });
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    const aS = a.id.startsWith('_'), bS = b.id.startsWith('_');
    if (aS !== bS) return aS ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

// Yusuf Mode data loader.
// Returns AppData from v_saadi_orders. Shape is identical to Manual Mode.
// Writes are disabled via canAddTransfers=false in App.tsx.
export async function loadYusufOrders(): Promise<AppData> {
  const { data: banksData, error: banksError } = await supabase
    .from('banks').select('*').order('created_at', { ascending: true });
  if (banksError) {
    console.error('[Yusuf] banks error:', banksError);
    return { banks: [], companies: [], transfers: [], returns: {} };
  }
  const banks: Bank[] = (banksData || []).map((b: any) => ({
    id: String(b.id), name: String(b.name || ''),
  }));
  const { data: ordersData, error: ordersError } = await supabase
    .from('v_saadi_orders').select('*')
    .order('transfer_date', { ascending: true })
    .order('created_at', { ascending: true });
  if (ordersError) {
    console.error('[Yusuf] v_saadi_orders error:', ordersError);
    return { banks, companies: [], transfers: [], returns: {} };
  }
  const orders: Order[] = (ordersData || []).map(mapYusufRow);
  const companies: Company[] = buildSyntheticCompanies(orders);
  console.log('[Yusuf] loaded:', { banks: banks.length, orders: orders.length, companies: companies.length });
  return { banks, companies, transfers: orders as unknown as Transfer[], returns: {} };
}
