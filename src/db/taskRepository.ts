import type { Collection, Filter, ObjectId } from "mongodb";
import { getMongoDb } from "./mongo.js";
import type { InvoiceDownloadMetadata, ScrapeTask, TaskStatus } from "../types/task.js";

const COLLECTION = "scrape_tasks";

export interface TaskQueryOptions {
  status?: TaskStatus | TaskStatus[];
  provider?: string;
  limit?: number;
  skip?: number;
}

export class TaskRepository {
  private collectionPromise: Promise<Collection<ScrapeTask>> | null = null;

  private async col(): Promise<Collection<ScrapeTask>> {
    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        const db = await getMongoDb();
        return db.collection<ScrapeTask>(COLLECTION);
      })();
    }
    return this.collectionPromise;
  }

  /**
   * Claim nguyên tử một task PENDING — tránh hai worker lấy trùng.
   */
  async claimNextPending(workerId: string): Promise<ScrapeTask | null> {
    const c = await this.col();
    const now = new Date();
    const res = await c.findOneAndUpdate(
      { status: "PENDING", provider: { $in: ["EVN_CPC", "EVN_NPC"] } },
      { $set: { status: "RUNNING" as TaskStatus, workerId, updatedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    return res ?? null;
  }

  async findPending(limit: number): Promise<ScrapeTask[]> {
    const c = await this.col();
    return c
      .find({ status: "PENDING" })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async claimById(taskId: ObjectId, workerId: string): Promise<boolean> {
    const c = await this.col();
    const now = new Date();
    const res = await c.updateOne(
      { _id: taskId, status: "PENDING" },
      {
        $set: { status: "RUNNING" as TaskStatus, workerId, updatedAt: now },
      },
    );
    return res.modifiedCount === 1;
  }

  async markRunning(taskId: ObjectId, workerId: string): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { _id: taskId },
      { $set: { status: "RUNNING" as TaskStatus, workerId, updatedAt: now } },
    );
  }

  async markSuccess(taskId: ObjectId, metadata: InvoiceDownloadMetadata): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { _id: taskId },
      {
        $set: {
          status: "SUCCESS" as TaskStatus,
          resultMetadata: metadata,
          errorMessage: undefined,
          updatedAt: now,
        },
      },
    );
  }

  async markFailed(taskId: ObjectId, reason: string): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { _id: taskId },
      {
        $set: {
          status: "FAILED" as TaskStatus,
          errorMessage: reason.slice(0, 8000),
          updatedAt: now,
        },
      },
    );
  }

  async findById(taskId: ObjectId): Promise<ScrapeTask | null> {
    const c = await this.col();
    return c.findOne({ _id: taskId });
  }

  /** Tạo task PENDING (test / CRM đẩy job) */
  async insertPendingEvn(payload: Record<string, unknown>): Promise<ObjectId> {
    const c = await this.col();
    const now = new Date();
    const res = await c.insertOne({
      status: "PENDING",
      provider: "EVN_CPC",
      payload,
      createdAt: now,
      updatedAt: now,
    } as ScrapeTask);
    return res.insertedId;
  }

  /** Task quét NPC — payload cần `npcAccountId` + kỳ/tháng/năm */
  async insertPendingNpc(payload: Record<string, unknown>): Promise<ObjectId> {
    const c = await this.col();
    const now = new Date();
    const res = await c.insertOne({
      status: "PENDING",
      provider: "EVN_NPC",
      payload,
      createdAt: now,
      updatedAt: now,
    } as ScrapeTask);
    return res.insertedId;
  }

  async findActiveNpcForPeriod(
    npcAccountIdHex: string,
    ky: string,
    thang: string,
    nam: string,
  ): Promise<ScrapeTask | null> {
    const c = await this.col();
    return c.findOne({
      status: { $in: ["PENDING", "RUNNING"] },
      provider: "EVN_NPC",
      $and: [
        {
          $or: [
            { "payload.npcAccountId": npcAccountIdHex },
            { "payload.accountId": npcAccountIdHex },
          ],
        },
        {
          $or: [
            { "payload.period": ky, "payload.month": thang, "payload.year": nam },
            { "payload.ky": ky, "payload.thang": thang, "payload.nam": nam },
          ],
        },
      ],
    });
  }

  // ── API query methods ────────────────────────────────────────────────────

  /** Danh sách tasks theo nhiều filter, mới nhất trước */
  async findAll(opts: TaskQueryOptions = {}): Promise<ScrapeTask[]> {
    const c = await this.col();
    const filter: Filter<ScrapeTask> = {};
    if (opts.status) {
      filter.status = Array.isArray(opts.status) ? { $in: opts.status } : opts.status;
    }
    if (opts.provider) filter.provider = opts.provider as ScrapeTask["provider"];
    return c
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(opts.skip ?? 0)
      .limit(opts.limit ?? 50)
      .toArray();
  }

  /** Đếm tasks theo status */
  async countByStatus(): Promise<Record<TaskStatus, number>> {
    const c = await this.col();
    const result = await c
      .aggregate<{ _id: TaskStatus; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray();
    const counts = { PENDING: 0, RUNNING: 0, SUCCESS: 0, FAILED: 0 } as Record<TaskStatus, number>;
    for (const r of result) counts[r._id] = r.count;
    return counts;
  }

  /**
   * Kiểm tra task PENDING hoặc RUNNING đã tồn tại cho cùng ky/thang/nam.
   * Tránh tạo task trùng khi agent gọi lại.
   */
  async findActiveForPeriod(ky: string, thang: string, nam: string): Promise<ScrapeTask | null> {
    const c = await this.col();
    return c.findOne({
      status: { $in: ["PENDING", "RUNNING"] },
      provider: "EVN_CPC",
      $or: [
        { "payload.period": ky, "payload.month": thang, "payload.year": nam },
        { "payload.ky": ky,     "payload.thang": thang, "payload.nam": nam },
      ],
    });
  }

  /**
   * Hủy task đang PENDING (không thể hủy RUNNING — đã bị browser chiếm).
   * Trả về true nếu hủy thành công.
   */
  async cancelPending(taskId: ObjectId): Promise<boolean> {
    const c = await this.col();
    const res = await c.updateOne(
      { _id: taskId, status: "PENDING" },
      { $set: { status: "FAILED" as TaskStatus, errorMessage: "Hủy thủ công qua API", updatedAt: new Date() } },
    );
    return res.modifiedCount === 1;
  }

  /**
   * Tạo lại task mới (PENDING) từ payload của task cũ bị FAILED.
   * Dùng khi agent muốn retry sau lỗi.
   */
  async retryFailed(taskId: ObjectId): Promise<ObjectId | null> {
    const c = await this.col();
    const old = await c.findOne({ _id: taskId, status: "FAILED" });
    if (!old) return null;
    return this.insertPendingEvn(old.payload);
  }
}
