/** Bản ghi MongoDB `hanoi_sync_jobs` — `_id` = `jobId` (UUID). */
export type HanoiSyncJobDocument = {
  _id: string;
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  result: {
    totalAccounts: number;
    ok: number;
    skipped: number;
    fail: number;
    errors: Array<{ username: string; error: string }>;
  } | null;
  options: {
    allInDb: boolean;
    forceRefresh: boolean;
    concurrency: number;
    delayMs: number;
  };
};
