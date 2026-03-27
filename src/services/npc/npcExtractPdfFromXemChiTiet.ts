/** Magic bytes PDF */
const PDF_MAGIC = Buffer.from("%PDF");

export function looksLikePdfBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC);
}

function tryDecodeBase64ToPdf(s: string): Buffer | null {
  const clean = s.replace(/\s/g, "");
  if (clean.length < 20) return null;
  try {
    const buf = Buffer.from(clean, "base64");
    return looksLikePdfBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Thử lấy buffer PDF từ body text khi server không trả `Content-Type: application/pdf`.
 * - NPC XemChiTietHoaDon_NPC thường trả **chuỗi base64 thuần** (giống ý CPC: field `pdf` là base64, nhưng không bọc JSON).
 * - Hoặc JSON / data:application/pdf;base64,...
 */
export function tryExtractPdfBufferFromTextPayload(text: string): Buffer | null {
  let t = text.trim();
  if (t.startsWith("\ufeff")) t = t.slice(1);

  if (t.startsWith("%PDF")) {
    return Buffer.from(t, "latin1");
  }

  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }

  const wholeBodyPdf = tryDecodeBase64ToPdf(t);
  if (wholeBodyPdf) return wholeBodyPdf;

  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      for (const key of ["pdf", "Pdf", "PDF", "fileBase64", "FileBase64", "Data", "data", "base64"]) {
        const v = j[key];
        if (typeof v === "string") {
          const buf = tryDecodeBase64ToPdf(v);
          if (buf) return buf;
        }
      }
    } catch {
      /* không phải JSON */
    }
  }

  const dataUri = /data:application\/pdf;base64,([A-Za-z0-9+/=\r\n]+)/i.exec(t);
  if (dataUri?.[1]) {
    const buf = tryDecodeBase64ToPdf(dataUri[1]);
    if (buf) return buf;
  }

  return null;
}
