import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";
import type { HanoiPdfKind } from "./hanoiElectricityBillId.js";

export async function saveHanoiInvoicePdf(
  buffer: Buffer,
  maKh: string,
  year: string,
  month: string,
  ky: string,
  idHdon: string | number,
  kind: HanoiPdfKind,
): Promise<string> {
  const root = path.resolve(process.cwd(), env.pdfOutputDir);
  const dir = path.join(root, "hanoi");
  await mkdir(dir, { recursive: true });
  const safeId = String(idHdon).replace(/[^a-zA-Z0-9+=_-]/g, "_").slice(0, 24);
  const suffix = kind === "gtgt" ? "_gtgt" : "_td";
  const fn = `${maKh}_${year}-${month}_ky${ky}_${safeId}${suffix}.pdf`;
  const fp = path.join(dir, fn);
  await writeFile(fp, buffer);
  return fp;
}
