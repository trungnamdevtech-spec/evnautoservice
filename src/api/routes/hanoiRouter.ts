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
import {
  effectiveMaKhachHangForBills,
  normalizeHanoiMaKhachHang,
  resolveHanoiAccountsByMaKhachHang,
  resolveSingleHanoiAccountByMaKhachHang,
} from "../../services/hanoi/hanoiResolveAccount.js";
import { getOrRefreshHanoiAccessToken } from "../../services/hanoi/hanoiTokenClient.js";
import { isHanoiLoginWrongCredentialsError } from "../../providers/hanoi/hanoiLoginErrors.js";
import { fireHanoiAccountWebhook } from "../../services/webhook/hanoiAccountWebhook.js";
import { fireHanoiEnsureBillWebhook } from "../../services/webhook/agentTaskWebhook.js";
import { runHanoiSyncKnownMaBatch } from "../../services/hanoi/hanoiSyncKnownMaBatch.js";
import { HanoiSyncJobRepository } from "../../db/hanoiSyncJobRepository.js";

const hanoiRepo = new HanoiAccountRepository();
const hanoiSyncJobRepo = new HanoiSyncJobRepository();
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
    knownMaKhachHang: a.knownMaKhachHang ?? [],
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** Trạng thái đăng nhập (không trả mật khẩu — chỉ phân loại). */
function credentialStatusOf(a: HanoiAccount): "ok" | "wrong_password" | "disabled" {
  if (a.disabledReason === "wrong_password") return "wrong_password";
  if (!a.enabled) return "disabled";
  return "ok";
}

function sanitizeAccountWithCredential(a: HanoiAccount): Record<string, unknown> {
  return {
    ...sanitizeAccount(a),
    credentialStatus: credentialStatusOf(a),
  };
}

