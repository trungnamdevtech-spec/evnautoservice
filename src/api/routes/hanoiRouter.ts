import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { HanoiAccountRepository } from "../../db/hanoiAccountRepository.js";
import { TaskRepository } from "../../db/taskRepository.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { logger } from "../../core/logger.js";
import type { HanoiAccount } from "../../types/hanoiAccount.js";
import { validateKyThangNam } from "../../validation/kyThangNam.js";
import { env } from "../../config/env.js";
import { randomUUID } from "node:crypto";
import { decryptHanoiPassword } from "../../services/crypto/hanoiCredentials.js";
import { AnticaptchaClient } from "../../services/captcha/AnticaptchaClient.js";
import { EVNHanoiWorker } from "../../providers/hanoi/EVNHanoiWorker.js";
import { HanoiContractRepository } from "../../db/hanoiContractRepository.js";
import {
  runHanoiOnlinePaymentLinkWithApi,
  runHanoiOnlinePaymentLinkWithPlaywright,
} from "../../services/hanoi/hanoiOnlinePaymentLinkSession.js";

const hanoiRepo = new HanoiAccountRepository();
const hanoiContractRepo = new HanoiContractRepository();
const taskRepo = new TaskRepository();
const billRepo = new ElectricityBillRepository();

export const hanoiRouter = new Hono();

const HANOI_REPLACE_BULK_CONFIRM = "DELETE_ALL_HANOI_ACCOUNTS";

