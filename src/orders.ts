import { supabase } from './lib/supabase';
import { AppData, Bank, Company, Currency, Order, Transfer } from './types';

function normalizeCurrency(v: unknown): Currency {
  if (v === 'CNY') return 'CNY';
  if (v === 'EUR') return 'EUR';
  return 'USD';
}

function buildNote(row: any): string {
  const parts: string[] = [];
  if (row.company_name)          parts.push(`Beneficiary: ${row.company_name}`);
  if (row.account_number)        parts.push(`Account: ${row.account_number}`);
  if (row.swift_code)            parts.push(`SWIFT: ${row.swift_code}`);
  if (row.beneficiary_bank_name) parts.push(`Bene Bank: ${row.beneficiary_bank_name}`);
  if (row.notes)                 parts.push(row.notes);
  return parts.join(' | ');
}

function mapYusufRow(row: any, saadiCompanyId: string): Order {
  const date = typeof row.transfer_date === 'string'
    ? row.transfer_date.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return {
    id:        String(row.source_id),
    companyId: saadiCompanyId,
    bankId:    row.bank_id ? String(row.bank_id) : '',
    amount:    Number(row.amount) || 0,
    currency:  normalizeCurrency(row.currency),
    note:      buildNote(row),
    timestamp: row.created_at || new Date().toISOString(),
    date,
    sourceType:       'whatsapp',
    workflowStatus:   row.workflow_status   || 'received',
    extractionStatus: row.extraction_status ?? undefined,
    confidenceScore:  row.confidence_score != null ? Number(row.confidence_score) : undefined,
    orderNumber:      row.order_number      ? Number(row.order_number) : undefined,
    contractNumber:   row.contract_number   || undefined,
    companyName:      row.company_name      || undefined,
    bankName:         row.bank_name         || undefined,
  };
}

export async function loadYusufOrders(): Promise<AppData> {
  // 1. Real Saadi banks
  const { data: banksData, error: banksErr } = await supabase
    .from('banks').select('*').order('created_at', { ascending: true });
  if (banksErr) { console.error('[Yusuf] banks:', banksErr); return { banks: [], companies: [], transfers: [], returns: {} }; }
  const banks: Bank[] = (banksData || []).map((b: any) => ({ id: String(b.id), name: String(b.name || '') }));

  // 2. Real Saadi accounting companies
  const { data: companiesData, error: companiesErr } = await supabase
    .from('companies').select('*').order('sort_order', { ascending: true });
  if (companiesErr) { console.error('[Yusuf] companies:', companiesErr); return { banks, companies: [], transfers: [], returns: {} }; }
  const saadiCompanies: Company[] = (companiesData || []).map((c: any) => ({
    id:             String(c.id),
    bankId:         String(c.bank_id),
    name:           String(c.name || ''),
    sortOrder:      Number(c.sort_order ?? 0),
    returnedAmount: c.returned_amount != null ? Number(c.returned_amount) : undefined,
  }));

  // 3. Load mappings -> Map<"company_name|bank_id", saadi_company_id>
  const { data: mappingsData } = await supabase
    .from('yusuf_saadi_company_mappings').select('*');
  const mappings = new Map<string, string>();
  for (const m of mappingsData || []) {
    mappings.set(`${m.beneficiary_company_name}|${m.our_bank_id}`, String(m.saadi_company_id));
  }

  // 4. Load v_saadi_orders
  const { data: ordersData, error: ordersErr } = await supabase
    .from('v_saadi_orders').select('*')
    .order('transfer_date', { ascending: true })
    .order('created_at',    { ascending: true });
  if (ordersErr) { console.error('[Yusuf] v_saadi_orders:', ordersErr); return { banks, companies: saadiCompanies, transfers: [], returns: {} }; }

  // 5. Map each order — look up saadi company, fall back to synthetic unmatched card
  const syntheticUnmatched = new Map<string, Company>();
  const transfers: Order[] = [];

  for (const row of ordersData || []) {
    const bankId      = row.bank_id ? String(row.bank_id) : '';
    const companyName = row.company_name || '';
    const mappingKey  = `${companyName}|${bankId}`;

    let saadiCompanyId: string;
    if (mappings.has(mappingKey)) {
      saadiCompanyId = mappings.get(mappingKey)!;
    } else {
      const unmatchedId = `_yusuf_unmatched_${bankId || 'nobank'}`;
      if (!syntheticUnmatched.has(unmatchedId)) {
        syntheticUnmatched.set(unmatchedId, {
          id: unmatchedId, bankId,
          name: '⚠️ Unmatched Yusuf Orders', sortOrder: 9999,
        });
      }
      saadiCompanyId = unmatchedId;
    }
    transfers.push(mapYusufRow(row, saadiCompanyId));
  }

  console.log('[Yusuf] loaded:', { banks: banks.length, saadiCompanies: saadiCompanies.length, unmatched: syntheticUnmatched.size, orders: transfers.length });
  return {
    banks,
    companies: [...saadiCompanies, ...syntheticUnmatched.values()],
    transfers: transfers as unknown as Transfer[],
    returns: {},
  };
}

export async function saveYusufMapping(
  beneficiaryCompanyName: string,
  ourBankId: string,
  saadiCompanyId: string,
): Promise<{ error: any }> {
  const { error } = await supabase
    .from('yusuf_saadi_company_mappings')
    .upsert({
      beneficiary_company_name: beneficiaryCompanyName,
      our_bank_id:              ourBankId,
      saadi_company_id:         saadiCompanyId,
      confidence:               1.0,
    }, { onConflict: 'beneficiary_company_name,our_bank_id' });
  if (error) console.error('[Yusuf] saveMapping error:', error);
  return { error };
}