async function runHanoiPasswordUpdateFlow(
  oid: ObjectId,
  idHex: string,
  passwordPlain: string,
  options: {
    verifyCredential: boolean;
    correlationId: string | null;
    /** PATCH: chỉ khi body có `enabled` boolean */
    setEnabled?: boolean;
  },
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const accBefore = await hanoiRepo.findById(oid);
  if (!accBefore) {
    return {
      ok: false,
      status: 404,
      body: { error: "Không tìm thấy tài khoản", code: "HANOI_ACCOUNT_NOT_FOUND" },
    };
  }
  const username = accBefore.username;

  const updated = await hanoiRepo.updatePasswordPlain(oid, passwordPlain);
  if (!updated) {
    return {
      ok: false,
      status: 404,
      body: { error: "Không cập nhật mật khẩu (không tìm thấy?)" },
    };
  }
  logger.info(`[api/hanoi] Đã đổi mật khẩu + bật lại tài khoản ${idHex}`);

  let stsAttempted = false;
  let stsSuccess: boolean | null = null;
  let stsError: string | null = null;
  let markedWrong = false;

  const secret = env.hanoiCredentialsSecret.trim();
  if (options.verifyCredential && secret) {
    stsAttempted = true;
    try {
      const accAfter = await hanoiRepo.findById(oid);
      if (accAfter) {
        await getOrRefreshHanoiAccessToken(accAfter, oid, passwordPlain, hanoiRepo, secret);
      }
      stsSuccess = true;
    } catch (e) {
      stsSuccess = false;
      stsError = e instanceof Error ? e.message : String(e);
      if (isHanoiLoginWrongCredentialsError(e)) {
        await hanoiRepo.markInvalidCredentials(oid, "wrong_password");
        markedWrong = true;
      }
    }
  } else if (options.verifyCredential && !secret) {
    stsAttempted = true;
    stsSuccess = false;
    stsError = "Server thiếu HANOI_CREDENTIALS_SECRET — không kiểm tra STS được";
  }

  await fireHanoiAccountWebhook({
    event: "hanoi.account.credential_update",
    hanoiAccountId: idHex,
    username,
    correlationId: options.correlationId,
    passwordUpdated: true,
    stsVerify: {
      attempted: stsAttempted,
      success: stsSuccess,
      errorMessage: stsError,
      markedWrongPassword: markedWrong,
    },
    occurredAt: new Date().toISOString(),
  });

  if (typeof options.setEnabled === "boolean") {
    await hanoiRepo.setEnabled(oid, options.setEnabled);
  }

  const accFinal = await hanoiRepo.findById(oid);
  return {
    ok: true,
    data: {
      id: idHex,
      username,
      passwordUpdated: true,
      enabled: accFinal?.enabled ?? true,
      disabledReason: accFinal?.disabledReason ?? null,
      credentialVerify: {
        attempted: stsAttempted,
        success: stsSuccess,
        error: stsError,
        markedWrongPassword: markedWrong,
      },
    },
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
 * GET /api/hanoi/accounts/stats — số lượng tài khoản (không trả mật khẩu).
 */
hanoiRouter.get("/accounts/stats", async (c) => {
  const stats = await hanoiRepo.countStats();
  return c.json({
    provider: "EVN_HANOI",
    ...stats,
    note:
      "wrongPassword là số bản ghi có disabledReason=wrong_password (có thể trùng tập con của disabled).",
  });
});

/**
 * GET /api/hanoi/accounts/list-all — toàn bộ tài khoản (phân trang), kèm credentialStatus (không trả mật khẩu).
 *
 * Query: credentialStatus=all | ok | wrong_password (mặc định all) — ok = đang bật và không wrong_password;
 * wrong_password = sai mật khẩu STS; all = mọi bản ghi.
 */
hanoiRouter.get("/accounts/list-all", async (c) => {
  const raw = (c.req.query("credentialStatus") ?? "all").trim().toLowerCase();
  let filter: "all" | "ok" | "wrong_password";
  if (raw === "" || raw === "all") filter = "all";
  else if (raw === "ok" || raw === "good") filter = "ok";
  else if (raw === "wrong_password" || raw === "wrong" || raw === "bad") filter = "wrong_password";
  else {
    return c.json(
      {
        error: "credentialStatus hợp lệ: all | ok | wrong_password (hoặc good / wrong / bad)",
        code: "VALIDATION_QUERY",
      },
      400,
    );
  }
  const skip = Math.max(0, parseInt(c.req.query("skip") ?? "0", 10));
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);
  const { total, accounts } = await hanoiRepo.listAccountsByCredentialFilter(filter, skip, limit);
  return c.json({
    provider: "EVN_HANOI",
    filter: { credentialStatus: filter },
    total,
    skip,
    limit,
    securityNote:
      "Mật khẩu không bao giờ được trả về. credentialStatus: ok | wrong_password | disabled.",
    accounts: accounts.map(sanitizeAccountWithCredential),
  });
});

/**
 * GET /api/hanoi/accounts/wrong-credentials — tài khoản STS/đăng nhập thất bại (không có password).
 */
hanoiRouter.get("/accounts/wrong-credentials", async (c) => {
  const skip = Math.max(0, parseInt(c.req.query("skip") ?? "0", 10));
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);
  const [total, rows] = await Promise.all([
    hanoiRepo.countWrongPasswordAccounts(),
    hanoiRepo.findWrongPasswordAccounts(skip, limit),
  ]);
  return c.json({
    provider: "EVN_HANOI",
    total,
    skip,
    limit,
    securityNote: "Mật khẩu không bao giờ được trả về.",
    accounts: rows.map(sanitizeAccountWithCredential),
  });
});

/**
 * POST /api/hanoi/sync-known-ma — chạy nền: đồng bộ userinfo + hợp đồng → knownMaKhachHang (cần env bật).
 * Body: { allInDb?, forceRefresh?, concurrency?, delayMs? } — Poll GET …/jobs/:jobId
 */
