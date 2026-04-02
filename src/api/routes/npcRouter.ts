import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { NpcAccountRepository } from "../../db/npcAccountRepository.js";
import { TaskRepository } from "../../db/taskRepository.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { logger } from "../../core/logger.js";
import type { NpcAccount } from "../../types/npcAccount.js";
import { validateKyThangNam } from "../../validation/kyThangNam.js";
import type { NpcPdfKind } from "../../services/npc/npcElectricityBillId.js";
import { env } from "../../config/env.js";
import { randomUUID } from "node:crypto";
import { decryptNpcPassword } from "../../services/crypto/npcCredentials.js";
import { AnticaptchaClient } from "../../services/captcha/AnticaptchaClient.js";
import { EVNNPCWorker } from "../../providers/npc/EVNNPCWorker.js";
import { runNpcOnlinePaymentLinkWithPlaywright } from "../../services/npc/npcOnlinePaymentLinkSession.js";
import { normalizeNpcMaKhachHangInput } from "../../services/npc/npcMaKhachHangNormalize.js";

const npcRepo = new NpcAccountRepository();

/**
 * ensure-bill: chỉ quyết định **đang kiểm tra cache** bản parse loại nào (thông báo vs HĐ GTGT).
 * Không có API/tham số nào bắt worker “chỉ tải GTGT” — một task NPC luôn dùng **cùng**
 * `ky` + `thang` + `nam` (và `npcAccountId`) như TraCuu: tải PDF thông báo, rồi (mặc định)
 * tải HĐ GTGT/thanh toán khi `NPC_DOWNLOAD_PAYMENT_PDF=true`.
 */
function parseNpcPdfKindEnsure(body: Record<string, unknown>): NpcPdfKind {
  const r = body.npcPdfKind ?? body.billKind;
  const s = String(r ?? "").trim().toLowerCase();
  if (s === "thanh_toan" || s === "tt" || s === "vat" || s === "hd_gtgt") return "thanh_toan";
  return "thong_bao";
}

/** Query GET /bills: lọc loại bản ghi NPC. */
function parseNpcBillsPdfKindQuery(q: string | undefined): NpcPdfKind | "all" {
  const s = (q ?? "").trim().toLowerCase();
  if (s === "" || s === "all") return "all";
  if (s === "thanh_toan" || s === "tt" || s === "vat") return "thanh_toan";
  return "thong_bao";
}
const taskRepo = new TaskRepository();
const billRepo = new ElectricityBillRepository();
export const npcRouter = new Hono();

