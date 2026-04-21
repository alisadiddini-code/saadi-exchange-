import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { AppData, ClientMessage, Company, ServerMessage, Transfer } from "./src/types";

const PORT = 3000;

const STORAGE_DIR = path.resolve(process.cwd(), "storage");
const DATA_FILE = path.join(STORAGE_DIR, "data.json");

const EMPTY_DATA: AppData = {
  banks: [],
  companies: [],
  transfers: [],
  returns: {},
};

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function normalizeCompanies(companies: any[]): Company[] {
  const byBankCounter = new Map<string, number>();

  return companies.map((company) => {
    const currentIndex = byBankCounter.get(company.bankId) ?? 0;
    byBankCounter.set(company.bankId, currentIndex + 1);

    return {
      id: typeof company?.id === "string" ? company.id : uuidv4(),
      bankId: typeof company?.bankId === "string" ? company.bankId : "",
      name: typeof company?.name === "string" ? company.name : "",
      returnedAmount:
        typeof company?.returnedAmount === "number" && Number.isFinite(company.returnedAmount)
          ? company.returnedAmount
          : 0,
      sortOrder:
        typeof company?.sortOrder === "number" && Number.isFinite(company.sortOrder)
          ? company.sortOrder
          : currentIndex,
    };
  });
}

function normalizeTransfers(transfers: any[]): Transfer[] {
  return transfers.map((transfer) => ({
    id: typeof transfer?.id === "string" ? transfer.id : uuidv4(),
    companyId: typeof transfer?.companyId === "string" ? transfer.companyId : "",
    bankId: typeof transfer?.bankId === "string" ? transfer.bankId : "",
    amount:
      typeof transfer?.amount === "number" && Number.isFinite(transfer.amount)
        ? transfer.amount
        : 0,
    note: typeof transfer?.note === "string" ? transfer.note : "",
    timestamp:
      typeof transfer?.timestamp === "string" ? transfer.timestamp : new Date().toISOString(),
    date: typeof transfer?.date === "string" ? transfer.date : "",
    currency: transfer?.currency === "CNY" ? "CNY" : "USD", // migration-safe default
  }));
}

function ensureDataShape(raw: any): AppData {
  return {
    banks: Array.isArray(raw?.banks) ? raw.banks : [],
    companies: Array.isArray(raw?.companies) ? normalizeCompanies(raw.companies) : [],
    transfers: Array.isArray(raw?.transfers) ? normalizeTransfers(raw.transfers) : [],
    returns:
      raw?.returns && typeof raw.returns === "object" && !Array.isArray(raw.returns)
        ? raw.returns
        : {},
  };
}

function loadData(): AppData {
  ensureStorage();
  console.log("Reading data from:", DATA_FILE);

  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log("storage/data.json not found. Creating a new one.");
      fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY_DATA, null, 2), "utf-8");
      return { ...EMPTY_DATA };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf-8");

    if (!raw.trim()) {
      console.log("storage/data.json is empty. Resetting to empty structure.");
      fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY_DATA, null, 2), "utf-8");
      return { ...EMPTY_DATA };
    }

    const parsed = JSON.parse(raw);
    const safeData = ensureDataShape(parsed);

    console.log(
      `Loaded ${safeData.banks.length} banks, ${safeData.companies.length} companies, ${safeData.transfers.length} transfers.`
    );

    return safeData;
  } catch (error) {
    console.error("Failed to load storage/data.json, using empty data.", error);
    return { ...EMPTY_DATA };
  }
}

let data: AppData = loadData();

