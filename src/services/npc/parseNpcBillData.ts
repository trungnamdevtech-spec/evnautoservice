import { logger } from "../../core/logger.js";
import type { NpcTraCuuBillRow } from "../../types/npcBill.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Tách mảng JSON sau `var billData = ` trong HTML/JS response (TraCuuHDSPC).
 * Dùng đếm ngoặc + bỏ qua chuỗi để không cắt nhầm khi có `]` trong base64 (ít gặp nhưng an toàn hơn regex tham lam).
 */
export function parseNpcBillDataFromTraCuuBody(html: string): NpcTraCuuBillRow[] {
  const marker = /var\s+billData\s*=\s*/;
  const m = marker.exec(html);
  if (!m) {
    logger.debug("[npc-bill-data] Không thấy 'var billData =' trong body TraCuuHDSPC");
    return [];
  }

  let i = m.index + m[0].length;
  while (i < html.length && /\s/.test(html[i]!)) i++;
  if (html[i] !== "[") {
    logger.debug("[npc-bill-data] Sau billData không phải mảng '['");
    return [];
  }

  const arrStart = i;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (; i < html.length; i++) {
    const c = html[i]!;

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[") {
      depth++;
      continue;
    }
    if (c === "]") {
      depth--;
      if (depth === 0) {
        const jsonStr = html.slice(arrStart, i + 1);
        try {
          const parsed = JSON.parse(jsonStr) as unknown;
          if (!Array.isArray(parsed)) return [];
          const out: NpcTraCuuBillRow[] = [];
          for (const row of parsed) {
            if (!isRecord(row)) continue;
            const id = row.id_hdon;
            if (typeof id !== "string" || !id.trim()) continue;
            out.push(row as NpcTraCuuBillRow);
          }
          return out;
        } catch (e) {
          logger.warn(`[npc-bill-data] JSON.parse billData lỗi: ${e instanceof Error ? e.message : e}`);
          return [];
        }
      }
    }
  }

  logger.warn("[npc-bill-data] Không khép được mảng billData (thiếu ']' tương ứng)");
  return [];
}
