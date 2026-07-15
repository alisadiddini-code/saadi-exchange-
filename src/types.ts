export type Currency = "USD" | "EUR" | "CNY";

export interface Bank {
  id: string;
  name: string;
}

export interface Company {
  id: string;
  bankId: string;
  name: string;
  returnedAmount?: number;
  sortOrder?: number;
}

export interface Transfer {
  id: string;
  companyId: string;
  bankId: string;
  amount: number;
  note: string;
  timestamp: string;
  date: string;
  currency: Currency;
  preparedConfirmed: boolean;
  invoiceConfirmed: boolean;
  swiftConfirmed: boolean;
}

export type ReturnsByCurrency = Partial<Record<Currency, number>>;
export type ReturnsByDate = Record<string, Record<string, ReturnsByCurrency>>;

export interface AppData {
  banks: Bank[];
  companies: Company[];
  transfers: Transfer[];
  returns: ReturnsByDate;
}

export type ClientMessage =
  | { type: "ADD_BANK"; name: string }
  | { type: "ADD_COMPANY"; bankId: string; name: string }
  | {
      type: "ADD_TRANSFER";
      companyId: string;
      bankId: string;
      amount: number;
      note: string;
      date: string;
      currency: Currency;
    }
  | {
      type: "UPDATE_TRANSFER";
      id: string;
      amount: number;
      note: string;
      currency: Currency;
    }
  | {
      type: "UPDATE_RETURN";
      companyId: string;
      amount: number;
      date: string;
      currency: Currency;
    }
  | {
      type: "MOVE_COMPANY";
      companyId: string;
      direction: "up" | "down";
    }
  | { type: "MOVE_TO_TOP"; companyId: string }
  | { type: "DELETE_TRANSFER"; id: string }
  | { type: "DELETE_COMPANY"; id: string }
  | { type: "DELETE_BANK"; id: string };

export type ServerMessage =
  | { type: "INIT"; data: AppData }
  | { type: "UPDATE"; data: AppData };
