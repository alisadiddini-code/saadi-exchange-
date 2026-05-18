import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const date =
      typeof req.query.date === "string"
        ? req.query.date
        : new Date().toISOString().slice(0, 10);

    const supabaseUrl =
      process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase URL",
        needed: "VITE_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL",
      });
    }

    if (!serviceKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const { data, error } = await supabase
      .from("transfers")
      .select(`
        id,
        amount,
        currency,
        transfer_date,
        date,
        account,
        note,
        bank_id,
        company_id,
        banks (
          id,
          name
        ),
        companies (
          id,
          name
        )
      `)
      .or(`transfer_date.eq.${date},date.eq.${date}`)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: "Supabase query failed",
        details: error.message,
      });
    }

    const transfers = (data || []).map((t: any) => ({
      id: t.id,
      date: t.transfer_date || t.date || date,
      bank: t.banks?.name || "نامشخص",
      company: t.companies?.name || "نامشخص",
      currency: t.currency || "USD",
      amount: Number(t.amount || 0),
      account: t.account || "",
      note: t.note || "",
    }));

    return res.status(200).json({
      ok: true,
      date,
      count: transfers.length,
      transfers,
    });
  } catch (err: any) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err?.message || String(err),
    });
  }
}