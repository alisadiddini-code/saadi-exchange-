export type Currency = "USD" | "CNY";

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
}

export type ReturnsByDate = Record<string, Record<string, number>>;

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
    }
  | {
      type: "MOVE_COMPANY";
      companyId: string;
      direction: "up" | "down";
    }
  | { type: "DELETE_TRANSFER"; id: string }
  | { type: "DELETE_COMPANY"; id: string }
  | { type: "DELETE_BANK"; id: string };

export type ServerMessage =
  | { type: "INIT"; data: AppData }
  | { type: "UPDATE"; data: AppData };