import { ObjectId } from "mongodb";

export function parseNpcAccountIdFromPayload(payload: Record<string, unknown>): ObjectId {
  const raw = payload.npcAccountId ?? payload.accountId;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Task NPC thiếu payload.npcAccountId (ObjectId hex)");
  }
  try {
    return new ObjectId(raw.trim());
  } catch {
    throw new Error(`payload.npcAccountId không phải ObjectId hợp lệ: ${raw}`);
  }
}
