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
