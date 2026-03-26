import { Hono } from "hono";
import { getMongoDb } from "../../db/mongo.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { env } from "../../config/env.js";
import { stat } from "node:fs/promises";
import path from "node:path";

const billRepo = new ElectricityBillRepository();
export const healthRouter = new Hono();

// ── GET /health — tổng quan ───────────────────────────────────────────────────
healthRouter.get("/", async (c) => {
  const db = await getMongoDb().catch(() => null);
  const dbOk = db !== null;

  let pdfDirOk = false;
  try {
    const s = await stat(path.resolve(env.pdfOutputDir));
    pdfDirOk = s.isDirectory();
  } catch { /* thư mục chưa tồn tại */ }

  const [parsed, error] = await Promise.all([
    db?.collection("electricity_bills").countDocuments({ status: "parsed" }).catch(() => 0) ?? 0,
    db?.collection("electricity_bills").countDocuments({ status: "error" }).catch(() => 0) ?? 0,
  ]);

  return c.json({
    status: dbOk && pdfDirOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    db: { connected: dbOk, name: env.mongodbDb },
    pdfStorage: { accessible: pdfDirOk, path: env.pdfOutputDir },
    bills: { parsed, error },
  });
});

// ── GET /health/db ─────────────────────────────────────────────────────────────
healthRouter.get("/db", async (c) => {
  const db = await getMongoDb().catch(() => null);
  if (!db) return c.json({ status: "error", message: "MongoDB không kết nối được" }, 503);

  const [billCount, invoiceCount, taskCount] = await Promise.all([
    db.collection("electricity_bills").countDocuments(),
    db.collection("invoice_items").countDocuments(),
    db.collection("scrape_tasks").countDocuments(),
  ]);

  return c.json({
    status: "ok",
    db: env.mongodbDb,
    collections: { electricity_bills: billCount, invoice_items: invoiceCount, scrape_tasks: taskCount },
  });
});

// ── GET /health/data-integrity — cross-check invoice_items vs electricity_bills
healthRouter.get("/data-integrity", async (c) => {
  const db = await getMongoDb();

  const [invoiceIds, billIds] = await Promise.all([
    db.collection("invoice_items").distinct("ID_HDON") as Promise<number[]>,
    db.collection("electricity_bills").distinct("invoiceId") as Promise<number[]>,
  ]);

  const invoiceSet = new Set(invoiceIds);
  const billSet = new Set(billIds);

  const hasPdfNotParsed = invoiceIds.filter((id) => !billSet.has(id));
  const parsedOrphan    = billIds.filter((id) => !invoiceSet.has(id));

  const errorBills = await db
    .collection("electricity_bills")
    .find({ status: "error" }, { projection: { invoiceId: 1, parseError: 1, pdfPath: 1 } })
    .toArray();

  return c.json({
    invoiceItemsTotal: invoiceIds.length,
    electricityBillsTotal: billIds.length,
    notYetParsed: { count: hasPdfNotParsed.length, invoiceIds: hasPdfNotParsed.slice(0, 50) },
    orphanBills:  { count: parsedOrphan.length, invoiceIds: parsedOrphan.slice(0, 50) },
    parseErrors:  { count: errorBills.length, items: errorBills.slice(0, 20) },
  });
});