function sanitizeAccount(a: HanoiAccount): Record<string, unknown> {
  const ui = a.userInfo;
  return {
    id: a._id!.toHexString(),
    username: a.username,
    enabled: a.enabled,
    disabledReason: a.disabledReason ?? null,
    lastAuthFailureAt: a.lastAuthFailureAt ?? null,
    label: a.label ?? null,
    lastLoginAt: a.lastLoginAt ?? null,
    hasStoredSession: Boolean(a.storageStateJson && String(a.storageStateJson).length > 10),
    hasStoredApiToken: Boolean(
      a.apiAccessTokenEncrypted &&
        a.apiTokenExpiresAt &&
        a.apiTokenExpiresAt.getTime() > Date.now(),
    ),
    userInfoFetchedAt: a.userInfoFetchedAt ?? null,
    hopDongFetchedAt: a.hopDongFetchedAt ?? null,
    userInfoSummary:
      ui !== undefined && ui !== null
        ? {
            maDvql: ui.maDvql ?? null,
            maKhachHang: ui.maKhachHang ?? null,
            name: ui.name ?? null,
            preferredUsername: ui.preferredUsername ?? null,
            profile: ui.profile ?? null,
            keyUser: ui.keyUser ?? null,
            sub: ui.sub ?? null,
          }
        : null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

// ── Quản lý tài khoản ────────────────────────────────────────────────────────

/** POST /api/hanoi/accounts — thêm 1 tài khoản */
hanoiRouter.post("/accounts", async (c) => {
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
    const id = await hanoiRepo.insertAccount({ username, passwordPlain: password, label });
    logger.info(`[api/hanoi] Đã thêm tài khoản Hanoi ${username} → ${id.toHexString()}`);
    return c.json({ id: id.toHexString(), username, label: label ?? null }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate|E11000/i.test(msg)) {
      return c.json({ error: `username đã tồn tại: ${username}` }, 409);
    }
    logger.error("[api/hanoi] insertAccount:", err);
    return c.json({ error: msg }, 400);
  }
});

/** POST /api/hanoi/accounts/bulk — import hàng loạt JSON */
hanoiRouter.post("/accounts/bulk", async (c) => {
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
    const result = await hanoiRepo.insertManyAccounts(rows);
    logger.info(
      `[api/hanoi] bulk import: inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors.length}`,
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

/** POST /api/hanoi/accounts/replace-bulk — xóa toàn bộ + nạp lại */
hanoiRouter.post("/accounts/replace-bulk", async (c) => {
  if (!env.hanoiAllowAccountReplaceBulk) {
    return c.json(
      {
        error:
          "Tính năng tắt. Đặt HANOI_ALLOW_ACCOUNT_REPLACE_BULK=true hoặc dùng CLI replace:hanoi-accounts:xlsx.",
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
  if (String(body.confirmation ?? "") !== HANOI_REPLACE_BULK_CONFIRM) {
    return c.json(
      {
        error: `Cần confirmation: "${HANOI_REPLACE_BULK_CONFIRM}" (chính xác) để xác nhận xóa toàn bộ.`,
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
    const deleted = await hanoiRepo.deleteAll();
    const result = await hanoiRepo.insertManyAccounts(rows);
    logger.warn(
      `[api/hanoi] replace-bulk: deleted=${deleted} inserted=${result.inserted} skipped=${result.skipped}`,
    );
    return c.json({
      message: "Đã xóa toàn bộ tài khoản Hanoi cũ và nạp lại.",
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
 * GET /api/hanoi/accounts — danh sách hoặc tìm theo ?username=
 */
hanoiRouter.get("/accounts", async (c) => {
  const lookup = (c.req.query("username") ?? c.req.query("maKhachHang") ?? "").trim();
  if (lookup) {
    const acc = await hanoiRepo.findByUsername(lookup);
    if (!acc) {
      return c.json(
        { error: "Không tìm thấy hanoi_accounts", code: "HANOI_ACCOUNT_NOT_FOUND" },
        404,
      );
    }
    return c.json({ accounts: [sanitizeAccount(acc)] });
  }

  const enabledOnly = c.req.query("enabledOnly") === "1" || c.req.query("enabledOnly") === "true";
  const skip = parseInt(c.req.query("skip") ?? "0", 10);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);

  const rows = enabledOnly ? await hanoiRepo.listEnabled(skip, limit) : await hanoiRepo.listAll(skip, limit);
  return c.json({ accounts: rows.map(sanitizeAccount) });
});

/**
 * GET /api/hanoi/contracts — danh sách hợp đồng đã đồng bộ
 *
 * Query: `maKhachHang` (tra cứu agent — có thể nhiều tài khoản) hoặc `hanoiAccountId` (một tài khoản).
 */
hanoiRouter.get("/contracts", async (c) => {
  const ma = (c.req.query("maKhachHang") ?? c.req.query("maKH") ?? "").trim();
  const idHex = (c.req.query("hanoiAccountId") ?? "").trim();

  if (idHex && ma) {
    return c.json(
      { error: "Chỉ truyền một trong hai: maKhachHang hoặc hanoiAccountId", code: "VALIDATION_AMBIGUOUS" },
      400,
    );
  }

  if (idHex) {
    let oid: ObjectId;
    try {
      oid = new ObjectId(idHex);
    } catch {
      return c.json({ error: "hanoiAccountId không hợp lệ", code: "VALIDATION_ID" }, 400);
    }
    const rows = await hanoiContractRepo.findByAccountId(oid);
    return c.json({
      filter: { hanoiAccountId: idHex },
      total: rows.length,
      contracts: rows.map((r) => ({
        id: r._id!.toHexString(),
        hanoiAccountId: r.hanoiAccountId.toHexString(),
        hanoiUsername: r.hanoiUsername,
        maKhachHang: r.maKhachHang,
        normalized: r.normalized,
        raw: r.raw,
        fetchedAt: r.fetchedAt,
        updatedAt: r.updatedAt,
      })),
    });
  }

  if (ma) {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    const rows = await hanoiContractRepo.findByMaKhachHang(ma, limit);
    return c.json({
      filter: { maKhachHang: ma.toUpperCase() },
      total: rows.length,
      contracts: rows.map((r) => ({
        id: r._id!.toHexString(),
        hanoiAccountId: r.hanoiAccountId.toHexString(),
        hanoiUsername: r.hanoiUsername,
        maKhachHang: r.maKhachHang,
        normalized: r.normalized,
        raw: r.raw,
        fetchedAt: r.fetchedAt,
        updatedAt: r.updatedAt,
      })),
    });
  }

  return c.json(
    {
      error: "Thiếu query: maKhachHang hoặc hanoiAccountId",
      code: "VALIDATION_QUERY",
    },
    400,
  );
});

/** PATCH /api/hanoi/accounts/:id — { enabled?: boolean, password?: string } */
hanoiRouter.patch("/accounts/:id", async (c) => {
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
    const ok = await hanoiRepo.updatePasswordPlain(oid, body.password);
    if (!ok) return c.json({ error: "Không cập nhật mật khẩu (không tìm thấy?)" }, 404);
    logger.info(`[api/hanoi] Đã đổi mật khẩu + bật lại tài khoản ${idHex}`);
    if (typeof body.enabled === "boolean") {
      await hanoiRepo.setEnabled(oid, body.enabled);
    }
    return c.json({ id: idHex, passwordUpdated: true, enabled: true });
  }

  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Cần enabled (boolean) hoặc password (string)" }, 400);
  }

  const ok = await hanoiRepo.setEnabled(oid, body.enabled);
  if (!ok) return c.json({ error: "Không cập nhật được (không tìm thấy?)" }, 404);
  return c.json({ id: idHex, enabled: body.enabled });
});

// ── Tra cứu link thanh toán ──────────────────────────────────────────────────

/**
 * POST /api/hanoi/online-payment-link
 *
 * Mặc định async: trả 202 + taskId. Poll GET /api/tasks/:taskId.
 * Sync (chỉ khi bật env): body { "sync": true }.
 *
 * Body: { hanoiAccountId | hanoiAccountUsername, maKhachHang? }
 */
hanoiRouter.post("/online-payment-link", async (c) => {
  if (!env.hanoiOnlinePaymentLinkApiEnabled) {
    return c.json(
      { error: "API tắt (HANOI_ONLINE_PAYMENT_LINK_API_ENABLED=false)", code: "FEATURE_DISABLED" },
      403,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON", code: "VALIDATION_BODY_JSON" }, 400);
  }

  const idHexRaw = typeof body.hanoiAccountId === "string" ? body.hanoiAccountId.trim() : "";
  const hanoiAccountUsername =
    typeof body.hanoiAccountUsername === "string" ? body.hanoiAccountUsername.trim() : "";

  if (idHexRaw && hanoiAccountUsername) {
    return c.json(
      {
        error: "Chỉ cung cấp một trong hai: hanoiAccountId hoặc hanoiAccountUsername",
        code: "VALIDATION_ACCOUNT_ID_AMBIGUOUS",
      },
      400,
    );
  }
  if (!idHexRaw && !hanoiAccountUsername) {
    return c.json(
      {
        error: "Thiếu hanoiAccountId hoặc hanoiAccountUsername",
        code: "VALIDATION_HANOI_ACCOUNT_ID",
      },
      400,
    );
  }

  const maKhOpt =
    typeof body.maKhachHang === "string"
      ? body.maKhachHang.trim()
      : typeof body.username === "string"
        ? body.username.trim()
        : "";

  const secret = env.hanoiCredentialsSecret.trim();
  if (!secret) {
    return c.json({ error: "Server thiếu HANOI_CREDENTIALS_SECRET", code: "SERVER_CONFIG" }, 500);
  }

  let account: HanoiAccount;
  let oid: ObjectId;
  let idHex: string;

  if (idHexRaw) {
    try {
      oid = new ObjectId(idHexRaw);
    } catch {
      return c.json({ error: "hanoiAccountId không hợp lệ", code: "VALIDATION_HANOI_ACCOUNT_ID" }, 400);
    }
    idHex = idHexRaw;
    const found = await hanoiRepo.findById(oid);
    if (!found) {
      return c.json({ error: "Không tìm thấy hanoi_accounts", code: "HANOI_ACCOUNT_NOT_FOUND" }, 404);
    }
    account = found;
  } else {
    const found = await hanoiRepo.findByUsername(hanoiAccountUsername);
    if (!found) {
      return c.json({ error: "Không tìm thấy hanoi_accounts", code: "HANOI_ACCOUNT_NOT_FOUND" }, 404);
    }
    account = found;
    oid = found._id!;
    idHex = oid.toHexString();
  }

  if (!account.enabled) {
    return c.json({ error: "Tài khoản Hanoi đã tắt", code: "HANOI_ACCOUNT_DISABLED" }, 400);
  }
  if (account.disabledReason === "wrong_password") {
    return c.json(
      { error: "Tài khoản bị đánh dấu sai mật khẩu — cập nhật mật khẩu trước", code: "HANOI_WRONG_PASSWORD" },
      400,
    );
  }

  const maKhNormalized = (maKhOpt || account.username).trim().toUpperCase();

  // Sync mode (optional, disabled by default)
  const syncRaw = body.sync;
  const syncRequested =
    syncRaw === true || syncRaw === "true" || syncRaw === 1 || syncRaw === "1";
  const wantSync = env.hanoiOnlinePaymentLinkSyncApiEnabled && syncRequested;

  if (wantSync) {
    const password = decryptHanoiPassword(account.passwordEncrypted, secret);
    const traceId = randomUUID();
    try {
      const result = env.hanoiUseApiLogin
        ? await runHanoiOnlinePaymentLinkWithApi(account, oid, password, maKhNormalized, traceId)
        : await (async () => {
            const worker = new EVNHanoiWorker(new AnticaptchaClient());
            return runHanoiOnlinePaymentLinkWithPlaywright(
              worker,
              account,
              oid,
              password,
              maKhNormalized,
              traceId,
            );
          })();
      if (result.ok) {
        return c.json({
          ok: true,
          paymentUrl: result.paymentUrl,
          maKhachHang: result.maKhachHang,
          httpStatus: result.httpStatus,
          hanoiAccountId: idHex,
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
        hanoiAccountId: idHex,
        traceId,
        mode: "sync" as const,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[api/hanoi] online-payment-link (sync):", err);
      return c.json({ error: msg, code: "ONLINE_PAYMENT_LINK_FAILED", traceId }, 500);
    }
  }

  const existing = await taskRepo.findActiveHanoiOnlinePaymentLink(idHex, maKhNormalized);
  if (existing) {
    return c.json(
      {
        outcome: "already_queued" as const,
        dataSource: "task_queue" as const,
        taskId: existing._id!.toHexString(),
        status: existing.status,
        hanoiAccountId: idHex,
        maKhachHang: maKhNormalized,
        agentMessage:
          "Đã có tác vụ lấy link thanh toán (cùng tài khoản + mã KH) đang PENDING/RUNNING. Poll GET /api/tasks/:taskId — resultMetadata.lookupPayload.onlinePaymentLink.",
      },
      202,
    );
  }

  const taskId = await taskRepo.insertPendingHanoiOnlinePaymentLink({
    hanoiAccountId: idHex,
    maKhachHang: maKhNormalized,
  });
  logger.info(
    `[api/hanoi] online-payment-link → queued task ${taskId.toHexString()} — account=${idHex} ma=${maKhNormalized}`,
  );

  return c.json(
    {
      outcome: "queued" as const,
      dataSource: "task_queue" as const,
      taskId: taskId.toHexString(),
      status: "PENDING" as const,
      hanoiAccountId: idHex,
      maKhachHang: maKhNormalized,
      agentMessage:
        "Đã xếp hàng lấy link thanh toán (Playwright). Poll GET /api/tasks/:taskId tới SUCCESS. Kết quả: resultMetadata.lookupPayload.onlinePaymentLink.",
    },
    202,
  );
});

// ── Hóa đơn ─────────────────────────────────────────────────────────────────

/**
 * POST /api/hanoi/ensure-bill — Agent: cache_hit hoặc 202+taskId
 *
 * Body: { username | maKhachHang, ky|period, thang|month, nam|year }
 */
hanoiRouter.post("/ensure-bill", async (c) => {
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
        error: "Thiếu username hoặc maKhachHang (bắt buộc; tên đăng nhập EVN Hà Nội).",
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

  const acc = await hanoiRepo.findByUsername(usernameRaw);
  if (!acc) {
    return c.json(
      {
        error: `Chưa có tài khoản Hanoi cho username "${usernameRaw}". Thêm qua POST /api/hanoi/accounts.`,
        code: "HANOI_ACCOUNT_NOT_FOUND",
      },
      404,
    );
  }
  if (!acc.enabled) {
    return c.json(
      { error: "Tài khoản Hanoi đã tắt — không thể tạo tác vụ quét.", code: "HANOI_ACCOUNT_DISABLED" },
      400,
    );
  }

  const maKh = acc.username.trim().toUpperCase();
  const hanoiAccountId = acc._id!.toHexString();

  // Kiểm tra cache trong electricity_bills (provider=EVN_HANOI)
  const bill = await billRepo.find({
    maKhachHang: maKh,
    provider: "EVN_HANOI",
    status: "parsed",
    limit: 1,
    sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
  }).then((rows) => {
    // Lọc đúng kỳ/tháng/năm
    return rows.find(
      (r) =>
        r.kyBill?.ky === kyNum &&
        r.kyBill?.thang === thangNum &&
        r.kyBill?.nam === namNum,
    ) ?? null;
  });

  if (bill) {
    return c.json({
      outcome: "cache_hit" as const,
      dataSource: "database" as const,
      agentMessage: "Dữ liệu hóa đơn EVN Hà Nội đã có — dùng GET /api/hanoi/bills để lấy.",
      maKhachHang: maKh,
      hanoiAccountId,
      period: { ky: kyNum, thang: thangNum, nam: namNum },
      bill,
    });
  }

  const existing = await taskRepo.findActiveHanoiForPeriod(hanoiAccountId, ky, thang, nam);
  if (existing) {
    return c.json(
      {
        outcome: "already_queued" as const,
        dataSource: "task_queue" as const,
        agentMessage:
          "Dữ liệu chưa có trong DB; đã có tác vụ đang chờ/chạy. Poll GET /api/tasks/:taskId rồi gọi lại ensure-bill.",
        taskId: existing._id!.toHexString(),
        status: existing.status,
        maKhachHang: maKh,
        hanoiAccountId,
        period: { ky: kyNum, thang: thangNum, nam: namNum },
      },
      202,
    );
  }

  const payload = { hanoiAccountId, period: ky, month: thang, year: nam };
  const taskId = await taskRepo.insertPendingHanoi(payload);
  logger.info(
    `[api/hanoi] ensure-bill → queued task ${taskId.toHexString()} — ${maKh} Kỳ ${ky} T${thang}/${nam}`,
  );

  return c.json(
    {
      outcome: "queued" as const,
      dataSource: "task_queue" as const,
      agentMessage:
        "Đã xếp hàng quét EVN Hà Nội. Worker sẽ đăng nhập và tra cứu hóa đơn. Poll GET /api/tasks/:taskId tới SUCCESS.",
      taskId: taskId.toHexString(),
      status: "PENDING" as const,
      maKhachHang: maKh,
      hanoiAccountId,
      period: { ky: kyNum, thang: thangNum, nam: namNum },
      payload,
    },
    202,
  );
});

/** GET /api/hanoi/bills?maKhachHang=&limit= — lấy electricity_bills EVN_HANOI */
hanoiRouter.get("/bills", async (c) => {
  const maKh = (c.req.query("maKhachHang") ?? c.req.query("maKH") ?? "").trim().toUpperCase();
  if (!maKh) {
    return c.json({ error: "Query maKhachHang là bắt buộc" }, 400);
  }
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const rows = await billRepo.find({
    maKhachHang: maKh,
    provider: "EVN_HANOI",
    status: "parsed",
    limit,
    sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
  });
  return c.json({
    provider: "EVN_HANOI",
    maKhachHang: maKh,
    total: rows.length,
    data: rows,
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

/** POST /api/hanoi/tasks — tạo task PENDING cho worker Hanoi */
hanoiRouter.post("/tasks", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      { error: "Body: { hanoiAccountId, ky, thang, nam } (hoặc period/month/year)" },
      400,
    );
  }

  const hanoiAccountId =
    typeof body.hanoiAccountId === "string"
      ? body.hanoiAccountId.trim()
      : typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";

  if (!hanoiAccountId) {
    return c.json({ error: "hanoiAccountId (ObjectId hex) là bắt buộc" }, 400);
  }

  let accountOid: ObjectId;
  try {
    accountOid = new ObjectId(hanoiAccountId);
  } catch {
    return c.json({ error: "hanoiAccountId không phải ObjectId hợp lệ" }, 400);
  }

  const acc = await hanoiRepo.findById(accountOid);
  if (!acc) return c.json({ error: "Không tìm thấy tài khoản Hanoi" }, 404);
  if (!acc.enabled) return c.json({ error: "Tài khoản Hanoi đã tắt" }, 400);

  const valid = validateKyThangNam(body.ky ?? body.period, body.thang ?? body.month, body.nam ?? body.year);
  if (!valid.ok) return c.json({ error: valid.error, code: valid.code }, 400);

  const { ky, thang, nam } = valid.value;

  const existing = await taskRepo.findActiveHanoiForPeriod(hanoiAccountId, ky, thang, nam);
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

  const payload = { hanoiAccountId, period: ky, month: thang, year: nam };
  const taskId = await taskRepo.insertPendingHanoi(payload);
  logger.info(
    `[api/hanoi] POST task ${taskId.toHexString()} — Hanoi ${acc.username} Kỳ ${ky} T${thang}/${nam}`,
  );

  return c.json(
    {
      message: "Đã tạo task Hanoi PENDING.",
      taskId: taskId.toHexString(),
      status: "PENDING",
      payload,
      isDuplicate: false,
    },
    201,
  );
});

/**
 * POST /api/hanoi/tasks/enqueue-all-enabled — xếp hàng mọi account Hanoi đang bật (cùng kỳ/tháng/năm).
 */
hanoiRouter.post("/tasks/enqueue-all-enabled", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      { error: "Body JSON: { ky, thang, nam } (hoặc period/month/year)", code: "VALIDATION_BODY_JSON" },
      400,
    );
  }

  const valid = validateKyThangNam(body.ky ?? body.period, body.thang ?? body.month, body.nam ?? body.year);
  if (!valid.ok) return c.json({ error: valid.error, code: valid.code }, 400);

  const { ky, thang, nam, kyNum, thangNum, namNum } = valid.value;

  const MAX_TOTAL = 5000;
  const accounts: HanoiAccount[] = [];
  for (let skip = 0; skip < MAX_TOTAL; skip += 500) {
    const batch = await hanoiRepo.listEnabled(skip, 500);
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
    const hanoiAccountId = acc._id!.toHexString();
    const existing = await taskRepo.findActiveHanoiForPeriod(hanoiAccountId, ky, thang, nam);
    if (existing) {
      skippedAlreadyActive++;
      continue;
    }
    const payload = { hanoiAccountId, period: ky, month: thang, year: nam };
    const taskId = await taskRepo.insertPendingHanoi(payload);
    tasksCreated++;
    taskIds.push(taskId.toHexString());
  }

  logger.info(
    `[api/hanoi] enqueue-all-enabled Kỳ ${ky} T${thang}/${nam}: created=${tasksCreated} skipActive=${skippedAlreadyActive} totalAccounts=${accounts.length}`,
  );

  return c.json(
    {
      agentMessage:
        tasksCreated > 0
          ? `Đã tạo ${tasksCreated} task PENDING (kỳ ${kyNum} tháng ${thangNum}/${namNum}). Worker xử lý theo WORKER_CONCURRENCY — theo dõi GET /api/tasks.`
          : `Không tạo task mới — tất cả ${accounts.length} tài khoản đã có task đang chờ/chạy, hoặc không có tài khoản enabled.`,
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
