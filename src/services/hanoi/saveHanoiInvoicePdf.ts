import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type { HanoiPdfKind } from "./hanoiElectricityBillId.js";

/**
 * `xem_hoa_don` — một file PDF từ API (chung cho parse TD + GTGT). `tien_dien` / `gtgt` — tên file riêng (legacy / tương thích).
 */
export type HanoiInvoicePdfStorageKind = HanoiPdfKind | "xem_hoa_don";

export async function saveHanoiInvoicePdf(
  buffer: Buffer,
  maKh: string,
  year: string,
  month: string,
  ky: string,
  idHdon: string | number,
  kind: HanoiInvoicePdfStorageKind,
): Promise<string> {
  const root = path.resolve(process.cwd(), env.pdfOutputDir);
  const dir = path.join(root, "hanoi");
  await mkdir(dir, { recursive: true });
  const safeId = String(idHdon).replace(/[^a-zA-Z0-9+=_-]/g, "_").slice(0, 24);
  const suffix =
    kind === "gtgt" ? "_gtgt" : kind === "tien_dien" ? "_td" : "_xem_hoa_don";
  const fn = `${maKh}_${year}-${month}_ky${ky}_${safeId}${suffix}.pdf`;
  const fp = path.join(dir, fn);
  await writeFile(fp, buffer);
  return fp;
}
