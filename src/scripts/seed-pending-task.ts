/**
 * Tạo một task PENDING trong MongoDB để worker hoặc test:e2e xử lý.
 *
 * **npm 10+ nuốt mọi cờ `--period=...`** — không dùng `npm run seed:task -- --period=1`.
 *
 * Cách ổn định:
 * 1) Gọi trực tiếp node:
 *    node --import tsx src/scripts/seed-pending-task.ts --period 1 --month 03 --year 2026
 *
 * 2) Biến môi trường (rồi `npm run seed:task` không cần tham số):
 *    PowerShell:
 *      $env:SEED_PERIOD='1'; $env:SEED_MONTH='03'; $env:SEED_YEAR='2026'; npm run seed:task
 *
 * 3) npm script có sẵn tham số trong package.json: `npm run seed:task:demo`
 */
import "dotenv/config";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { TaskRepository } from "../db/taskRepository.js";

function mergeEnvSeed(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (process.env.SEED_PERIOD) o.period = process.env.SEED_PERIOD;
  if (process.env.SEED_MONTH) o.month = process.env.SEED_MONTH;
  if (process.env.SEED_YEAR) o.year = process.env.SEED_YEAR;
  if (process.env.SEED_PAYLOAD?.trim()) {
    try {
      Object.assign(o, JSON.parse(process.env.SEED_PAYLOAD) as Record<string, unknown>);
    } catch {
      throw new Error("SEED_PAYLOAD không phải JSON hợp lệ");
    }
  }
  return o;
}

function parseSeedPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--payload=")) {
      const json = a.slice("--payload=".length);
      Object.assign(payload, JSON.parse(json) as Record<string, unknown>);
      continue;
    }
    const set = (key: string, val: string) => {
      payload[key] = val;
    };
    if (a.startsWith("--period=")) {
      set("period", a.slice("--period=".length));
      continue;
    }
    if (a.startsWith("--month=")) {
      set("month", a.slice("--month=".length));
      continue;
    }
    if (a.startsWith("--year=")) {
      set("year", a.slice("--year=".length));
      continue;
    }
    if (a === "--period" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      set("period", argv[++i]);
      continue;
    }
    if (a === "--month" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      set("month", argv[++i]);
      continue;
    }
    if (a === "--year" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      set("year", argv[++i]);
      continue;
    }
    if (a === "-p" && argv[i + 1]) {
      set("period", argv[++i]);
      continue;
    }
    if (a === "-m" && argv[i + 1]) {
      set("month", argv[++i]);
      continue;
    }
    if (a === "-y" && argv[i + 1]) {
      set("year", argv[++i]);
      continue;
    }
  }

  const hasPeriod = "period" in payload || "ky" in payload;
  if (!hasPeriod) {
    const pos = argv.filter((x) => !x.startsWith("-") && !x.includes("="));
    if (pos.length >= 3) {
      const [a, b, c] = pos;
      if (/^\d+$/.test(a) && /^\d{1,2}$/.test(b) && /^\d{4}$/.test(c)) {
        payload.period = a;
        payload.month = b.padStart(2, "0");
        payload.year = c;
      }
    }
  }

  return payload;
}

async function main(): Promise<void> {
  const fromEnv = mergeEnvSeed();
  const fromArgv = parseSeedPayload();
  const payload = { ...fromEnv, ...fromArgv };

  await getMongoDb();
  const repo = new TaskRepository();
  const id = await repo.insertPendingEvn(payload);
  console.info("[seed:task] Đã chèn task PENDING _id:", id.toHexString());
  console.info("[seed:task] payload:", JSON.stringify(payload));
  await closeMongo();
}

main().catch((err) => {
  console.error("[seed:task]", err);
  process.exit(1);
});