hanoiRouter.post("/sync-known-ma", async (c) => {
  if (!env.hanoiSyncKnownMaApiEnabled) {
    return c.json(
      {
        error:
          "Tính năng tắt — đặt HANOI_SYNC_KNOWN_MA_API_ENABLED=true trên server (và đảm bảo HANOI_CREDENTIALS_SECRET).",
        code: "FEATURE_DISABLED",
      },
      403,
    );
  }
  if (!env.hanoiCredentialsSecret.trim()) {
    return c.json({ error: "Thiếu HANOI_CREDENTIALS_SECRET", code: "SERVER_CONFIG" }, 500);
  }

  let body: Record<string, unknown> = {};
  try {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      body = ((await c.req.json()) as Record<string, unknown>) ?? {};
    }
  } catch {
    body = {};
  }

  const allInDb = body.allInDb === true || body.allInDb === "true" || body.allInDb === 1;
  const forceRefresh = !(
    body.forceRefresh === false ||
    body.forceRefresh === "false" ||
    body.forceRefresh === 0
  );
  let concurrency = parseInt(String(body.concurrency ?? "2"), 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = 2;
  if (concurrency > 16) concurrency = 16;
  let delayMs = parseInt(String(body.delayMs ?? "500"), 10);
  if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = 500;
  if (delayMs > 60_000) delayMs = 60_000;

  const options = { allInDb, forceRefresh, concurrency, delayMs };
  const jobId = await hanoiSyncJobRepo.createQueued(options);
  const startedAt = new Date();
  await hanoiSyncJobRepo.update(jobId, { status: "running", startedAt });

  void (async () => {
    try {
      const result = await runHanoiSyncKnownMaBatch({
        allInDb,
        forceRefresh,
        concurrency,
        delayMs,
      });
      const errors = result.errors.slice(0, 200);
      await hanoiSyncJobRepo.update(jobId, {
        status: "completed",
        finishedAt: new Date(),
        result: {
          totalAccounts: result.totalAccounts,
          ok: result.ok,
          skipped: result.skipped,
          fail: result.fail,
          errors,
        },
      });
      await hanoiSyncJobRepo.pruneExcessJobs(env.hanoiSyncJobMaxKeep);
    } catch (e) {
      await hanoiSyncJobRepo.update(jobId, {
        status: "failed",
        finishedAt: new Date(),
        error: e instanceof Error ? e.message : String(e),
      });
      await hanoiSyncJobRepo.pruneExcessJobs(env.hanoiSyncJobMaxKeep);
    }
  })();

  const base = env.evnAutocheckBaseUrl.replace(/\/$/, "");
  return c.json(
    {
      accepted: true,
      jobId,
      message:
        "Đồng bộ chạy nền — poll GET /api/hanoi/sync-known-ma/jobs/:jobId (trạng thái lưu MongoDB `hanoi_sync_jobs`).",
      pollUrl: `${base}/api/hanoi/sync-known-ma/jobs/${jobId}`,
    },
    202,
  );
});

/** GET /api/hanoi/sync-known-ma/jobs — danh sách job gần đây (phân trang). */
hanoiRouter.get("/sync-known-ma/jobs", async (c) => {
  const skip = Math.max(0, parseInt(c.req.query("skip") ?? "0", 10));
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const { total, jobs } = await hanoiSyncJobRepo.listRecent(skip, limit);
  return c.json({ total, skip, limit, jobs });
});

/** GET /api/hanoi/sync-known-ma/jobs/:jobId — trạng thái một job (MongoDB + tự fail nếu running quá lâu). */
hanoiRouter.get("/sync-known-ma/jobs/:jobId", async (c) => {
  const jobId = c.req.param("jobId")?.trim() ?? "";
  const job = await hanoiSyncJobRepo.findPublicByJobId(jobId);
  if (!job) {
    return c.json(
      { error: "Không tìm thấy job (sai id hoặc đã bị xóa do prune).", code: "JOB_NOT_FOUND" },
      404,
    );
  }
  return c.json(job);
});

