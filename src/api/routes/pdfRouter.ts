import { Hono } from "hono";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { InvoiceItemRepository } from "../../db/invoiceItemRepository.js";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import type { PdfFileType } from "../../types/invoiceItem.js";
import { buildPdfZipResponse, pdfEntryFileName } from "../../services/pdf/pdfZipService.js";
import type { NpcPdfKind } from "../../services/npc/npcElectricityBillId.js";

const repo = new InvoiceItemRepository();
const billRepo = new ElectricityBillRepository();
export const pdfRouter = new Hono();

function parsePdfFileType(raw: string | undefined): PdfFileType {
  const v = (raw ?? "TBAO").toUpperCase();
  return v === "HDON" ? "HDON" : "TBAO";
}

function toNormMonth(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 12) return undefined;
  return String(n);
}

function parseZipLimit(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 2000);
}

/** Query `kind`: mặc định thông báo; `tt` | `thanh_toan` = hóa đơn thanh toán (XemHoaDon_NPC). */
function parseNpcPdfKindQuery(q: string | undefined): NpcPdfKind {
  const v = (q ?? "").toLowerCase().trim();
  if (v === "tt" || v === "thanh_toan" || v === "payment") return "thanh_toan";
  return "thong_bao";
}

async function servePdfByPath(
  filePath: string,
  fileNameHint: string,
): Promise<Response> {
  const abs = path.resolve(filePath);
  const s = await stat(abs);
  if (!s.isFile()) {
    throw new Error(`Đường dẫn không phải file: ${abs}`);
  }
  const buf = await readFile(abs);
  return new Response(buf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileNameHint)}`,
      "Content-Length": String(buf.length),
    },
  });
}

// GET /api/pdf/npc/:idHdon?kind=tt|thanh_toan — PDF thông báo (mặc định) hoặc hóa đơn thanh toán
pdfRouter.get("/npc/:idHdon", async (c) => {
  let idHdon: string;
  try {
    idHdon = decodeURIComponent(c.req.param("idHdon"));
  } catch {
    return c.json({ error: "idHdon không hợp lệ" }, 400);
  }
  const kind = parseNpcPdfKindQuery(c.req.query("kind"));
  const bill = await billRepo.findByNpcIdHdon(idHdon, kind);
  if (!bill?.pdfPath) {
    return c.json({ error: `Không tìm thấy bản ghi electricity_bills cho id_hdon` }, 404);
  }
  if (bill.status !== "parsed") {
    return c.json(
      { error: "PDF chưa parse thành công hoặc đang lỗi", status: bill.status, parseError: bill.parseError },
      404,
    );
  }
  const hint = `${bill.maKhachHang}_npc_${idHdon.replace(/[^a-zA-Z0-9+=_-]/g, "_").slice(0, 40)}${kind === "thanh_toan" ? "_tt" : ""}.pdf`;
  try {
    return await servePdfByPath(bill.pdfPath, hint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Không đọc được file PDF trên disk", detail: msg, pdfPath: bill.pdfPath }, 500);
  }
});

// GET /api/pdf/npc/customer/:maKhachHang/list?limit=20
pdfRouter.get("/npc/customer/:maKhachHang/list", async (c) => {
  const maKhachHang = c.req.param("maKhachHang").toUpperCase();
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 200);
  const rows = await billRepo.find({
    maKhachHang: maKhachHang,
    provider: "EVN_NPC",
    status: "parsed",
    limit,
    sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
  });
  return c.json({
    provider: "EVN_NPC",
    maKhachHang,
    total: rows.length,
    data: rows.map((b) => ({
      npcIdHdon: b.npcIdHdon,
      npcPdfKind: b.npcPdfKind ?? "thong_bao",
      billKey: b.billKey,
      invoiceIdSurrogate: b.invoiceId,
      kyBill: b.kyBill,
      tongTienThanhToan: b.tongKet.tongTienThanhToan,
      hanThanhToan: b.hanThanhToan,
      pdfPath: path.relative(process.cwd(), path.resolve(b.pdfPath)).replace(/\\/g, "/"),
      downloadUrl: `/api/pdf/npc/${encodeURIComponent(b.npcIdHdon ?? "")}${b.npcPdfKind === "thanh_toan" ? "?kind=tt" : ""}`,
    })),
  });
});

// GET /api/pdf/hanoi/:invoiceId — PDF đã lưu từ electricity_bills (EVN_HANOI), theo invoiceId surrogate
pdfRouter.get("/hanoi/:invoiceId", async (c) => {
  const invoiceId = Number.parseInt(c.req.param("invoiceId"), 10);
  if (!Number.isFinite(invoiceId)) {
    return c.json({ error: "invoiceId phải là số nguyên" }, 400);
  }
  const bill = await billRepo.findByProviderInvoiceId("EVN_HANOI", invoiceId);
  if (!bill?.pdfPath) {
    return c.json(
      { error: `Không tìm thấy PDF EVN_HANOI đã parse cho invoiceId=${invoiceId}`, provider: "EVN_HANOI" },
      404,
    );
  }
  if (bill.status !== "parsed") {
    return c.json(
      { error: "PDF chưa parse thành công hoặc đang lỗi", status: bill.status, parseError: bill.parseError },
      404,
    );
  }
  const idHint = bill.hanoiIdHdon ?? String(invoiceId);
  const kindHint = bill.hanoiPdfKind === "gtgt" ? "_gtgt" : "_td";
  const hint = `${bill.maKhachHang}_hanoi_${String(idHint).replace(/[^a-zA-Z0-9+=_-]/g, "_").slice(0, 40)}${kindHint}.pdf`;
  try {
    return await servePdfByPath(bill.pdfPath, hint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "Không đọc được file PDF trên disk", detail: msg, pdfPath: bill.pdfPath }, 500);
  }
});

// GET /api/pdf/hanoi/customer/:maKhachHang/list?limit=20 — liệt kê bản ghi parse + URL tải
pdfRouter.get("/hanoi/customer/:maKhachHang/list", async (c) => {
  const maKhachHang = c.req.param("maKhachHang").toUpperCase();
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 200);
  const rows = await billRepo.find({
    maKhachHang,
    provider: "EVN_HANOI",
    status: "parsed",
    limit,
    sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
  });
  return c.json({
    provider: "EVN_HANOI",
    maKhachHang,
    total: rows.length,
    data: rows.map((b) => ({
      invoiceId: b.invoiceId,
      hanoiIdHdon: b.hanoiIdHdon ?? null,
      hanoiPdfKind: b.hanoiPdfKind ?? "tien_dien",
      kyBill: b.kyBill,
      tongTienThanhToan: b.tongKet.tongTienThanhToan,
      hanThanhToan: b.hanThanhToan,
      pdfPath: path.relative(process.cwd(), path.resolve(b.pdfPath)).replace(/\\/g, "/"),
      downloadUrl: `/api/pdf/hanoi/${b.invoiceId}`,
    })),
  });
});

// GET /api/pdf/invoice/:invoiceId?fileType=TBAO|HDON
pdfRouter.get("/invoice/:invoiceId", async (c) => {
  const invoiceId = Number.parseInt(c.req.param("invoiceId"), 10);
  if (!Number.isFinite(invoiceId)) {
    return c.json({ error: "invoiceId phải là số nguyên" }, 400);
  }
  const fileType = parsePdfFileType(c.req.query("fileType"));
  const ref = await repo.findPdfRefByInvoiceId(invoiceId, fileType);
  if (!ref) {
    return c.json({ error: `Không tìm thấy PDF ${fileType} cho invoiceId=${invoiceId}` }, 404);
  }
  try {
    const fileName = pdfEntryFileName(ref);
    return await servePdfByPath(ref.filePath, fileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: "PDF metadata có nhưng file không truy cập được trên disk", detail: msg, filePath: ref.filePath },
      500,
    );
  }
});

// GET /api/pdf/customer/:maKhachHang/latest?fileType=TBAO|HDON&ky=&thang=&nam=
pdfRouter.get("/customer/:maKhachHang/latest", async (c) => {
  const maKhachHang = c.req.param("maKhachHang").toUpperCase();
  const fileType = parsePdfFileType(c.req.query("fileType"));
  const ref = await repo.findLatestPdfRefByCustomer(maKhachHang, fileType, {
    ky: c.req.query("ky"),
    thang: toNormMonth(c.req.query("thang")),
    nam: c.req.query("nam"),
  });
  if (!ref) {
    return c.json(
      { error: `Không tìm thấy PDF ${fileType} cho mã khách hàng "${maKhachHang}" (theo filter hiện tại)` },
      404,
    );
  }
  try {
    const fileName = pdfEntryFileName(ref);
    return await servePdfByPath(ref.filePath, fileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: "PDF metadata có nhưng file không truy cập được trên disk", detail: msg, filePath: ref.filePath },
      500,
    );
  }
});

// GET /api/pdf/customer/:maKhachHang/zip?fileType=TBAO|HDON&ky=&thang=&nam=&limit=500
pdfRouter.get("/customer/:maKhachHang/zip", async (c) => {
  const maKhachHang = c.req.param("maKhachHang").toUpperCase();
  const fileType = parsePdfFileType(c.req.query("fileType"));
  const limit = parseZipLimit(c.req.query("limit"), 500);
  const refs = await repo.listPdfRefsByCustomerFiltered(maKhachHang, fileType, {
    ky: c.req.query("ky"),
    thang: toNormMonth(c.req.query("thang")),
    nam: c.req.query("nam"),
  }, limit);
  if (refs.length === 0) {
    return c.json(
      { error: `Không có PDF ${fileType} đã tải cho mã "${maKhachHang}" (theo filter hiện tại)` },
      404,
    );
  }
  const zipName = `PDF_${maKhachHang}_${fileType}_Ky${c.req.query("ky") ?? "all"}_T${c.req.query("thang") ?? "all"}_${c.req.query("nam") ?? "all"}`;
  const res = await buildPdfZipResponse(refs, zipName);
  if (!res) {
    return c.json(
      { error: "Có metadata trong DB nhưng không đọc được file PDF trên disk", invoiceCount: refs.length },
      500,
    );
  }
  return res;
});

// GET /api/pdf/period/zip?ky=1&thang=2&nam=2026&fileType=TBAO&limit=500
pdfRouter.get("/period/zip", async (c) => {
  const ky = c.req.query("ky");
  const thangN = Number.parseInt(c.req.query("thang") ?? "0", 10);
  const nam = c.req.query("nam");
  const fileType = parsePdfFileType(c.req.query("fileType"));
  const limit = parseZipLimit(c.req.query("limit"), 500);

  if (!ky || !Number.isFinite(thangN) || thangN < 1 || thangN > 12 || !nam) {
    return c.json({ error: "Cần truyền đủ: ky (1|2|3), thang (1-12), nam" }, 400);
  }

  const thang = String(thangN);
  const refs = await repo.listPdfRefsByPeriod(ky, thang, nam, fileType, limit);
  if (refs.length === 0) {
    return c.json(
      { error: `Không có PDF ${fileType} đã tải cho kỳ ${ky} tháng ${thang}/${nam}` },
      404,
    );
  }
  const zipName = `PDF_Ky${ky}_T${String(thang).padStart(2, "0")}_${nam}_${fileType}`;
  const res = await buildPdfZipResponse(refs, zipName);
  if (!res) {
    return c.json(
      { error: "Có metadata trong DB nhưng không đọc được file PDF trên disk", invoiceCount: refs.length },
      500,
    );
  }
  return res;
});

// GET /api/pdf/customer/:maKhachHang/list?fileType=TBAO|HDON&limit=20
// Dùng cho agent để xem danh sách invoice trước khi tải file cụ thể.
pdfRouter.get("/customer/:maKhachHang/list", async (c) => {
  const maKhachHang = c.req.param("maKhachHang").toUpperCase();
  const fileType = parsePdfFileType(c.req.query("fileType"));
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 200);
  const refs = await repo.listPdfRefsByCustomer(maKhachHang, fileType, limit);
  return c.json({
    maKhachHang,
    fileType,
    total: refs.length,
    zipUrl: `/api/pdf/customer/${maKhachHang}/zip?fileType=${fileType}&limit=${limit}`,
    data: refs.map((r) => ({
      invoiceId: r.invoiceId,
      ky: r.ky,
      thang: r.thang,
      nam: r.nam,
      ngayPhatHanh: r.ngayPhatHanh,
      bytes: r.bytes,
      downloadedAt: r.downloadedAt,
      // Chỉ trả path tương đối để giảm lộ cấu trúc máy chủ
      filePath: path.relative(process.cwd(), path.resolve(r.filePath)).replace(/\\/g, "/"),
      downloadUrl: `/api/pdf/invoice/${r.invoiceId}?fileType=${r.fileType}`,
    })),
  });
});

