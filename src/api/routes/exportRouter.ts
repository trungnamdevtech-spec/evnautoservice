import { Hono } from "hono";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { ExcelExportService } from "../../services/export/ExcelExportService.js";
import { getRegionFromQuery } from "../regionQuery.js";

const repo = new ElectricityBillRepository();
const excelSvc = new ExcelExportService();

export const exportRouter = new Hono();

/**
 * Tất cả route trả về file .xlsx với Content-Disposition: attachment.
 * Quy tắc: maKhachHang là chuẩn chính; ky/thang/nam là tùy chọn lọc.
 * Query `region` hoặc `provider`: EVN_CPC (mặc định, gồm bản ghi CPC cũ) | EVN_NPC | all.
 */

function xlsxResponse(buffer: Buffer, filename: string): Response {
  return new Response(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Length": String(buffer.length),
    },
  });
}

// ── GET /export/period?ky=1&thang=3&nam=2026 — toàn bộ HĐ 1 kỳ → Excel ─────
exportRouter.get("/period", async (c) => {
  const ky    = parseInt(c.req.query("ky") ?? "0", 10) as 1 | 2 | 3;
  const thang = parseInt(c.req.query("thang") ?? "0", 10);
  const nam   = parseInt(c.req.query("nam") ?? "0", 10);

  if (!ky || !thang || !nam) {
    return c.json({ error: "Cần truyền: ky (1|2|3), thang (1-12), nam" }, 400);
  }

  const region = getRegionFromQuery(c);
  const bills = await repo.findByPeriod(ky, thang, nam, region);
  if (bills.length === 0) {
    return c.json({ error: `Không có hóa đơn nào cho Kỳ ${ky} Tháng ${thang}/${nam} (region=${region})` }, 404);
  }

  const buffer = await excelSvc.exportByPeriod(bills, { ky, thang, nam });
  const filename = `HoaDon_${region}_Ky${ky}_T${String(thang).padStart(2,"0")}_${nam}.xlsx`;
  return xlsxResponse(buffer, filename);
});

// ── GET /export/month?thang=3&nam=2026 — toàn bộ HĐ tháng (mọi kỳ) → Excel ─
exportRouter.get("/month", async (c) => {
  const thang = parseInt(c.req.query("thang") ?? "0", 10);
  const nam   = parseInt(c.req.query("nam") ?? "0", 10);

  if (!thang || !nam) {
    return c.json({ error: "Cần truyền: thang (1-12), nam" }, 400);
  }

  const region = getRegionFromQuery(c);
  const bills = await repo.findByMonth(thang, nam, region);
  if (bills.length === 0) {
    return c.json({ error: `Không có hóa đơn nào cho Tháng ${thang}/${nam} (region=${region})` }, 404);
  }

  const buffer = await excelSvc.exportByPeriod(bills, { thang, nam });
  const filename = `HoaDon_${region}_T${String(thang).padStart(2,"0")}_${nam}.xlsx`;
  return xlsxResponse(buffer, filename);
});

// ── GET /export/customer/:maKhachHang — lịch sử 1 KH → Excel ────────────────
exportRouter.get("/customer/:maKhachHang", async (c) => {
  const maKH  = c.req.param("maKhachHang").toUpperCase();
  const thang = c.req.query("thang") ? parseInt(c.req.query("thang")!, 10) : undefined;
  const nam   = c.req.query("nam")   ? parseInt(c.req.query("nam")!, 10)   : undefined;
  const ky    = c.req.query("ky")    ? (parseInt(c.req.query("ky")!, 10) as 1 | 2 | 3) : undefined;
  const region = getRegionFromQuery(c);

  const bills = await repo.findByCustomer(maKH, { thang, nam, ky, regionScope: region });
  if (bills.length === 0) {
    return c.json({ error: `Không tìm thấy hóa đơn nào cho mã khách hàng "${maKH}" (region=${region})` }, 404);
  }

  const buffer = await excelSvc.exportByCustomer(bills, maKH);
  const suffix = thang && nam ? `_T${String(thang).padStart(2,"0")}_${nam}` : "";
  const filename = `HoaDon_${region}_${maKH}${suffix}.xlsx`;
  return xlsxResponse(buffer, filename);
});
