import { env } from "../config/env.js";

type Level = "debug" | "info" | "warn" | "error";

const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function effectiveLevel(): Level {
  const v = env.logLevel.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

function allow(level: Level): boolean {
  return rank[level] >= rank[effectiveLevel()];
}

/**
 * Log có mức — production: `LOG_LEVEL=info` (mặc định), chi tiết: `debug`.
 */
export const logger = {
  debug: (...a: unknown[]) => {
    if (allow("debug")) console.debug(...a);
  },
  info: (...a: unknown[]) => {
    if (allow("info")) console.info(...a);
  },
  warn: (...a: unknown[]) => {
    if (allow("warn")) console.warn(...a);
  },
  error: (...a: unknown[]) => {
    if (allow("error")) console.error(...a);
  },
};

/** Mốc xử lý task — dễ grep trên server: `[task <hex>] phase` */
export function logTaskPhase(taskIdHex: string, phase: string, detail?: string): void {
  const tail = detail && detail.length > 0 ? ` — ${detail}` : "";
  logger.info(`[task ${taskIdHex}] ${phase}${tail}`);
}
