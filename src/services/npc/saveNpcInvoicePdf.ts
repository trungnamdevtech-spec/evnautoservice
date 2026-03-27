import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";

export async function saveNpcInvoicePdf(
  buffer: Buffer,
  maKh: string,
  year: string,
  month: string,
  ky: string,
  idHdon: string,
): Promise<string> {
  const root = path.resolve(process.cwd(), env.pdfOutputDir);
  const dir = path.join(root, "npc");
  await mkdir(dir, { recursive: true });
  const safeId = idHdon.replace(/[^a-zA-Z0-9+=_-]/g, "_").slice(0, 48);
  const fn = `${maKh}_${year}-${month}_ky${ky}_${safeId}.pdf`;
  const fp = path.join(dir, fn);
  await writeFile(fp, buffer);
  return fp;
}
