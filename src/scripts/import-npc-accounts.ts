/**
 * Import danh sách tài khoản NPC từ file JSON vào MongoDB (collection npc_accounts).
 *
 * Chuẩn bị file (UTF-8), ví dụ `accounts.json`:
 *   [
 *     { "username": "MA_KH_1", "password": "MatKhau1!", "label": "optional" },
 *     { "username": "MA_KH_2", "password": "MatKhau2!" }
 *   ]
 *
 * Hoặc: { "accounts": [ ... ] }
 *
 * Yêu cầu: MONGODB_URI, NPC_CREDENTIALS_SECRET trong .env
 *
 * Usage:
 *   npx tsx src/scripts/import-npc-accounts.ts path/to/accounts.json
 *
 * Hoặc qua API (khi server chạy):
 *   POST /api/npc/accounts/bulk
 *   Body: { "accounts": [ { "username", "password", "label?" } ] }
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { NpcAccountRepository } from "../db/npcAccountRepository.js";

async function main(): Promise<void> {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: npx tsx src/scripts/import-npc-accounts.ts <file.json>");
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), fileArg);
  const text = await readFile(abs, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  const rawList = Array.isArray(parsed) ? parsed : (parsed as { accounts?: unknown }).accounts;
  if (!Array.isArray(rawList)) {
    throw new Error("File JSON phải là mảng hoặc { accounts: [...] }");
  }

  const rows: Array<{ username: string; passwordPlain: string; label?: string }> = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const username = typeof o.username === "string" ? o.username.trim() : "";
    const passwordPlain = typeof o.password === "string" ? o.password : "";
    const label = typeof o.label === "string" ? o.label.trim() : undefined;
    if (!username || !passwordPlain) {
      console.warn(`[import-npc] Bỏ qua dòng thiếu username/password: ${JSON.stringify(item)}`);
      continue;
    }
    rows.push({ username, passwordPlain, label });
  }

  if (rows.length === 0) {
    console.error("[import-npc] Không có dòng hợp lệ.");
    process.exit(1);
  }

  await getMongoDb();
  const repo = new NpcAccountRepository();
  const result = await repo.insertManyAccounts(rows);
  await closeMongo();

  console.info(
    `[import-npc] Xong: inserted=${result.inserted} skipped(duplicate)=${result.skipped} total=${rows.length}`,
  );
  if (result.errors.length > 0) {
    console.warn("[import-npc] Lỗi từng dòng:", result.errors.slice(0, 20));
  }
}

main().catch((err) => {
  console.error("[import-npc]", err instanceof Error ? err.message : err);
  process.exit(1);
});
