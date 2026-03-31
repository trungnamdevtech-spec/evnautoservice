import path from "node:path";
import type { NpcPdfKind } from "./npcElectricityBillId.js";

export interface ParsedNpcPdfFilename {
  maKh: string;
  year: string;
  month: string;
  ky: string;
  idHdon: string;
  /** `_tt` trên tên file = hóa đơn thanh toán (XemHoaDon_NPC) */
  kind: NpcPdfKind;
}

/**
 * `{maKh}_{year}-{month}_ky{n}_{id_hdon}.pdf` — thông báo.
 * `{maKh}_{year}-{month}_ky{n}_{id_hdon}_tt.pdf` — hóa đơn thanh toán.
 */
export function parseNpcPdfFilename(filePath: string): ParsedNpcPdfFilename | null {
  const name = path.basename(filePath, ".pdf");
  const isPayment = name.endsWith("_tt");
  const core = isPayment ? name.slice(0, -3) : name;
  const m = /^(.+)_(\d{4})-(\d{2})_ky(\d+)_(.+)$/.exec(core);
  if (!m) return null;
  return {
    maKh: m[1]!,
    year: m[2]!,
    month: m[3]!,
    ky: m[4]!,
    idHdon: m[5]!,
    kind: isPayment ? "thanh_toan" : "thong_bao",
  };
}

export function npcBillKeyFromParsedFilename(meta: ParsedNpcPdfFilename): string {
  return meta.kind === "thanh_toan" ? `npc:tt:${meta.idHdon}` : `npc:${meta.idHdon}`;
}

export function isNpcPdfPath(filePath: string): boolean {
  return /[/\\]npc[/\\]/.test(filePath.replace(/\\/g, "/"));
}
