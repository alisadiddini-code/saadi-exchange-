// api/transfers.ts
// این فایل رو توی پروژه saadi-exchange (نه بات) بذار
// مسیر: api/transfers.ts
//
// وقتی بات این URL رو صدا می‌زنه:
// GET /api/transfers?date=2026-05-14
// این endpoint داده‌های امروز رو از Supabase می‌گیره و برمی‌گردونه

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// Supabase client — مقادیر رو از environment variables می‌خونه
// VITE_SUPABASE_URL از قبل داری — SUPABASE_SERVICE_ROLE_KEY رو جدید اضافه می‌کنی
const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // فقط GET مجاز هست
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // تاریخ رو از query param بخون، اگه نبود امروز رو بگیر
  const date =
    typeof req.query.date === "string"
      ? req.query.date
      : new Date().toISOString().split("T")[0]; // مثلاً "2026-05-14"

  try {
    // transfers امروز رو با اطلاعات بانک و شرکت join می‌کنیم
    const { data: transfers, error } = await supabase
      .from("transfers")
      .select(`
        id,
        amount,
        currency,
        transfer_date,
        account,
        note,
        bank_id,
        company_id,
        banks ( id, name ),
        companies ( id, name )
      `)
      .eq("transfer_date", date); // فیلتر بر اساس تاریخ

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    // داده رو به فرمت مورد نیاز بات تبدیل می‌کنیم
    const formatted = (transfers || []).map((t: any) => ({
      id: t.id,
      date: t.transfer_date,
      bank: t.banks?.name || "نامشخص",
      company: t.companies?.name || "نامشخص",
      currency: t.currency || "USD",
      amount: Number(t.amount) || 0,
      account: t.account || "",
      note: t.note || "",
    }));

    return res.status(200).json({ transfers: formatted });
  } catch (err: any) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: err.message });
  }
}