function saveData() {
  try {
    ensureStorage();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save storage/data.json:", error);
  }
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function broadcastAll(wss: WebSocketServer) {
  const payload: ServerMessage = { type: "UPDATE", data };
  const json = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

function removeCompanyRelatedData(companyId: string) {
  data.transfers = data.transfers.filter((transfer) => transfer.companyId !== companyId);

  Object.keys(data.returns).forEach((dateKey) => {
    if (data.returns[dateKey]?.[companyId] !== undefined) {
      delete data.returns[dateKey][companyId];
    }

    if (Object.keys(data.returns[dateKey] || {}).length === 0) {
      delete data.returns[dateKey];
    }
  });
}

function removeBankRelatedData(bankId: string) {
  const companyIds = data.companies
    .filter((company) => company.bankId === bankId)
    .map((company) => company.id);

  companyIds.forEach((companyId) => removeCompanyRelatedData(companyId));

  data.companies = data.companies.filter((company) => company.bankId !== bankId);
  data.transfers = data.transfers.filter((transfer) => transfer.bankId !== bankId);
}

function reindexBankCompanies(bankId: string) {
  const bankCompanies = data.companies
    .filter((company) => company.bankId === bankId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  bankCompanies.forEach((company, index) => {
    company.sortOrder = index;
  });
}

function handleMessage(msg: ClientMessage) {
  switch (msg.type) {
    case "ADD_BANK": {
      const name = normalizeName(msg.name);
      if (!name) return;

      data.banks.push({
        id: uuidv4(),
        name,
      });
      break;
    }

    case "ADD_COMPANY": {
      const name = normalizeName(msg.name);
      if (!name) return;

      const bankExists = data.banks.some((bank) => bank.id === msg.bankId);
      if (!bankExists) return;

      const maxSort = Math.max(
        -1,
        ...data.companies
          .filter((company) => company.bankId === msg.bankId)
          .map((company) => company.sortOrder ?? 0)
      );

      data.companies.push({
        id: uuidv4(),
        bankId: msg.bankId,
        name,
        returnedAmount: 0,
        sortOrder: maxSort + 1,
      });
      break;
    }

    case "ADD_TRANSFER": {
      const bankExists = data.banks.some((bank) => bank.id === msg.bankId);
      const companyExists = data.companies.some(
        (company) => company.id === msg.companyId && company.bankId === msg.bankId
      );

      if (!bankExists || !companyExists) return;
      if (typeof msg.amount !== "number" || !Number.isFinite(msg.amount) || msg.amount <= 0) return;
      if (!msg.date) return;

      data.transfers.push({
        id: uuidv4(),
        companyId: msg.companyId,
        bankId: msg.bankId,
        amount: msg.amount,
        note: typeof msg.note === "string" ? msg.note.trim() : "",
        timestamp: new Date().toISOString(),
        date: msg.date,
        currency: msg.currency === "CNY" ? "CNY" : "USD",
      });
      break;
    }

    case "UPDATE_TRANSFER": {
      const transfer = data.transfers.find((item) => item.id === msg.id);
      if (!transfer) return;
      if (typeof msg.amount !== "number" || !Number.isFinite(msg.amount) || msg.amount <= 0) return;

      transfer.amount = msg.amount;
      transfer.note = typeof msg.note === "string" ? msg.note.trim() : "";
      transfer.currency = msg.currency === "CNY" ? "CNY" : "USD";
      break;
    }

    case "UPDATE_RETURN": {
      if (!msg.date || !msg.companyId) return;

      const companyExists = data.companies.some((company) => company.id === msg.companyId);
      if (!companyExists) return;

      const amount =
        typeof msg.amount === "number" && Number.isFinite(msg.amount) ? msg.amount : 0;

      if (!data.returns[msg.date]) {
        data.returns[msg.date] = {};
      }

      data.returns[msg.date][msg.companyId] = amount;
      break;
    }

    case "MOVE_COMPANY": {
      const company = data.companies.find((item) => item.id === msg.companyId);
      if (!company) return;

      const siblings = data.companies
        .filter((item) => item.bankId === company.bankId)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

      const index = siblings.findIndex((item) => item.id === company.id);
      if (index === -1) return;

      const targetIndex = msg.direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= siblings.length) return;

      const target = siblings[targetIndex];
      const currentOrder = company.sortOrder ?? index;
      company.sortOrder = target.sortOrder ?? targetIndex;
      target.sortOrder = currentOrder;

      reindexBankCompanies(company.bankId);
      break;
    }

    case "DELETE_TRANSFER": {
      const before = data.transfers.length;
      data.transfers = data.transfers.filter((transfer) => transfer.id !== msg.id);
      if (data.transfers.length === before) return;
      break;
    }

    case "DELETE_COMPANY": {
      const company = data.companies.find((item) => item.id === msg.id);
      if (!company) return;

      const bankId = company.bankId;
      removeCompanyRelatedData(company.id);
      data.companies = data.companies.filter((item) => item.id !== company.id);
      reindexBankCompanies(bankId);
      break;
    }

    case "DELETE_BANK": {
      const bank = data.banks.find((item) => item.id === msg.id);
      if (!bank) return;

      removeBankRelatedData(bank.id);
      data.banks = data.banks.filter((item) => item.id !== bank.id);
      break;
    }

    default:
      return;
  }

  saveData();
}

async function startServer() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    console.log("Client connected");

    const initMessage: ServerMessage = {
      type: "INIT",
      data,
    };

    ws.send(JSON.stringify(initMessage));

    ws.on("message", (message) => {
      try {
        const msg: ClientMessage = JSON.parse(message.toString());
        handleMessage(msg);
        broadcastAll(wss);
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
});