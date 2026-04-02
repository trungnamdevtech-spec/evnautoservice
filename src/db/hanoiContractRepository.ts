import type { Collection, ObjectId } from "mongodb";
import { getMongoDb } from "./mongo.js";
import type { HanoiContract } from "../types/hanoiHopDong.js";
import {
  extractMaKhachHangFromRow,
  normalizeHopDongRow,
} from "../services/hanoi/hanoiGetDanhSachHopDongClient.js";

const COLLECTION = "hanoi_contracts";

export class HanoiContractRepository {
  private collectionPromise: Promise<Collection<HanoiContract>> | null = null;
  private indexesEnsured = false;

  private async col(): Promise<Collection<HanoiContract>> {
    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        const db = await getMongoDb();
        return db.collection<HanoiContract>(COLLECTION);
      })();
    }
    const c = await this.collectionPromise;
    if (!this.indexesEnsured) {
      this.indexesEnsured = true;
      await c
        .createIndex({ hanoiAccountId: 1, maKhachHang: 1 }, { unique: true, background: true })
        .catch(() => undefined);
      await c.createIndex({ maKhachHang: 1 }, { background: true }).catch(() => undefined);
      await c.createIndex({ hanoiAccountId: 1 }, { background: true }).catch(() => undefined);
    }
    return c;
  }

  /** Xóa snapshot cũ — khi đổi mật khẩu / xóa token / disable. */
  async deleteByAccountId(accountId: ObjectId): Promise<number> {
    const c = await this.col();
    const r = await c.deleteMany({ hanoiAccountId: accountId });
    return r.deletedCount ?? 0;
  }

  /** Khi xóa toàn bộ tài khoản Hanoi (replace-bulk). */
  async deleteAll(): Promise<number> {
    const c = await this.col();
    const r = await c.deleteMany({});
    return r.deletedCount ?? 0;
  }

  /**
   * Thay toàn bộ danh sách hợp đồng của tài khoản (đồng bộ từ API).
   */
  async replaceAllForAccount(
    accountId: ObjectId,
    hanoiUsername: string,
    rows: Record<string, unknown>[],
    fetchedAt: Date,
  ): Promise<{ inserted: number; skippedNoMa: number }> {
    const c = await this.col();
    await c.deleteMany({ hanoiAccountId: accountId });

    const now = new Date();
    let skippedNoMa = 0;
    /** Trùng mã trong cùng response — giữ bản cuối. */
    const byMa = new Map<string, Record<string, unknown>>();
    for (const raw of rows) {
      const ma = extractMaKhachHangFromRow(raw);
      if (!ma) {
        skippedNoMa++;
        continue;
      }
      byMa.set(ma, raw);
    }

    const docs: HanoiContract[] = [];
    for (const [ma, raw] of byMa) {
      docs.push({
        hanoiAccountId: accountId,
        hanoiUsername: hanoiUsername.trim(),
        maKhachHang: ma,
        normalized: normalizeHopDongRow(raw),
        raw,
        fetchedAt,
        updatedAt: now,
      });
    }

    if (docs.length === 0) {
      return { inserted: 0, skippedNoMa };
    }

    await c.insertMany(docs);
    return { inserted: docs.length, skippedNoMa };
  }

  async findByAccountId(accountId: ObjectId): Promise<HanoiContract[]> {
    const c = await this.col();
    return c.find({ hanoiAccountId: accountId }).sort({ maKhachHang: 1 }).toArray();
  }

  /** Tra cứu theo mã KH (agent) — có thể nhiều tài khoản cùng quản lý một mã (hiếm). */
  async findByMaKhachHang(maKhachHang: string, limit = 50): Promise<HanoiContract[]> {
    const ma = maKhachHang.trim().toUpperCase();
    if (!ma) return [];
    const c = await this.col();
    return c
      .find({ maKhachHang: ma })
      .limit(Math.min(limit, 200))
      .sort({ updatedAt: -1 })
      .toArray();
  }

  async findOneByAccountAndMa(
    accountId: ObjectId,
    maKhachHang: string,
  ): Promise<HanoiContract | null> {
    const ma = maKhachHang.trim().toUpperCase();
    if (!ma) return null;
    const c = await this.col();
    return c.findOne({ hanoiAccountId: accountId, maKhachHang: ma });
  }
}
