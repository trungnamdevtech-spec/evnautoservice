import { ObjectId } from "mongodb";
import type { ScrapeTask } from "../../types/task.js";

/**
 * Trích `hanoiAccountId` (ObjectId) từ payload task Hanoi.
 * Chấp nhận `hanoiAccountId` hoặc `accountId` (fallback).
 */
export function parseHanoiAccountIdFromPayload(task: ScrapeTask): ObjectId {
  const raw =
    typeof task.payload.hanoiAccountId === "string"
      ? task.payload.hanoiAccountId.trim()
      : typeof task.payload.accountId === "string"
        ? task.payload.accountId.trim()
        : "";

  if (!raw) {
    throw new Error(
      `Hanoi task payload thiếu hanoiAccountId. Payload: ${JSON.stringify(task.payload).slice(0, 500)}`,
    );
  }

  try {
    return new ObjectId(raw);
  } catch {
    throw new Error(`hanoiAccountId không phải ObjectId hợp lệ: "${raw}"`);
  }
}
