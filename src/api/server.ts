import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { billsRouter } from "./routes/billsRouter.js";
import { exportRouter } from "./routes/exportRouter.js";
import { statsRouter } from "./routes/statsRouter.js";
import { healthRouter } from "./routes/healthRouter.js";
import { tasksRouter } from "./routes/tasksRouter.js";
import { pdfRouter } from "./routes/pdfRouter.js";
import { npcRouter } from "./routes/npcRouter.js";
import { env } from "../config/env.js";
import { logger as appLogger } from "../core/logger.js";
import {
  API_CATALOG_OPERATIONS_COUNT,
  API_CATALOG_VERSION,
  API_CONSTRAINTS_DOC_VERSION,
  API_DOCS_PATHS,
  API_AUTH_HEADER,
  API_SERVICE_VERSION,
} from "./contract.js";

const app = new Hono();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use("*", cors());
app.use("*", logger());

/**
 * G2/G3: JSON response dùng `application/json; charset=utf-8`.
 * Thêm header phiên bản (đồng bộ catalog / ràng buộc gateway).
 */
app.use("*", async (c, next) => {
  await next();
  const res = c.res;
  const ct = res.headers.get("content-type") ?? "";
  const headers = new Headers(res.headers);
  headers.set("X-API-Version", API_SERVICE_VERSION);
  headers.set("X-Catalog-Version", API_CATALOG_VERSION);
  headers.set("X-Constraints-Doc-Version", API_CONSTRAINTS_DOC_VERSION);
  if (ct.startsWith("application/json") && !ct.toLowerCase().includes("charset")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  c.res = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
});

/**
 * API key auth: bật theo env.API_KEY_AUTH_ENABLED.
 * Header bắt buộc: x-api-key: <API_KEY>
 */
app.use("*", async (c, next) => {
  if (!env.apiKeyAuthEnabled) {
    await next();
    return;
  }
  // Cho phép preflight CORS đi qua
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }
  const provided = c.req.header(API_AUTH_HEADER) ?? "";
  if (provided !== env.apiKey) {
    return c.json({ error: `Unauthorized: invalid or missing ${API_AUTH_HEADER}` }, 401);
  }
  await next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.route("/api/tasks",   tasksRouter);
app.route("/api/bills",   billsRouter);
app.route("/api/export",  exportRouter);
app.route("/api/stats",   statsRouter);
app.route("/api/health",  healthRouter);
app.route("/api/pdf",     pdfRouter);
app.route("/api/npc",     npcRouter);

// ── Root: API map (G5 — discovery; version đồng bộ contract.ts + catalog) ─────
app.get("/", (c) =>
  c.json({
    service: "EVN AutoCheck API",
    /** @deprecated Dùng serviceVersion — giữ để tương thích checklist / client cũ */
    version: API_SERVICE_VERSION,
    serviceVersion: API_SERVICE_VERSION,
    catalogVersion: API_CATALOG_VERSION,
    constraintsDocVersion: API_CONSTRAINTS_DOC_VERSION,
    catalogOperationsCount: API_CATALOG_OPERATIONS_COUNT,
    catalogReference: API_DOCS_PATHS,
    endpoints: {
      tasks: {
        "POST /api/tasks":                                  "Tạo yêu cầu quét mới { ky, thang, nam } → worker tự xử lý",
        "GET  /api/tasks":                                  "Danh sách tasks (?status=PENDING,RUNNING,SUCCESS,FAILED&limit=&skip=)",
        "GET  /api/tasks/active":                           "Tasks đang PENDING + RUNNING",
        "GET  /api/tasks/counts":                           "Đếm tasks theo trạng thái",
        "GET  /api/tasks/:taskId":                          "Chi tiết 1 task + kết quả đầy đủ",
        "POST /api/tasks/:taskId/cancel":                   "Hủy task PENDING",
        "POST /api/tasks/:taskId/retry":                    "Tạo lại task từ FAILED",
      },
      bills: {
        "GET /api/bills/customers":                        "Danh sách mã KH (?region=EVN_CPC|EVN_NPC|all, mặc định EVN_CPC)",
        "GET /api/bills/customer/:maKH":                   "Lịch sử HĐ 1 KH (?region=&ky=&thang=&nam=)",
        "GET /api/bills/customer/:maKH/latest":            "HĐ mới nhất (?region=)",
        "GET /api/bills/customer/:maKH/due-soon?days=7":   "HĐ KH sắp đến hạn (?region=)",
        "GET /api/bills/customer/:maKH/history":           "Lịch sử tiêu thụ (?region=)",
        "GET /api/bills/period?ky=&thang=&nam=":           "Tất cả HĐ 1 kỳ (?region=)",
        "GET /api/bills/month?thang=&nam=":                "Tất cả HĐ 1 tháng (?region=)",
        "GET /api/bills/due-soon?days=7":                  "HĐ sắp đến hạn (?region=)",
        "GET /api/bills/:invoiceId":                       "Tra theo invoiceId (ID_HDON — CPC)",
        "GET /api/bills/npc/:idHdon":                     "Tra electricity_bills theo id_hdon NPC (URL-encode)",
      },
      export: {
        "GET /api/export/period?ky=&thang=&nam=":          "Excel HĐ 1 kỳ (?region=)",
        "GET /api/export/month?thang=&nam=":               "Excel HĐ 1 tháng (?region=)",
        "GET /api/export/customer/:maKH":                  "Excel lịch sử 1 KH (?region=&ky=&thang=&nam=)",
      },
      stats: {
        "GET /api/stats/month?nam=":                       "Tổng tiền/kWh theo tháng (?region=)",
        "GET /api/stats/period?ky=&thang=&nam=":           "Tổng hợp 1 kỳ (?region=)",
        "GET /api/stats/customer/:maKH/history":           "Lịch sử tiêu thụ KH (?region=)",
      },
      health: {
        "GET /api/health":                                 "Tổng quan hệ thống",
        "GET /api/health/db":                              "Trạng thái MongoDB + số documents",
        "GET /api/health/data-integrity":                  "Cross-check invoice_items vs electricity_bills",
      },
      npc: {
        "POST /api/npc/accounts":                           "Thêm tài khoản NPC { username, password, label? } (cần NPC_CREDENTIALS_SECRET)",
        "POST /api/npc/accounts/bulk":                     "Import hàng loạt { accounts: [{ username, password, label? }] }",
        "GET  /api/npc/accounts?enabledOnly=&limit=&skip=": "Danh sách tài khoản (không trả mật khẩu)",
        "PATCH /api/npc/accounts/:id":                     "{ enabled } hoặc { password } — đổi MK xóa disabledReason",
        "GET  /api/npc/bills?maKhachHang=&limit=":         "Danh sách electricity_bills đã parse (EVN_NPC)",
        "POST /api/npc/ensure-bill":                       "Agent: { username|maKhachHang, ky, thang, nam } — cache_hit | queued (202) + agentMessage",
        "POST /api/npc/tasks":                               "Tạo task quét NPC { npcAccountId, ky, thang, nam }",
        "POST /api/npc/tasks/enqueue-all-enabled":          "Xếp hàng quét cho mọi tài khoản NPC enabled (cùng ky/thang/nam)",
      },
      pdf: {
        "GET /api/pdf/npc/:idHdon":
          "Tải file PDF NPC đã lưu theo id_hdon (encodeURIComponent)",
        "GET /api/pdf/npc/customer/:maKH/list?limit=":
          "Liệt kê PDF NPC đã parse của một mã khách hàng",
        "GET /api/pdf/invoice/:invoiceId?fileType=TBAO|HDON":
          "Tải file PDF theo invoiceId",
        "GET /api/pdf/customer/:maKH/latest?fileType=TBAO|HDON&ky=&thang=&nam=":
          "Tải PDF mới nhất của 1 khách hàng (có thể lọc kỳ/tháng/năm)",
        "GET /api/pdf/customer/:maKH/list?fileType=TBAO|HDON&limit=20":
          "Liệt kê metadata PDF của khách hàng để agent chọn file",
        "GET /api/pdf/customer/:maKH/zip?fileType=TBAO|HDON&ky=&thang=&nam=&limit=":
          "ZIP nhiều PDF của 1 khách hàng (lọc kỳ/tháng/năm, giới hạn số file)",
        "GET /api/pdf/period/zip?ky=&thang=&nam=&fileType=TBAO|HDON&limit=":
          "ZIP tất cả PDF đã tải trong 1 kỳ/tháng/năm (mọi KH)",
      },
    },
  }),
);

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json({ error: "Endpoint không tồn tại. Xem danh sách API tại GET /" }, 404),
);

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  appLogger.error("[api] Lỗi không xử lý:", err.message);
  return c.json({ error: "Lỗi server", detail: err.message }, 500);
});

// ── Start ────────────────────────────────────────────────────────────────────
export function startApiServer(): void {
  if (env.apiKeyAuthEnabled && env.apiKey.trim().length === 0) {
    throw new Error(
      "API key auth đang bật nhưng API_KEY chưa được cấu hình. " +
        "Hãy set API_KEY hoặc tắt API_KEY_AUTH_ENABLED=false.",
    );
  }
  serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
    appLogger.info(`[api] HTTP listening port ${info.port} (LOG_LEVEL=${env.logLevel})`);
    appLogger.info(`[api] Discovery: GET http://localhost:${info.port}/`);
  });
}

// Cho phép chạy standalone: node --import tsx src/api/server.ts
if (
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))
) {
  import("../db/mongo.js").then(({ getMongoDb }) =>
    getMongoDb().then(() => startApiServer()),
  );
}
