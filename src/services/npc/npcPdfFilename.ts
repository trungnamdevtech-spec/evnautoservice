import path from "node:path";

/**
 * `{maKh}_{year}-{month}_ky{n}_{id_hdon}.pdf` — id_hdon có thể chứa `=` và ký tự đặc biệt.
 */
export function parseNpcPdfFilename(filePath: string): {
  maKh: string;
  year: string;
  month: string;
  ky: string;
  idHdon: string;
} | null {
  const name = path.basename(filePath, ".pdf");
  const m = /^(.+)_(\d{4})-(\d{2})_ky(\d+)_(.+)$/.exec(name);
  if (!m) return null;
  return { maKh: m[1]!, year: m[2]!, month: m[3]!, ky: m[4]!, idHdon: m[5]! };
}

export function isNpcPdfPath(filePath: string): boolean {
  return /[/\\]npc[/\\]/.test(filePath.replace(/\\/g, "/"));
}
