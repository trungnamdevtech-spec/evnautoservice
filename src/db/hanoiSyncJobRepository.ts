import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getMongoDb } from "./mongo.js";
import { env } from "../config/env.js";
import type { HanoiSyncJobDocument } from "../types/hanoiSyncJob.js";
import { logger } from "../core/logger.js";

const COLLECTION = "hanoi_sync_jobs";

/** Payload JSON trả cho agent (ngày dạng ISO). */
export type HanoiSyncJobPublic = {
  jobId: string;
  status: HanoiSyncJobDocument["status"];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: HanoiSyncJobDocument["result"];
  options: HanoiSyncJobDocument["options"];
  storage: "mongodb";
};

function toPublic(doc: HanoiSyncJobDocument): HanoiSyncJobPublic {
  return {
    jobId: doc.jobId,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    startedAt: doc.startedAt ? doc.startedAt.toISOString() : null,
    finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
    error: doc.error,
    result: doc.result,
    options: doc.options,
    storage: "mongodb",
  };
}

export class HanoiSyncJobRepository {
  private collectionPromise: Promise<Collection<HanoiSyncJobDocument>> | null = null;
  private indexesEnsured = false;

  private async col(): Promise<Collection<HanoiSyncJobDocument>> {
    if (!this.collectionPromise) {
      this.collectionPromise = (async () => {
        const db = await getMongoDb();
        return db.collection<HanoiSyncJobDocument>(COLLECTION);
      })();
    }
    const c = await this.collectionPromise;
    if (!this.indexesEnsured) {
      this.indexesEnsured = true;
      await c.createIndex({ createdAt: -1 }, { background: true }).catch(() => undefined);
    }
    return c;
  }

  /**
   * Tạo job `queued` rồi trả `jobId`. Luôn lưu options để audit.
   */
  async createQueued(options: HanoiSyncJobDocument["options"]): Promise<string> {
    const jobId = randomUUID();
    const now = new Date();
    const doc: HanoiSyncJobDocument = {
      _id: jobId,
      jobId,
      status: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      options,
    };
    const c = await this.col();
    await c.insertOne(doc);
    return jobId;
  }

  async update(
    jobId: string,
    patch: Partial<
      Pick<
        HanoiSyncJobDocument,
        "status" | "startedAt" | "finishedAt" | "error" | "result"
      >
    >,
  ): Promise<boolean> {
    const c = await this.col();
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
    if (patch.error !== undefined) set.error = patch.error;
    if (patch.result !== undefined) set.result = patch.result;
    const res = await c.updateOne({ _id: jobId }, { $set: set });
    return res.matchedCount === 1;
  }

  /**
   * Đọc job; nếu `running` quá lâu (API restart) → chuyển `failed` một lần.
   */
  async findPublicByJobId(jobId: string): Promise<HanoiSyncJobPublic | null> {
    const c = await this.col();
    const staleMs = env.hanoiSyncJobStaleRunningMs;
    const doc = await c.findOne({ _id: jobId });
    if (!doc) return null;

    if (
      doc.status === "running" &&
      doc.startedAt &&
      Date.now() - doc.startedAt.getTime() > staleMs
    ) {
      const err =
        "Job running bị gián đoạn (timeout hoặc API đã restart). Tạo job mới bằng POST /api/hanoi/sync-known-ma.";
      await c.updateOne(
        { _id: jobId, status: "running" },
        { $set: { status: "failed", finishedAt: new Date(), error: err } },
      );
      const updated = await c.findOne({ _id: jobId });
      return updated ? toPublic(updated) : null;
    }

    return toPublic(doc);
  }

  async listRecent(skip: number, limit: number): Promise<{ total: number; jobs: HanoiSyncJobPublic[] }> {
    const c = await this.col();
    const [total, rows] = await Promise.all([
      c.countDocuments({}),
      c.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
    ]);
    return { total, jobs: rows.map(toPublic) };
  }

  /**
   * Sau khi job xong: giữ tối đa `maxKeep` bản ghi (xóa cũ nhất).
   */
  async pruneExcessJobs(maxKeep: number): Promise<void> {
    const c = await this.col();
    const total = await c.countDocuments({});
    if (total <= maxKeep) return;
    const excess = total - maxKeep;
    const oldest = await c
      .find({}, { projection: { _id: 1 } })
      .sort({ createdAt: 1 })
      .limit(excess)
      .toArray();
    if (oldest.length === 0) return;
    const r = await c.deleteMany({ _id: { $in: oldest.map((x) => x._id) } });
    logger.debug(`[hanoi-sync-job] pruneExcessJobs: deleted ${r.deletedCount} old job(s)`);
  }
}
