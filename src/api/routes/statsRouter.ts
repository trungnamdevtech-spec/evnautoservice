import { Hono } from "hono";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";
import { getRegionFromQuery } from "../regionQuery.js";

const repo = new ElectricityBillRepository();
export const statsRouter = new Hono();

// ── GET /stats/month?nam=2026 — tổng tiền/kWh từng tháng trong năm ───────────
statsRouter.get("/month", async (c) => {
  const nam = parseInt(c.req.query("nam") ?? String(new Date().getFullYear()), 10);
  const region = getRegionFromQuery(c);
  const data = await repo.aggregateByMonth(nam, region);
  return c.json({ region, nam, data });
});

// ── GET /stats/period?ky=1&thang=3&nam=2026 — tổng hợp 1 kỳ ─────────────────
statsRouter.get("/period", async (c) => {
  const ky    = parseInt(c.req.query("ky") ?? "0", 10) as 1 | 2 | 3;
  const thang = parseInt(c.req.query("thang") ?? "0", 10);
  const nam   = parseInt(c.req.query("nam") ?? "0", 10);

  if (!ky || !thang || !nam) {
    return c.json({ error: "Cần truyền: ky (1|2|3), thang, nam" }, 400);
  }

  const region = getRegionFromQuery(c);
  const data = await repo.aggregateByPeriod(ky, thang, nam, region);
  return c.json({ region, ky, thang, nam, ...data });
});

// ── GET /stats/customer/:maKhachHang/history — lịch sử tiêu thụ KH ──────────
statsRouter.get("/customer/:maKhachHang/history", async (c) => {
  const maKH = c.req.param("maKhachHang").toUpperCase();
  const region = getRegionFromQuery(c);
  const data = await repo.customerConsumptionHistory(maKH, region);
  if (data.length === 0) {
    return c.json({ error: `Không có dữ liệu cho mã "${maKH}" (region=${region})` }, 404);
  }
  return c.json({ region, maKhachHang: maKH, total: data.length, data });
});
