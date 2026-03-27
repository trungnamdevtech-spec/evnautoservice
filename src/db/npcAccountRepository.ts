import type { Collection, ObjectId } from "mongodb";
import { getMongoDb } from "./mongo.js";
import type { NpcAccount } from "../types/npcAccount.js";
import { encryptNpcPassword } from "../services/crypto/npcCredentials.js";
import { env } from "../config/env.js";

const COLLECTION = "npc_accounts";

export class NpcAccountRepository {
  private collectionPromise: Promise<Collection<NpcAccount>> | null = null;
  private indexesEnsured = false;

  private async col(): Promise<Collection<NpcAccount>> {
    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        const db = await getMongoDb();
        return db.collection<NpcAccount>(COLLECTION);
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
    const secret = env.npcCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Chưa cấu hình NPC_CREDENTIALS_SECRET — không thể lưu mật khẩu an toàn");
    }
    const now = new Date();
    const passwordEncrypted = encryptNpcPassword(input.passwordPlain, secret);
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

  async findById(id: ObjectId): Promise<NpcAccount | null> {
    const c = await this.col();
    return c.findOne({ _id: id });
  }

  /**
   * Tra cứu theo username (trùng mã khách hàng MA_KH trên CSKH NPC).
   * Khớp không phân biệt hoa thường.
   */
  async findByUsername(username: string): Promise<NpcAccount | null> {
    const u = username.trim();
    if (!u) return null;
    const c = await this.col();
    const exact = await c.findOne({ username: u });
    if (exact) return exact;
    const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return c.findOne({ username: { $regex: new RegExp(`^${escaped}$`, "i") } });
  }

  /**
   * Tài khoản được phép đăng nhập: bật và không bị đánh dấu `wrong_password`
   * (phòng trường hợp dữ liệu lệch).
   */
  async listEnabled(skip = 0, limit = 200): Promise<NpcAccount[]> {
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
// dùng để lấy danh sách tất cả tài khoản NPC
  async listAll(skip = 0, limit = 200): Promise<NpcAccount[]> {
    const c = await this.col();
    return c
      .find({})
      .sort({ username: 1 })
      .skip(skip)
      .limit(Math.min(limit, 500))
      .toArray();
  }

  // dùng để lưu session/cookie của tài khoản NPC
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
// dùng để disable/enable tài khoản NPC
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

  /** Sai mật khẩu (SSR) — tắt tài khoản, không dùng cho task cho đến khi admin sửa. */
  async updatePasswordPlain(id: ObjectId, passwordPlain: string): Promise<boolean> {
    const secret = env.npcCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Chưa cấu hình NPC_CREDENTIALS_SECRET — không thể lưu mật khẩu an toàn");
    }
    const c = await this.col();
    const now = new Date();
    const passwordEncrypted = encryptNpcPassword(passwordPlain, secret);
    const res = await c.updateOne(
      { _id: id },
      {
        $set: {
          passwordEncrypted,
          enabled: true,
          updatedAt: now,
        },
        $unset: { disabledReason: "", lastAuthFailureAt: "" },
      },
    );
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
      },
    );
  }

  /** Thêm nhiều tài khoản (import hàng loạt). Trùng username → bỏ qua (skip). */
  async insertManyAccounts(
    rows: Array<{ username: string; passwordPlain: string; label?: string }>,
  ): Promise<{ inserted: number; skipped: number; errors: string[] }> {
    const secret = env.npcCredentialsSecret.trim();
    if (!secret) {
      throw new Error("Chưa cấu hình NPC_CREDENTIALS_SECRET — không thể lưu mật khẩu an toàn");
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
        const passwordEncrypted = encryptNpcPassword(passwordPlain, secret);
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
