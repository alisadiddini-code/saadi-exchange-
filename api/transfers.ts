import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return res.status(200).json({
    ok: true,
    date: new Date().toISOString().slice(0, 10),
    transfers: [
      {
        id: "test-1",
        bank: "AKTIV BANK",
        company: "KORVONSAROI CHIN",
        currency: "USD",
        amount: 125850
      }
    ]
  });
}