/**
 * GET /api/hanoi/accounts — danh sách hoặc ?username= (đăng nhập) / ?maKhachHang= (mã KH tra cứu → có thể nhiều account)
 */
hanoiRouter.get("/accounts", async (c) => {
  const usernameQ = (c.req.query("username") ?? "").trim();
  const maKhQ = (c.req.query("maKhachHang") ?? c.req.query("maKH") ?? "").trim();

  if (usernameQ && maKhQ) {
    return c.json(
      {
        error: "Chỉ truyền một trong hai: username (đăng nhập) hoặc maKhachHang (mã KH tra cứu).",
        code: "VALIDATION_AMBIGUOUS",
      },
      400,
    );
  }

  if (usernameQ) {
    const acc = await hanoiRepo.findByUsername(usernameQ);
    if (!acc) {
      return c.json(
        { error: "Không tìm thấy hanoi_accounts", code: "HANOI_ACCOUNT_NOT_FOUND" },
        404,
      );
    }
    return c.json({ accounts: [sanitizeAccount(acc)], matchedBy: "username" as const });
  }

  if (maKhQ) {
    const list = await resolveHanoiAccountsByMaKhachHang(maKhQ, hanoiRepo, hanoiContractRepo);
    if (list.length === 0) {
      return c.json(
        {
          error: "Không có tài khoản nào gắn mã khách hàng này (đồng bộ hợp đồng/userinfo sau đăng nhập).",
          code: "HANOI_MA_KH_NOT_LINKED",
        },
        404,
      );
    }
    return c.json({
      accounts: list.map(sanitizeAccount),
      matchedBy: "ma_khach_hang" as const,
      maKhachHang: normalizeHanoiMaKhachHang(maKhQ),
    });
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

/**
 * PATCH /api/hanoi/accounts/:id — { enabled?, password?, verifyCredential?, correlationId? }
 * Sau khi đổi password: mặc định gọi STS thử (verifyCredential, mặc định true) và POST webhook (HANOI_ACCOUNT_WEBHOOK_URL).
 */
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
    return c.json(
      { error: "Body JSON: { enabled?, password?, verifyCredential?, correlationId? }" },
      400,
    );
  }

  const verifyCredential = !(
    body.verifyCredential === false ||
    body.verifyCredential === "false" ||
    body.verifyCredential === 0
  );
  const correlationId =
    typeof body.correlationId === "string" && body.correlationId.trim().length > 0
      ? body.correlationId.trim().slice(0, 256)
      : null;

  if (typeof body.password === "string" && body.password.length > 0) {
    const r = await runHanoiPasswordUpdateFlow(oid, idHex, body.password, {
      verifyCredential,
      correlationId,
      setEnabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    if (!r.ok) return c.json(r.body, 404);
    return c.json(r.data);
  }

  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Cần enabled (boolean) hoặc password (string)" }, 400);
  }

  const ok = await hanoiRepo.setEnabled(oid, body.enabled);
  if (!ok) return c.json({ error: "Không cập nhật được (không tìm thấy?)" }, 404);
  return c.json({ id: idHex, enabled: body.enabled });
});

/**
 * PUT /api/hanoi/accounts/:id/password — đổi mật khẩu (Postman-friendly; dùng cho tài khoản sai pw).
 * Body JSON: `{ "password": "mật_mới", "verifyCredential": true, "correlationId": "..." }`
 * Header: `x-api-key` khi bật API_KEY_AUTH_ENABLED (giống các API khác).
 */
hanoiRouter.put("/accounts/:id/password", async (c) => {
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
    return c.json(
      { error: "Body JSON: { password (bắt buộc), verifyCredential?, correlationId? }" },
      400,
    );
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (!password.length) {
    return c.json(
      { error: "password là bắt buộc (chuỗi không rỗng)", code: "VALIDATION_PASSWORD" },
      400,
    );
  }

  const verifyCredential = !(
    body.verifyCredential === false ||
    body.verifyCredential === "false" ||
    body.verifyCredential === 0
  );
  const correlationId =
    typeof body.correlationId === "string" && body.correlationId.trim().length > 0
      ? body.correlationId.trim().slice(0, 256)
      : null;

  const r = await runHanoiPasswordUpdateFlow(oid, idHex, password, {
    verifyCredential,
    correlationId,
  });
  if (!r.ok) return c.json(r.body, 404);
  return c.json(r.data);
});

// ── Tra cứu link thanh toán ──────────────────────────────────────────────────

/**
 * POST /api/hanoi/online-payment-link
 *
 * Mặc định async: trả 202 + taskId. Poll GET /api/tasks/:taskId.
 * Sync (chỉ khi bật env): body { "sync": true }.
 *
 * Body: { hanoiAccountId | hanoiAccountUsername | maKhachHang (resolve 1 account), maKhachHang? (mã tra cứu) }
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
  const explicitMaKh =
    typeof body.maKhachHang === "string" ? body.maKhachHang.trim() : "";

  const accountSelectors = [Boolean(idHexRaw), Boolean(hanoiAccountUsername), Boolean(explicitMaKh && !idHexRaw && !hanoiAccountUsername)].filter(Boolean).length;
  if (accountSelectors > 1) {
    return c.json(
      {
        error:
          "Chỉ một trong: hanoiAccountId, hanoiAccountUsername, hoặc maKhachHang (để resolve tài khoản duy nhất).",
        code: "VALIDATION_ACCOUNT_SELECTOR_AMBIGUOUS",
      },
      400,
    );
  }
  if (accountSelectors === 0) {
    return c.json(
      {
        error: "Thiếu hanoiAccountId, hanoiAccountUsername hoặc maKhachHang (resolve tài khoản).",
        code: "VALIDATION_HANOI_ACCOUNT_ID",
      },
      400,
    );
  }

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
  } else if (hanoiAccountUsername) {
    const found = await hanoiRepo.findByUsername(hanoiAccountUsername);
    if (!found) {
      return c.json({ error: "Không tìm thấy hanoi_accounts", code: "HANOI_ACCOUNT_NOT_FOUND" }, 404);
    }
    account = found;
    oid = found._id!;
    idHex = oid.toHexString();
  } else {
    const r = await resolveSingleHanoiAccountByMaKhachHang(explicitMaKh, hanoiRepo, hanoiContractRepo);
    if (!r.ok) {
      const status = r.code === "AMBIGUOUS" ? 409 : 404;
      return c.json(
        { error: r.message, code: r.code, candidates: r.candidates },
        status,
      );
    }
    account = r.account;
    oid = account._id!;
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

  const maKhNormalized = explicitMaKh
    ? normalizeHanoiMaKhachHang(explicitMaKh)
    : effectiveMaKhachHangForBills(undefined, account);

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
          "Đã có tác vụ lấy link thanh toán (cùng tài khoản + mã KH) đang PENDING/RUNNING. Poll GET /api/tasks/:taskId — resultMetadata.lookupPayload.onlinePaymentLink (urlThanhToan từ API TraCuu).",
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
        "Đã xếp hàng lấy link thanh toán (Bearer + API GetListThongTinNoKhachHang). Poll GET /api/tasks/:taskId tới SUCCESS. Kết quả: resultMetadata.lookupPayload.onlinePaymentLink.paymentUrl.",
    },
    202,
  );
});

// ── Hóa đơn ─────────────────────────────────────────────────────────────────

/**
 * POST /api/hanoi/ensure-bill — Agent: cache_hit hoặc 202+taskId
 *
 * Body: { username? (đăng nhập) | maKhachHang? (mã KH tra cứu — resolve account), không gộp nhầm hai nghĩa }
 *       ky|period, thang|month, nam|year
 *
 * Luồng: tra `electricity_bills` (EVN_HANOI + đúng kỳ) trước — giống NPC ensure-bill.
 * Với `maKhachHang`: đọc DB ngay sau khi validate kỳ (không cần resolve tài khoản nếu đã có bản parse).
 * Chỉ khi chưa có trong DB mới cần tài khoản bật để xếp hàng worker.
 */
hanoiRouter.post("/ensure-bill", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body phải là JSON hợp lệ.", code: "VALIDATION_BODY_JSON" }, 400);
  }

  const explicitUsername = typeof body.username === "string" ? body.username.trim() : "";
  const explicitMa = typeof body.maKhachHang === "string" ? body.maKhachHang.trim() : "";

  if ((!explicitUsername && !explicitMa) || (explicitUsername && explicitMa)) {
    return c.json(
      {
        error:
          "Cần đúng một trong hai: username (tên đăng nhập CSKH) hoặc maKhachHang (mã KH tra cứu — hệ thống chọn tài khoản).",
        code: "VALIDATION_USERNAME_OR_MA",
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
  const period = { ky: kyNum, thang: thangNum, nam: namNum };

  if (explicitUsername) {
    const found = await hanoiRepo.findByUsername(explicitUsername);
    if (!found) {
      return c.json(
        {
          error: `Chưa có tài khoản Hanoi cho username "${explicitUsername}". Thêm qua POST /api/hanoi/accounts.`,
          code: "HANOI_ACCOUNT_NOT_FOUND",
        },
        404,
      );
    }
    const maKh = effectiveMaKhachHangForBills(undefined, found);
    const bill = await billRepo.findHanoiParsedByCustomerPeriod(maKh, kyNum, thangNum, namNum);
    if (bill) {
      const hanoiAccountId = found._id!.toHexString();
      void fireHanoiEnsureBillWebhook({
        outcome: "cache_hit",
        maKhachHang: maKh,
        hanoiAccountId,
        period,
        taskId: null,
        billInvoiceId: bill.invoiceId,
        dataSource: "database",
      });
      return c.json({
        outcome: "cache_hit" as const,
        dataSource: "database" as const,
        agentMessage: "Dữ liệu hóa đơn EVN Hà Nội đã có — dùng GET /api/hanoi/bills để lấy.",
        maKhachHang: maKh,
        hanoiAccountId,
        period,
        bill,
      });
    }
    if (!found.enabled) {
      return c.json(
        { error: "Tài khoản Hanoi đã tắt — không thể tạo tác vụ quét.", code: "HANOI_ACCOUNT_DISABLED" },
        400,
      );
    }

    const hanoiAccountId = found._id!.toHexString();
    const existing = await taskRepo.findActiveHanoiForPeriod(hanoiAccountId, ky, thang, nam);
    if (existing) {
      void fireHanoiEnsureBillWebhook({
        outcome: "already_queued",
        maKhachHang: maKh,
        hanoiAccountId,
        period,
        taskId: existing._id!.toHexString(),
        billInvoiceId: null,
        dataSource: "task_queue",
      });
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
          period,
        },
        202,
      );
    }

    const payload: Record<string, unknown> = { hanoiAccountId, period: ky, month: thang, year: nam };
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
        period,
        payload,
      },
      202,
    );
  }

  const maKh = normalizeHanoiMaKhachHang(explicitMa);
  const billEarly = await billRepo.findHanoiParsedByCustomerPeriod(maKh, kyNum, thangNum, namNum);
  if (billEarly) {
    const rAcc = await resolveSingleHanoiAccountByMaKhachHang(explicitMa, hanoiRepo, hanoiContractRepo);
    const hanoiAccountId = rAcc.ok ? rAcc.account._id!.toHexString() : null;
    void fireHanoiEnsureBillWebhook({
      outcome: "cache_hit",
      maKhachHang: maKh,
      hanoiAccountId,
      period,
      taskId: null,
      billInvoiceId: billEarly.invoiceId,
      dataSource: "database",
    });
    return c.json({
      outcome: "cache_hit" as const,
      dataSource: "database" as const,
      agentMessage: "Dữ liệu hóa đơn EVN Hà Nội đã có — dùng GET /api/hanoi/bills để lấy.",
      maKhachHang: maKh,
      hanoiAccountId,
      period,
      bill: billEarly,
    });
  }

  const r = await resolveSingleHanoiAccountByMaKhachHang(explicitMa, hanoiRepo, hanoiContractRepo);
  if (!r.ok) {
    const status = r.code === "AMBIGUOUS" ? 409 : 404;
    return c.json({ error: r.message, code: r.code, candidates: r.candidates }, status);
  }
  const acc = r.account;
  if (!acc.enabled) {
    return c.json(
      { error: "Tài khoản Hanoi đã tắt — không thể tạo tác vụ quét.", code: "HANOI_ACCOUNT_DISABLED" },
      400,
    );
  }

  const hanoiAccountId = acc._id!.toHexString();
  const existing = await taskRepo.findActiveHanoiForPeriod(hanoiAccountId, ky, thang, nam);
  if (existing) {
    void fireHanoiEnsureBillWebhook({
      outcome: "already_queued",
      maKhachHang: maKh,
      hanoiAccountId,
      period,
      taskId: existing._id!.toHexString(),
      billInvoiceId: null,
      dataSource: "task_queue",
    });
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
        period,
      },
      202,
    );
  }

  const payload: Record<string, unknown> = {
    hanoiAccountId,
    period: ky,
    month: thang,
    year: nam,
    maKhachHang: maKh,
  };
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
      period,
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
      { error: "Body: { hanoiAccountId | maKhachHang, ky, thang, nam } (hoặc period/month/year)" },
      400,
    );
  }

  const idFromBody =
    typeof body.hanoiAccountId === "string"
      ? body.hanoiAccountId.trim()
      : typeof body.accountId === "string"
        ? body.accountId.trim()
        : "";
  const maForResolve = typeof body.maKhachHang === "string" ? body.maKhachHang.trim() : "";

  if (idFromBody && maForResolve) {
    return c.json(
      {
        error: "Chỉ một trong hai: hanoiAccountId hoặc maKhachHang (resolve tài khoản).",
        code: "VALIDATION_AMBIGUOUS",
      },
      400,
    );
  }
  if (!idFromBody && !maForResolve) {
    return c.json({ error: "hanoiAccountId hoặc maKhachHang (resolve đúng 1 account) là bắt buộc" }, 400);
  }

  let hanoiAccountId: string;
  let acc: HanoiAccount;
  let passMaToWorker: boolean;

  if (idFromBody) {
    let accountOid: ObjectId;
    try {
      accountOid = new ObjectId(idFromBody);
    } catch {
      return c.json({ error: "hanoiAccountId không phải ObjectId hợp lệ" }, 400);
    }
    const found = await hanoiRepo.findById(accountOid);
    if (!found) return c.json({ error: "Không tìm thấy tài khoản Hanoi" }, 404);
    acc = found;
    hanoiAccountId = idFromBody;
    passMaToWorker = false;
  } else {
    const r = await resolveSingleHanoiAccountByMaKhachHang(maForResolve, hanoiRepo, hanoiContractRepo);
    if (!r.ok) {
      const status = r.code === "AMBIGUOUS" ? 409 : 404;
      return c.json({ error: r.message, code: r.code, candidates: r.candidates }, status);
    }
    acc = r.account;
    hanoiAccountId = acc._id!.toHexString();
    passMaToWorker = true;
  }

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

  const payload: Record<string, unknown> = { hanoiAccountId, period: ky, month: thang, year: nam };
  if (passMaToWorker) {
    payload.maKhachHang = normalizeHanoiMaKhachHang(maForResolve);
  }
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