function sanitizeAccount(a: NpcAccount): Record<string, unknown> {
  return {
    id: a._id!.toHexString(),
    username: a.username,
    enabled: a.enabled,
    disabledReason: a.disabledReason ?? null,
    lastAuthFailureAt: a.lastAuthFailureAt ?? null,
    label: a.label ?? null,
    lastLoginAt: a.lastLoginAt ?? null,
    hasStoredSession: Boolean(a.storageStateJson && String(a.storageStateJson).length > 10),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** POST /api/npc/accounts — thêm tài khoản (mật khẩu mã hóa bằng NPC_CREDENTIALS_SECRET) */
npcRouter.post("/accounts", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON: { username, password, label? }" }, 400);
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const label = typeof body.label === "string" ? body.label.trim() : undefined;

  if (!username || !password) {
    return c.json({ error: "username và password là bắt buộc" }, 400);
  }

  try {
    const id = await npcRepo.insertAccount({ username, passwordPlain: password, label });
    logger.info(`[api/npc] Đã thêm tài khoản NPC ${username} → ${id.toHexString()}`);
    return c.json({ id: id.toHexString(), username, label: label ?? null }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate|E11000/i.test(msg)) {
      return c.json({ error: `username đã tồn tại: ${username}` }, 409);
    }
    logger.error("[api/npc] insertAccount:", err);
    return c.json({ error: msg }, 400);
  }
});

/**
 * POST /api/npc/accounts/bulk — import nhiều tài khoản (JSON).
 * Body: { "accounts": [ { "username", "password", "label?" }, ... ] }
 * Trùng username → skipped (không ghi đè).
 */
npcRouter.post("/accounts/bulk", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON" }, 400);
  }
  const raw = body.accounts;
  if (!Array.isArray(raw) || raw.length === 0) {
    return c.json({ error: "Cần accounts: mảng không rỗng { username, password, label? }" }, 400);
  }
  if (raw.length > 2000) {
    return c.json({ error: "Tối đa 2000 bản ghi mỗi request" }, 400);
  }
  const rows: Array<{ username: string; passwordPlain: string; label?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const username = typeof o.username === "string" ? o.username.trim() : "";
    const passwordPlain = typeof o.password === "string" ? o.password : "";
    const label = typeof o.label === "string" ? o.label.trim() : undefined;
    if (!username || !passwordPlain) continue;
    rows.push({ username, passwordPlain, label });
  }
  if (rows.length === 0) {
    return c.json({ error: "Không có dòng hợp lệ (username + password)" }, 400);
  }
  try {
    const result = await npcRepo.insertManyAccounts(rows);
    logger.info(
      `[api/npc] bulk import: inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors.length}`,
    );
    return c.json({
      message: "Import hoàn tất.",
      requested: rows.length,
      inserted: result.inserted,
      skippedDuplicates: result.skipped,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

const NPC_REPLACE_BULK_CONFIRM = "DELETE_ALL_NPC_ACCOUNTS";

/**
 * POST /api/npc/accounts/replace-bulk — xóa **toàn bộ** `npc_accounts` rồi nạp lại từ JSON.
 * Chỉ hoạt động khi `NPC_ALLOW_ACCOUNT_REPLACE_BULK=true` (và API key nếu bật auth).
 * Body: { "confirmation": "DELETE_ALL_NPC_ACCOUNTS", "accounts": [ { "username", "password", "label?" }, ... ] }
 * File Excel: dùng CLI `npm run replace:npc-accounts:xlsx` (an toàn hơn cho file lớn).
 */
npcRouter.post("/accounts/replace-bulk", async (c) => {
  if (!env.npcAllowAccountReplaceBulk) {
    return c.json(
      {
        error:
          "Tính năng tắt. Đặt NPC_ALLOW_ACCOUNT_REPLACE_BULK=true trên server hoặc dùng CLI replace:npc-accounts:xlsx.",
        code: "FEATURE_DISABLED",
      },
      403,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON" }, 400);
  }
  if (String(body.confirmation ?? "") !== NPC_REPLACE_BULK_CONFIRM) {
    return c.json(
      {
        error: `Cần confirmation: "${NPC_REPLACE_BULK_CONFIRM}" (chính xác) để xác nhận xóa toàn bộ.`,
        code: "CONFIRMATION_REQUIRED",
      },
      400,
    );
  }
  const raw = body.accounts;
  if (!Array.isArray(raw) || raw.length === 0) {
    return c.json({ error: "Cần accounts: mảng không rỗng { username, password, label? }" }, 400);
  }
  if (raw.length > 2000) {
    return c.json({ error: "Tối đa 2000 bản ghi mỗi request" }, 400);
  }
  const rows: Array<{ username: string; passwordPlain: string; label?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const username = typeof o.username === "string" ? o.username.trim() : "";
    const passwordPlain = typeof o.password === "string" ? o.password : "";
    const label = typeof o.label === "string" ? o.label.trim() : undefined;
    if (!username || !passwordPlain) continue;
    rows.push({ username, passwordPlain, label });
  }
  if (rows.length === 0) {
    return c.json({ error: "Không có dòng hợp lệ (username + password) — không xóa DB." }, 400);
  }
  try {
    const deleted = await npcRepo.deleteAll();
    const result = await npcRepo.insertManyAccounts(rows);
    logger.warn(
      `[api/npc] replace-bulk: deleted=${deleted} inserted=${result.inserted} skipped=${result.skipped}`,
    );
    return c.json({
      message: "Đã xóa toàn bộ tài khoản NPC cũ và nạp lại.",
      deleted,
      requested: rows.length,
      inserted: result.inserted,
      skippedDuplicates: result.skipped,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

/**
 * GET /api/npc/accounts — danh sách (không trả mật khẩu).
 * - `?username=` hoặc `?maKhachHang=` (một): tra **một** tài khoản theo MA_KH — 200 `{ accounts: [1] }` hoặc 404.
 * - Không có query đó: phân trang `enabledOnly` / `limit` / `skip` như cũ.
 */
npcRouter.get("/accounts", async (c) => {
  const lookup =
    (c.req.query("username") ?? c.req.query("maKhachHang") ?? "").trim();
  if (lookup) {
    const acc = await npcRepo.findByUsername(lookup);
    if (!acc) {
      return c.json(
        { error: "Không tìm thấy npc_accounts", code: "NPC_ACCOUNT_NOT_FOUND" },
        404,
      );
    }
    return c.json({ accounts: [sanitizeAccount(acc)] });
  }

  const enabledOnly = c.req.query("enabledOnly") === "1" || c.req.query("enabledOnly") === "true";
  const skip = parseInt(c.req.query("skip") ?? "0", 10);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);

  const rows = enabledOnly ? await npcRepo.listEnabled(skip, limit) : await npcRepo.listAll(skip, limit);
  return c.json({ accounts: rows.map(sanitizeAccount) });
});

/** PATCH /api/npc/accounts/:id — { enabled?: boolean, password?: string } */
npcRouter.patch("/accounts/:id", async (c) => {
  const idHex = c.req.param("id");
  let oid: ObjectId;
  try {
    oid = new ObjectId(idHex);
  } catch {
    return c.json({ error: "id không hợp lệ" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body JSON: { enabled?: boolean, password?: string }" }, 400);
  }

  if (typeof body.password === "string" && body.password.length > 0) {
    const ok = await npcRepo.updatePasswordPlain(oid, body.password);
    if (!ok) return c.json({ error: "Không cập nhật mật khẩu (không tìm thấy?)" }, 404);
    logger.info(`[api/npc] Đã đổi mật khẩu + bật lại tài khoản ${idHex}`);
    if (typeof body.enabled === "boolean") {
      await npcRepo.setEnabled(oid, body.enabled);
    }
    return c.json({ id: idHex, passwordUpdated: true, enabled: true });
  }

  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Cần enabled (boolean) hoặc password (string)" }, 400);
  }

  const ok = await npcRepo.setEnabled(oid, body.enabled);
  if (!ok) return c.json({ error: "Không cập nhật được (không tìm thấy?)" }, 404);
  return c.json({ id: idHex, enabled: body.enabled });
});

/**
 * POST /api/npc/online-payment-link — Yêu cầu lấy link thanh toán trực tuyến (apicskhthanhtoan).
 *
 * **Mặc định (async):** trả **202** + `taskId` — worker xử lý (đăng nhập → trang thanh toán → POST Tra cứu).
 * Agent poll `GET /api/tasks/:taskId` tới `SUCCESS` | `FAILED`; kết quả nghiệp vụ nằm trong
 * `resultMetadata.lookupPayload.onlinePaymentLink` (kể cả khi không có URL — vẫn `SUCCESS` với `ok: false`).
 *
 * **Đồng bộ (chỉ khi bật env):** `NPC_ONLINE_PAYMENT_LINK_SYNC_API_ENABLED=true` và body `{ "sync": true }` —
 * trả ngay trong 1 request (dễ timeout gateway — không dùng cho agent production).
 *
 * Body: cần **một** trong hai:
 * - `npcAccountId` (ObjectId hex), hoặc
 * - `npcAccountUsername` — MA_KH trùng field `username` trong `npc_accounts` (khớp `findByUsername`).
 * `maKhachHang?` — mã tra cứu trên trang thanh toán (khác với tài khoản đăng nhập); mặc định = username của tài khoản NPC. `username` alias của `maKhachHang` (form thanh toán).
 * Chuỗi được chuẩn hóa: bỏ khoảng trắng thừa/NBSP, trích đúng một mã dạng `PA…`; từ chối số dạng chấm, hai mã PA khác nhau, hoặc không có PA hợp lệ (400 + `code`).
 * Tắt API: `NPC_ONLINE_PAYMENT_LINK_API_ENABLED=false`.
 */
npcRouter.post("/online-payment-link", async (c) => {
  if (!env.npcOnlinePaymentLinkApiEnabled) {
    return c.json({ error: "API tắt (NPC_ONLINE_PAYMENT_LINK_API_ENABLED=false)", code: "FEATURE_DISABLED" }, 403);
  }
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON", code: "VALIDATION_BODY_JSON" }, 400);
  }
  const idHexRaw = typeof body.npcAccountId === "string" ? body.npcAccountId.trim() : "";
  const npcAccountUsername =
    typeof body.npcAccountUsername === "string" ? body.npcAccountUsername.trim() : "";

  if (idHexRaw && npcAccountUsername) {
    return c.json(
      {
        error: "Chỉ cung cấp một trong hai: npcAccountId hoặc npcAccountUsername",
        code: "VALIDATION_ACCOUNT_ID_AMBIGUOUS",
      },
      400,
    );
  }
  if (!idHexRaw && !npcAccountUsername) {
    return c.json(
      {
        error: "Thiếu npcAccountId hoặc npcAccountUsername (MA_KH trong npc_accounts)",
        code: "VALIDATION_NPC_ACCOUNT_ID",
      },
      400,
    );
  }

  const maKhOptRaw =
    typeof body.maKhachHang === "string"
      ? body.maKhachHang
      : typeof body.username === "string"
        ? body.username
        : "";
  const maKhOptTrimmed = maKhOptRaw
    .replace(/\u00A0/g, " ")
    .replace(/[\u2000-\u200B\uFEFF]/g, "")
    .trim();

  const secret = env.npcCredentialsSecret.trim();
  if (!secret) {
    return c.json({ error: "Server thiếu NPC_CREDENTIALS_SECRET", code: "SERVER_CONFIG" }, 500);
  }

  let account: NpcAccount;
  let oid: ObjectId;
  let idHex: string;

  if (idHexRaw) {
    try {
      oid = new ObjectId(idHexRaw);
    } catch {
      return c.json({ error: "npcAccountId không hợp lệ", code: "VALIDATION_NPC_ACCOUNT_ID" }, 400);
    }
    idHex = idHexRaw;
    const found = await npcRepo.findById(oid);
    if (!found) {
      return c.json({ error: "Không tìm thấy npc_accounts", code: "NPC_ACCOUNT_NOT_FOUND" }, 404);
    }
    account = found;
  } else {
    const found = await npcRepo.findByUsername(npcAccountUsername);
    if (!found) {
      return c.json({ error: "Không tìm thấy npc_accounts", code: "NPC_ACCOUNT_NOT_FOUND" }, 404);
    }
    account = found;
    oid = found._id!;
    idHex = oid.toHexString();
  }
  if (!account.enabled) {
    return c.json({ error: "Tài khoản NPC đã tắt", code: "NPC_ACCOUNT_DISABLED" }, 400);
  }
  if (account.disabledReason === "wrong_password") {
    return c.json(
      { error: "Tài khoản bị đánh dấu sai mật khẩu — cập nhật mật khẩu trước", code: "NPC_WRONG_PASSWORD" },
      400,
    );
  }

  const resolvedMaSource = maKhOptTrimmed !== "" ? maKhOptRaw : account.username;
  const maNorm = normalizeNpcMaKhachHangInput(resolvedMaSource);
  if (!maNorm.ok) {
    return c.json({ error: maNorm.message, code: maNorm.code }, 400);
  }
  const maKhNormalized = maNorm.ma;

  const syncRaw = body.sync;
  const syncRequested =
    syncRaw === true || syncRaw === "true" || syncRaw === 1 || syncRaw === "1";
  const wantSync = env.npcOnlinePaymentLinkSyncApiEnabled && syncRequested;

  if (wantSync) {
    const password = decryptNpcPassword(account.passwordEncrypted, secret);
    const traceId = randomUUID();
    const worker = new EVNNPCWorker(new AnticaptchaClient());

    try {
      const result = await runNpcOnlinePaymentLinkWithPlaywright(
        worker,
        account,
        oid,
        password,
        maKhNormalized,
        traceId,
      );
      if (result.ok) {
        return c.json({
          ok: true,
          paymentUrl: result.paymentUrl,
          maKhachHang: result.maKhachHang,
          httpStatus: result.httpStatus,
          npcAccountId: idHex,
          traceId,
          mode: "sync" as const,
        });
      }
      return c.json({
        ok: false,
        code: result.code,
        reason: result.reason,
        maKhachHang: result.maKhachHang,
        httpStatus: result.httpStatus,
        bodyPreview: result.bodyPreview,
        npcAccountId: idHex,
        traceId,
        mode: "sync" as const,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[api/npc] online-payment-link (sync):", err);
      return c.json({ error: msg, code: "ONLINE_PAYMENT_LINK_FAILED", traceId }, 500);
    }
  }

  const existing = await taskRepo.findActiveNpcOnlinePaymentLink(idHex, maKhNormalized);
  if (existing) {
    return c.json(
      {
        outcome: "already_queued" as const,
        dataSource: "task_queue" as const,
        taskId: existing._id!.toHexString(),
        status: existing.status,
        npcAccountId: idHex,
        maKhachHang: maKhNormalized,
        agentMessage:
          "Đã có tác vụ lấy link thanh toán trực tuyến (cùng tài khoản + mã KH) đang PENDING/RUNNING. Poll GET /api/tasks/:taskId — resultMetadata.lookupPayload.onlinePaymentLink.",
      },
      202,
    );
  }

  const taskId = await taskRepo.insertPendingNpcOnlinePaymentLink({
    npcAccountId: idHex,
    maKhachHang: maKhNormalized,
  });
  logger.info(
    `[api/npc] online-payment-link → queued task ${taskId.toHexString()} — account=${idHex} ma=${maKhNormalized}`,
  );

  return c.json(
    {
      outcome: "queued" as const,
      dataSource: "task_queue" as const,
      taskId: taskId.toHexString(),
      status: "PENDING" as const,
      npcAccountId: idHex,
      maKhachHang: maKhNormalized,
      agentMessage:
        "Đã xếp hàng lấy link thanh toán (Playwright). Poll GET /api/tasks/:taskId tới SUCCESS. Kết quả: resultMetadata.lookupPayload.onlinePaymentLink — { ok, paymentUrl? } hoặc { ok:false, code, reason } (task vẫn SUCCESS nếu không lỗi kỹ thuật). FAILED = lỗi hệ thống/đăng nhập.",
    },
    202,
  );
});

/**
 * POST /api/npc/ensure-bill — Agent: có dữ liệu trong DB hay cần quét
 *
 * Body: { username | maKhachHang, ky|period, thang|month, nam|year, npcPdfKind? }
 * - `npcPdfKind` (tuỳ chọn): **chỉ** để chọn bản ghi nào khi kiểm tra `cache_hit` (`thong_bao` vs `thanh_toan`).
 *   Không dùng để “đặt hàng” chỉ tải GTGT — worker không có chế độ đó.
 * - Một lần quét (task) = cùng kỳ/tháng/năm với thông báo: luôn xử lý pipeline đầy đủ
 *   (thông báo + HĐ GTGT khi `NPC_DOWNLOAD_PAYMENT_PDF=true`, cùng tham số kỳ).
 * - username = mã khách hàng (MA_KH) trên NPC — phải đã có trong `npc_accounts`.
 * - Nếu đã có bản ghi parsed đúng kỳ **và đúng loại đang hỏi** → 200 `outcome: cache_hit`.
 * - Nếu chưa có → task PENDING (một task = pipeline đầy đủ như trên) → 202 + poll task.
 */
npcRouter.post("/ensure-bill", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON hợp lệ.", code: "VALIDATION_BODY_JSON" }, 400);
  }

  const usernameRaw =
    typeof body.username === "string"
      ? body.username.trim()
      : typeof body.maKhachHang === "string"
        ? body.maKhachHang.trim()
        : "";
  if (!usernameRaw) {
    return c.json(
      {
        error:
          "Thiếu username hoặc maKhachHang (bắt buộc; trùng mã khách hàng đăng nhập CSKH NPC).",
        code: "VALIDATION_USERNAME_MISSING",
      },
      400,
    );
  }

  const valid = validateKyThangNam(
    body.ky ?? body.period,
    body.thang ?? body.month,
    body.nam ?? body.year,
  );
  if (!valid.ok) {
    return c.json({ error: valid.error, code: valid.code }, 400);
  }
  const { ky, thang, nam, kyNum, thangNum, namNum } = valid.value;

  const acc = await npcRepo.findByUsername(usernameRaw);
  if (!acc) {
    return c.json(
      {
        error: `Chưa có tài khoản NPC trong hệ thống cho username/MA_KH "${usernameRaw}". Thêm qua POST /api/npc/accounts.`,
        code: "NPC_ACCOUNT_NOT_FOUND",
      },
      404,
    );
  }
  if (!acc.enabled) {
    return c.json(
      {
        error: "Tài khoản NPC đã tắt — không thể tạo tác vụ quét.",
        code: "NPC_ACCOUNT_DISABLED",
      },
      400,
    );
  }

  const maKh = acc.username.trim().toUpperCase();
  const npcPdfKind = parseNpcPdfKindEnsure(body);
  const npcScanPipeline = {
    samePeriodParamsAsNotification: true,
    includesPaymentVatPdf: env.npcDownloadPaymentPdf,
  };
  const bill = await billRepo.findNpcParsedByCustomerPeriod(maKh, kyNum, thangNum, namNum, npcPdfKind);
  if (bill) {
    const isVat = npcPdfKind === "thanh_toan";
    return c.json({
      outcome: "cache_hit" as const,
      dataSource: "database" as const,
      npcPdfKind,
      npcScanPipeline,
      agentMessage: isVat
        ? "Hóa đơn GTGT (thanh toán) đã có — dùng GET /api/pdf/npc/:idHdon?kind=tt để tải PDF."
        : "Dữ liệu thông báo tiền điện đã có (parse từ PDF). Có thể trả lời người dùng ngay.",
      maKhachHang: maKh,
      npcAccountId: acc._id!.toHexString(),
      period: { ky: kyNum, thang: thangNum, nam: namNum },
      bill,
      parseVersion: bill.parseVersion,
    });
  }

  const npcAccountId = acc._id!.toHexString();
  const existing = await taskRepo.findActiveNpcForPeriod(npcAccountId, ky, thang, nam);
  if (existing) {
    return c.json(
      {
        outcome: "already_queued" as const,
        dataSource: "task_queue" as const,
        npcPdfKind,
        npcScanPipeline,
        agentMessage:
          "Dữ liệu chưa có trong DB cho loại đang kiểm tra (npcPdfKind); đã có tác vụ quét cùng kỳ/tháng/năm. Task đó tải PDF thông báo và (nếu bật env) HĐ GTGT — không cần tham số tải GTGT riêng. Poll GET /api/tasks/:taskId rồi gọi lại ensure-bill với npcPdfKind=thong_bao hoặc thanh_toan tùy cần kiểm tra cache.",
        taskId: existing._id!.toHexString(),
        status: existing.status,
        maKhachHang: maKh,
        npcAccountId,
        period: { ky: kyNum, thang: thangNum, nam: namNum },
      },
      202,
    );
  }

  const payload = { npcAccountId, period: ky, month: thang, year: nam };
  const taskId = await taskRepo.insertPendingNpc(payload);
  logger.info(`[api/npc] ensure-bill → queued task ${taskId.toHexString()} — ${maKh} Kỳ ${ky} T${thang}/${nam}`);

  return c.json(
    {
      outcome: "queued" as const,
      dataSource: "task_queue" as const,
      npcPdfKind,
      npcScanPipeline,
      agentMessage:
        "Đã xếp hàng quét một lần cho đúng kỳ/tháng/năm: đăng nhập, TraCuu, tải PDF thông báo và (nếu bật env) HĐ GTGT cùng tham số — không có chế độ chỉ tải GTGT. npcPdfKind ở request chỉ dùng để biết đang kiểm tra cache loại nào. Chờ GET /api/tasks/:taskId SUCCESS rồi GET /api/npc/bills?npcPdfKind=… hoặc ensure-bill lại.",
      taskId: taskId.toHexString(),
      status: "PENDING" as const,
      maKhachHang: maKh,
      npcAccountId,
      period: { ky: kyNum, thang: thangNum, nam: namNum },
      payload,
    },
    202,
  );
});

/** GET /api/npc/bills?maKhachHang=&limit=&npcPdfKind=all|thong_bao|thanh_toan — electricity_bills (EVN_NPC) */
npcRouter.get("/bills", async (c) => {
  const maKh = (c.req.query("maKhachHang") ?? c.req.query("maKH") ?? "").trim().toUpperCase();
  if (!maKh) {
    return c.json({ error: "Query maKhachHang (mã khách hàng) là bắt buộc" }, 400);
  }
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const kindFilter = parseNpcBillsPdfKindQuery(c.req.query("npcPdfKind"));
  const rows = await billRepo.find({
    maKhachHang: maKh,
    provider: "EVN_NPC",
    status: "parsed",
    ...(kindFilter !== "all" ? { npcPdfKind: kindFilter } : {}),
    limit,
    sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
  });
  return c.json({
    provider: "EVN_NPC",
    maKhachHang: maKh,
    npcPdfKindFilter: kindFilter,
    total: rows.length,
    data: rows,
  });
});

/** POST /api/npc/tasks — tạo task PENDING cho worker NPC */
npcRouter.post("/tasks", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      { error: "Body: { npcAccountId, ky, thang, nam } (hoặc period/month/year)" },
      400,
    );
  }

  const npcAccountId =
    typeof body.npcAccountId === "string"
      ? body.npcAccountId.trim()
      : typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";

  if (!npcAccountId) {
    return c.json({ error: "npcAccountId (ObjectId hex) là bắt buộc" }, 400);
  }

  let accountOid: ObjectId;
  try {
    accountOid = new ObjectId(npcAccountId);
  } catch {
    return c.json({ error: "npcAccountId không phải ObjectId hợp lệ" }, 400);
  }

  const acc = await npcRepo.findById(accountOid);
  if (!acc) return c.json({ error: "Không tìm thấy tài khoản NPC" }, 404);
  if (!acc.enabled) return c.json({ error: "Tài khoản NPC đã tắt" }, 400);

  const valid = validateKyThangNam(body.ky ?? body.period, body.thang ?? body.month, body.nam ?? body.year);
  if (!valid.ok) return c.json({ error: valid.error, code: valid.code }, 400);

  const { ky, thang, nam } = valid.value;

  const existing = await taskRepo.findActiveNpcForPeriod(npcAccountId, ky, thang, nam);
  if (existing) {
    return c.json(
      {
        message: `Đã có task ${existing.status} cho tài khoản này — Kỳ ${ky} T${thang}/${nam}.`,
        taskId: existing._id!.toHexString(),
        status: existing.status,
        isDuplicate: true,
      },
      200,
    );
  }

  const payload = { npcAccountId, period: ky, month: thang, year: nam };
  const taskId = await taskRepo.insertPendingNpc(payload);
  logger.info(`[api/npc] POST task ${taskId.toHexString()} — NPC ${acc.username} Kỳ ${ky} T${thang}/${nam}`);

  return c.json(
    {
      message: "Đã tạo task NPC PENDING.",
      taskId: taskId.toHexString(),
      status: "PENDING",
      payload,
      isDuplicate: false,
    },
    201,
  );
});

/**
 * POST /api/npc/tasks/enqueue-all-enabled — xếp hàng quét cho **mọi** tài khoản NPC đang bật (cùng kỳ/tháng/năm).
 * Mỗi task = cùng pipeline với quét đơn lẻ: thông báo + HĐ GTGT (khi `NPC_DOWNLOAD_PAYMENT_PDF`), không tham số tách GTGT.
 * Không tạo task trùng nếu đã có PENDING/RUNNING cho account + kỳ đó.
 * Agent có thể gọi một lần thay vì lặp `POST /api/npc/tasks` từng account.
 */
npcRouter.post("/tasks/enqueue-all-enabled", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body JSON: { ky, thang, nam } (hoặc period/month/year)", code: "VALIDATION_BODY_JSON" }, 400);
  }

  const valid = validateKyThangNam(body.ky ?? body.period, body.thang ?? body.month, body.nam ?? body.year);
  if (!valid.ok) return c.json({ error: valid.error, code: valid.code }, 400);

  const { ky, thang, nam, kyNum, thangNum, namNum } = valid.value;

  const MAX_TOTAL = 5000;
  const accounts: NpcAccount[] = [];
  for (let skip = 0; skip < MAX_TOTAL; skip += 500) {
    const batch = await npcRepo.listEnabled(skip, 500);
    if (batch.length === 0) break;
    accounts.push(...batch);
    if (batch.length < 500) break;
  }
  if (accounts.length >= MAX_TOTAL) {
    return c.json(
      {
        error: `Vượt giới hạn ${MAX_TOTAL} tài khoản — chia nhỏ hoặc liên hệ vận hành.`,
        code: "BATCH_ACCOUNT_LIMIT",
      },
      400,
    );
  }

  let tasksCreated = 0;
  let skippedAlreadyActive = 0;
  const taskIds: string[] = [];

  for (const acc of accounts) {
    const npcAccountId = acc._id!.toHexString();
    const existing = await taskRepo.findActiveNpcForPeriod(npcAccountId, ky, thang, nam);
    if (existing) {
      skippedAlreadyActive++;
      continue;
    }
    const payload = { npcAccountId, period: ky, month: thang, year: nam };
    const taskId = await taskRepo.insertPendingNpc(payload);
    tasksCreated++;
    taskIds.push(taskId.toHexString());
  }

  logger.info(
    `[api/npc] enqueue-all-enabled Kỳ ${ky} T${thang}/${nam}: created=${tasksCreated} skipActive=${skippedAlreadyActive} totalAccounts=${accounts.length}`,
  );

  return c.json(
    {
      agentMessage:
        tasksCreated > 0
          ? `Đã tạo ${tasksCreated} task PENDING (kỳ ${kyNum} tháng ${thangNum}/${namNum}). Mỗi task tải PDF thông báo${env.npcDownloadPaymentPdf ? " và HĐ GTGT/thanh toán cùng kỳ" : ""} (không cần tham số riêng cho GTGT). Worker xử lý theo WORKER_CONCURRENCY — theo dõi GET /api/tasks.`
          : `Không tạo task mới — tất cả ${accounts.length} tài khoản đã có task đang chờ/chạy cho kỳ này, hoặc không có tài khoản enabled.`,
      period: { ky: kyNum, thang: thangNum, nam: namNum },
      totalAccountsConsidered: accounts.length,
      tasksCreated,
      skippedAlreadyActive,
      taskIdsSample: taskIds.slice(0, 20),
      taskIdsTotal: taskIds.length,
    },
    tasksCreated > 0 ? 201 : 200,
  );
});
