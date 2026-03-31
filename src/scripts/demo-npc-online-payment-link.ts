/**
 * Demo: lấy link thanh toán trực tuyến (apicskhthanhtoan) cho N tài khoản NPC enabled đầu tiên.
 *
 * Usage:
 *   npm run demo:npc-online-payment-link -- [limit=3]
 *
 * Cần: MONGODB_URI, NPC_CREDENTIALS_SECRET, ANTICAPTCHA_API_KEY
 */

import "dotenv/config";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { NpcAccountRepository } from "../db/npcAccountRepository.js";
import { AnticaptchaClient } from "../services/captcha/AnticaptchaClient.js";
import { EVNNPCWorker } from "../providers/npc/EVNNPCWorker.js";
import { runNpcOnlinePaymentLinkWithPlaywright } from "../services/npc/npcOnlinePaymentLinkSession.js";
import { decryptNpcPassword } from "../services/crypto/npcCredentials.js";
import { env } from "../config/env.js";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  const limit = Math.min(20, Math.max(1, parseInt(process.argv[2] ?? "3", 10)));
  const secret = env.npcCredentialsSecret.trim();
  if (!secret) {
    console.error("Thiếu NPC_CREDENTIALS_SECRET");
    process.exit(1);
  }

  await getMongoDb();
  const repo = new NpcAccountRepository();
  const rows = await repo.listEnabled(0, limit);
  if (rows.length === 0) {
    console.error("Không có tài khoản NPC enabled.");
    process.exit(1);
  }

  const worker = new EVNNPCWorker(new AnticaptchaClient());

  for (const acc of rows) {
    const id = acc._id!;
    const pwd = decryptNpcPassword(acc.passwordEncrypted, secret);
    const trace = randomUUID();
    console.info(`--- ${acc.username} (${id.toHexString()}) trace=${trace} ---`);
    try {
      const r = await runNpcOnlinePaymentLinkWithPlaywright(worker, acc, id, pwd, acc.username, trace);
      if (r.ok) {
        console.info("OK paymentUrl:", r.paymentUrl);
      } else {
        console.warn("FAIL", r.code, r.reason);
      }
    } catch (e) {
      console.error("ERR", e instanceof Error ? e.message : e);
    }
  }

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
