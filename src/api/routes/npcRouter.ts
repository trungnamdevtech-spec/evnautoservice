import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { NpcAccountRepository } from "../../db/npcAccountRepository.js";
import { TaskRepository } from "../../db/taskRepository.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { logger } from "../../core/logger.js";
import type { NpcAccount } from "../../types/npcAccount.js";
import { validateKyThangNam } from "../../validation/kyThangNam.js";

const npcRepo = new NpcAccountRepository();
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

/** GET /api/npc/accounts — danh sách (không trả mật khẩu) */
npcRouter.get("/accounts", async (c) => {
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
 * POST /api/npc/ensure-bill — Agent: có dữ liệu trong DB hay cần quét
 *
 * Body: { username | maKhachHang, ky|period, thang|month, nam|year }
 * - username = mã khách hàng (MA_KH) trên NPC — phải đã có trong `npc_accounts`.
 * - Nếu đã có `electricity_bills` parsed cho đúng kỳ → 200 `outcome: cache_hit`.
 * - Nếu chưa có → tạo task PENDING (hoặc trả task đang chờ) → 202 + `agentMessage` hướng dẫn chờ / poll GET /api/tasks/:taskId.
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
  const bill = await billRepo.findNpcParsedByCustomerPeriod(maKh, kyNum, thangNum, namNum);
  if (bill) {
    return c.json({
      outcome: "cache_hit" as const,
      dataSource: "database" as const,
      agentMessage:
        "Dữ liệu hóa đơn đã có sẵn trong hệ thống (đã parse từ PDF). Có thể trả lời người dùng ngay.",
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
        agentMessage:
          "Dữ liệu chưa có trong cơ sở dữ liệu; đã có tác vụ quét đang chờ hoặc đang chạy cho cùng kỳ/tháng/năm. Vui lòng chờ và gọi GET /api/tasks/:taskId để theo dõi.",
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
      agentMessage:
        "Dữ liệu hiện không có sẵn trong cơ sở dữ liệu; hệ thống đã xếp hàng quét tự động (đăng nhập, tải PDF, parse). Vui lòng chờ vài phút và gọi GET /api/tasks/:taskId để kiểm tra trạng thái SUCCESS trước khi đọc lại hóa đơn.",
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

/** GET /api/npc/bills?maKhachHang=&limit= — electricity_bills đã parse (EVN_NPC) */
npcRouter.get("/bills", async (c) => {
  const maKh = (c.req.query("maKhachHang") ?? c.req.query("maKH") ?? "").trim().toUpperCase();
  if (!maKh) {
    return c.json({ error: "Query maKhachHang (mã khách hàng) là bắt buộc" }, 400);
  }
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const rows = await billRepo.find({
    maKhachHang: maKh,
    provider: "EVN_NPC",
    status: "parsed",
    limit,
    sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
  });
  return c.json({
    provider: "EVN_NPC",
    maKhachHang: maKh,
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
          ? `Đã tạo ${tasksCreated} task PENDING cho ${tasksCreated} tài khoản. Worker sẽ xử lý lần lượt/song song (theo WORKER_CONCURRENCY). Theo dõi GET /api/tasks?status=PENDING,RUNNING hoặc từng taskId.`
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
