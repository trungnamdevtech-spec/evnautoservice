import type { Collection, ObjectId } from "mongodb";
import { getMongoDb } from "./mongo.js";
import type { HanoiAccount } from "../types/hanoiAccount.js";
import type { HanoiUserInfoSnapshot } from "../types/hanoiUserInfo.js";
import { encryptHanoiPassword } from "../services/crypto/hanoiCredentials.js";
import { env } from "../config/env.js";
import { HanoiContractRepository } from "./hanoiContractRepository.js";

const COLLECTION = "hanoi_accounts";

const contractRepo = new HanoiContractRepository();

export class HanoiAccountRepository {
  private collectionPromise: Promise<Collection<HanoiAccount>> | null = null;
  private indexesEnsured = false;

  private async col(): Promise<Collection<HanoiAccount>> {
    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        const db = await getMongoDb();
        return db.collection<HanoiAccount>(COLLECTION);
      })();
    }
    const c = await this.collectionPromise;
    if (!this.indexesEnsured) {
      this.indexesEnsured = true;
      await c.createIndex({ username: 1 }, { unique: true }).catch(() => undefined);
      await c.createIndex({ knownMaKhachHang: 1 }, { background: true }).catch(() => undefined);
    }
    return c;
  }

  async insertAccount(input: {
    username: string;
    passwordPlain: string;
    label?: string;
  }): Promise<ObjectId> {
    const secret = env.hanoiCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Chưa cấu hình HANOI_CREDENTIALS_SECRET — không thể lưu mật khẩu an toàn");
    }
    const now = new Date();
    const passwordEncrypted = encryptHanoiPassword(input.passwordPlain, secret);
    const c = await this.col();
    const res = await c.insertOne({
      username: input.username.trim(),
      passwordEncrypted,
      enabled: true,
      label: input.label?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    });
    return res.insertedId;
  }

  async findById(id: ObjectId): Promise<HanoiAccount | null> {
    const c = await this.col();
    return c.findOne({ _id: id });
  }

  /**
   * Tài khoản có `knownMaKhachHang` chứa mã (đã chuẩn hoá uppercase).
   */
  async findByKnownMaKhachHang(maKhachHang: string): Promise<HanoiAccount[]> {
    const ma = maKhachHang.trim().toUpperCase();
    if (!ma) return [];
    const c = await this.col();
    return c
      .find({
        knownMaKhachHang: ma,
        enabled: true,
        $nor: [{ disabledReason: "wrong_password" }],
      })
      .limit(20)
      .toArray();
  }

  /**
   * Fallback khi chưa rebuild `knownMaKhachHang`: khớp `userInfo.maKhachHang` (không phân biệt hoa thường).
   */
  async findByUserInfoMaKhachHang(maKhachHang: string): Promise<HanoiAccount[]> {
    const ma = maKhachHang.trim().toUpperCase();
    if (!ma) return [];
    const c = await this.col();
    const escaped = ma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return c
      .find({
        enabled: true,
        $nor: [{ disabledReason: "wrong_password" }],
        "userInfo.maKhachHang": { $regex: new RegExp(`^${escaped}$`, "i") },
      })
      .limit(20)
      .toArray();
  }

  /**
   * Gộp mã KH từ `userInfo` + `hanoi_contracts` — gọi sau userinfo / hợp đồng.
   */
  async rebuildKnownMaKhachHang(accountId: ObjectId): Promise<string[]> {
    const c = await this.col();
    const acc = await this.findById(accountId);
    if (!acc) return [];

    const set = new Set<string>();
    const uiMa = acc.userInfo?.maKhachHang?.trim().toUpperCase();
    if (uiMa) set.add(uiMa);

    const contracts = await contractRepo.findByAccountId(accountId);
    for (const row of contracts) {
      const m = row.maKhachHang?.trim().toUpperCase();
      if (m) set.add(m);
    }

    const arr = [...set].sort((a, b) => a.localeCompare(b, "vi"));
    const now = new Date();
    await c.updateOne(
      { _id: accountId },
      { $set: { knownMaKhachHang: arr, updatedAt: now } },
    );
    return arr;
  }

  async findByUsername(username: string): Promise<HanoiAccount | null> {
    const u = username.trim();
    if (!u) return null;
    const c = await this.col();
    const exact = await c.findOne({ username: u });
    if (exact) return exact;
    const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return c.findOne({ username: { $regex: new RegExp(`^${escaped}$`, "i") } });
  }

  async listEnabled(skip = 0, limit = 200): Promise<HanoiAccount[]> {
    const c = await this.col();
    return c
      .find({
        enabled: true,
        $nor: [{ disabledReason: "wrong_password" }],
      })
      .sort({ username: 1 })
      .skip(skip)
      .limit(Math.min(limit, 500))
      .toArray();
  }

  async listAll(skip = 0, limit = 200): Promise<HanoiAccount[]> {
    const c = await this.col();
    return c
      .find({})
      .sort({ username: 1 })
      .skip(skip)
      .limit(Math.min(limit, 500))
      .toArray();
  }

  /** Thống kê nhanh cho dashboard / agent (không trả mật khẩu). */
  async countStats(): Promise<{
    total: number;
    enabled: number;
    disabled: number;
    wrongPassword: number;
  }> {
    const c = await this.col();
    const [total, enabled, disabled, wrongPassword] = await Promise.all([
      c.countDocuments({}),
      c.countDocuments({ enabled: true }),
      c.countDocuments({ enabled: false }),
      c.countDocuments({ disabledReason: "wrong_password" }),
    ]);
    return { total, enabled, disabled, wrongPassword };
  }

  /** Tài khoản bị đánh dấu sai mật khẩu (STS/worker). */
  async findWrongPasswordAccounts(skip = 0, limit = 200): Promise<HanoiAccount[]> {
    const c = await this.col();
    return c
      .find({ disabledReason: "wrong_password" })
      .sort({ username: 1 })
      .skip(skip)
      .limit(Math.min(limit, 500))
      .toArray();
  }

  async countWrongPasswordAccounts(): Promise<number> {
    const c = await this.col();
    return c.countDocuments({ disabledReason: "wrong_password" });
  }

  /**
   * Danh sách phân trang cho agent: `all` | tài khoản đăng nhập được (`ok`) | chỉ sai mật khẩu (`wrong_password`).
   */
  async listAccountsByCredentialFilter(
    filter: "all" | "ok" | "wrong_password",
    skip: number,
    limit: number,
  ): Promise<{ total: number; accounts: HanoiAccount[] }> {
    const c = await this.col();
    const q =
      filter === "wrong_password"
        ? { disabledReason: "wrong_password" as const }
        : filter === "ok"
          ? {
              enabled: true,
              $nor: [{ disabledReason: "wrong_password" }],
            }
          : {};
    const sk = Math.max(0, skip);
    const lim = Math.min(Math.max(1, limit), 500);
    const [total, accounts] = await Promise.all([
      c.countDocuments(q),
      c.find(q).sort({ username: 1 }).skip(sk).limit(lim).toArray(),
    ]);
    return { total, accounts };
  }

  async updateSession(
    id: ObjectId,
    storageStateJson: string | null,
    lastLoginAt: Date,
  ): Promise<void> {
    const c = await this.col();
    await c.updateOne(
      { _id: id },
      {
        $set: {
          storageStateJson: storageStateJson ?? undefined,
          lastLoginAt,
          updatedAt: lastLoginAt,
        },
      },
    );
  }

  /** Lưu Bearer access_token (đã mã hóa) + thời điểm hết hạn — luồng API login. */
  async updateApiToken(
    id: ObjectId,
    apiAccessTokenEncrypted: string,
    apiTokenExpiresAt: Date,
  ): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { _id: id },
      {
        $set: {
          apiAccessTokenEncrypted,
          apiTokenExpiresAt,
          lastLoginAt: now,
          updatedAt: now,
        },
      },
    );
  }

  async clearApiToken(id: ObjectId): Promise<void> {
    const c = await this.col();
    await c.updateOne(
      { _id: id },
      {
        $unset: {
          apiAccessTokenEncrypted: "",
          apiTokenExpiresAt: "",
          userInfo: "",
          userInfoFetchedAt: "",
          hopDongFetchedAt: "",
        },
        $set: { updatedAt: new Date() },
      },
    );
    await contractRepo.deleteByAccountId(id).catch(() => undefined);
  }

  /** Sau GET GetDanhSachHopDongByUserName. */
  async setHopDongFetchedAt(id: ObjectId, at: Date): Promise<void> {
    const c = await this.col();
    await c.updateOne({ _id: id }, { $set: { hopDongFetchedAt: at, updatedAt: new Date() } });
  }

  /** Lưu snapshot từ GET /connect/userinfo. */
  async updateUserInfo(id: ObjectId, userInfo: HanoiUserInfoSnapshot): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { _id: id },
      {
        $set: {
          userInfo,
          userInfoFetchedAt: now,
          updatedAt: now,
        },
      },
    );
    await this.rebuildKnownMaKhachHang(id).catch(() => undefined);
  }

  async setEnabled(id: ObjectId, enabled: boolean): Promise<boolean> {
    const c = await this.col();
    const now = new Date();
    const res = enabled
      ? await c.updateOne(
          { _id: id },
          { $set: { enabled: true, updatedAt: now }, $unset: { disabledReason: "" } },
        )
      : await c.updateOne({ _id: id }, { $set: { enabled: false, updatedAt: now } });
    return res.modifiedCount === 1;
  }

  async updatePasswordPlain(id: ObjectId, passwordPlain: string): Promise<boolean> {
    const secret = env.hanoiCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Chưa cấu hình HANOI_CREDENTIALS_SECRET — không thể lưu mật khẩu an toàn");
    }
    const c = await this.col();
    const now = new Date();
    const passwordEncrypted = encryptHanoiPassword(passwordPlain, secret);
    const res = await c.updateOne(
      { _id: id },
      {
        $set: {
          passwordEncrypted,
          enabled: true,
          updatedAt: now,
        },
        $unset: {
          disabledReason: "",
          lastAuthFailureAt: "",
          apiAccessTokenEncrypted: "",
          apiTokenExpiresAt: "",
          userInfo: "",
          userInfoFetchedAt: "",
          hopDongFetchedAt: "",
        },
      },
    );
    await contractRepo.deleteByAccountId(id).catch(() => undefined);
    return res.modifiedCount === 1;
  }

  async markInvalidCredentials(id: ObjectId, reason: string): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { _id: id },
      {
        $set: {
          enabled: false,
          disabledReason: reason,
          lastAuthFailureAt: now,
          updatedAt: now,
        },
        $unset: {
          apiAccessTokenEncrypted: "",
          apiTokenExpiresAt: "",
          userInfo: "",
          userInfoFetchedAt: "",
          hopDongFetchedAt: "",
        },
      },
    );
    await contractRepo.deleteByAccountId(id).catch(() => undefined);
  }

  async deleteAll(): Promise<number> {
    await contractRepo.deleteAll().catch(() => undefined);
    const c = await this.col();
    const r = await c.deleteMany({});
    return r.deletedCount ?? 0;
  }

  async insertManyAccounts(
    rows: Array<{ username: string; passwordPlain: string; label?: string }>,
  ): Promise<{ inserted: number; skipped: number; errors: string[] }> {
    const secret = env.hanoiCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Chưa cấu hình HANOI_CREDENTIALS_SECRET — không thể lưu mật khẩu an toàn");
    }
    const c = await this.col();
    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const row of rows) {
      const username = row.username?.trim();
      if (!username) {
        errors.push("bỏ qua dòng thiếu username");
        continue;
      }
      const passwordPlain = row.passwordPlain ?? "";
      if (!passwordPlain) {
        errors.push(`${username}: thiếu mật khẩu`);
        continue;
      }
      const now = new Date();
      try {
        const passwordEncrypted = encryptHanoiPassword(passwordPlain, secret);
        const res = await c.insertOne({
          username,
          passwordEncrypted,
          enabled: true,
          label: row.label?.trim() || undefined,
          createdAt: now,
          updatedAt: now,
        });
        if (res.insertedId) inserted++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/duplicate|E11000/i.test(msg)) {
          skipped++;
        } else {
          errors.push(`${username}: ${msg}`);
        }
      }
    }
    return { inserted, skipped, errors };
  }
}
