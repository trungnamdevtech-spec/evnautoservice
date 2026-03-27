import { Hono } from "hono";
import { ElectricityBillRepository } from "../../db/electricityBillRepository.js";

const repo = new ElectricityBillRepository();

export const billsRouter = new Hono();

/**
 * Quy tắc: maKhachHang là chuẩn tra cứu chính.
 * Tất cả route đều nhận maKhachHang dạng uppercase tự động.
 */

// ── GET /bills/customers — danh sách tất cả mã khách hàng ───────────────────
billsRouter.get("/customers", async (c) => {
  const list = await repo.listAllCustomers();
  return c.json({ total: list.length, data: list });
});

// ── GET /bills/customer/:maKhachHang — toàn bộ lịch sử 1 KH ─────────────────
billsRouter.get("/customer/:maKhachHang", async (c) => {
  const maKH = c.req.param("maKhachHang").toUpperCase();
  const thang = c.req.query("thang") ? parseInt(c.req.query("thang")!, 10) : undefined;
  const nam   = c.req.query("nam")   ? parseInt(c.req.query("nam")!, 10)   : undefined;
  const ky    = c.req.query("ky")    ? (parseInt(c.req.query("ky")!, 10) as 1 | 2 | 3) : undefined;

  const bills = await repo.findByCustomer(maKH, { thang, nam, ky });
  if (bills.length === 0) {
    return c.json({ error: `Không tìm thấy hóa đơn nào cho mã khách hàng "${maKH}"` }, 404);
  }
  return c.json({ maKhachHang: maKH, total: bills.length, data: bills });
});

// ── GET /bills/customer/:maKhachHang/latest — hóa đơn mới nhất ───────────────
billsRouter.get("/customer/:maKhachHang/latest", async (c) => {
  const maKH = c.req.param("maKhachHang").toUpperCase();
  const bill = await repo.findLatestByCustomer(maKH);
  if (!bill) {
    return c.json({ error: `Không tìm thấy hóa đơn nào cho mã khách hàng "${maKH}"` }, 404);
  }
  return c.json({ data: bill });
});

// ── GET /bills/customer/:maKhachHang/due-soon?days=7 ─────────────────────────
billsRouter.get("/customer/:maKhachHang/due-soon", async (c) => {
  const maKH = c.req.param("maKhachHang").toUpperCase();
  const days = parseInt(c.req.query("days") ?? "7", 10);
  const bills = await repo.findCustomerDueSoon(maKH, days);
  return c.json({ maKhachHang: maKH, dueSoonDays: days, total: bills.length, data: bills });
});

// ── GET /bills/customer/:maKhachHang/history — lịch sử tiêu thụ ──────────────
billsRouter.get("/customer/:maKhachHang/history", async (c) => {
  const maKH = c.req.param("maKhachHang").toUpperCase();
  const history = await repo.customerConsumptionHistory(maKH);
  if (history.length === 0) {
    return c.json({ error: `Không có dữ liệu lịch sử cho mã "${maKH}"` }, 404);
  }
  return c.json({ maKhachHang: maKH, total: history.length, data: history });
});

// ── GET /bills/period?ky=1&thang=3&nam=2026 — tất cả HĐ trong 1 kỳ ─────────
billsRouter.get("/period", async (c) => {
  const ky    = parseInt(c.req.query("ky") ?? "0", 10) as 1 | 2 | 3;
  const thang = parseInt(c.req.query("thang") ?? "0", 10);
  const nam   = parseInt(c.req.query("nam") ?? "0", 10);

  if (!ky || !thang || !nam) {
    return c.json({ error: "Cần truyền đủ: ky (1|2|3), thang (1-12), nam" }, 400);
  }

  const bills = await repo.findByPeriod(ky, thang, nam);
  return c.json({ ky, thang, nam, total: bills.length, data: bills });
});

// ── GET /bills/month?thang=3&nam=2026 — tất cả HĐ trong tháng (mọi kỳ) ──────
billsRouter.get("/month", async (c) => {
  const thang = parseInt(c.req.query("thang") ?? "0", 10);
  const nam   = parseInt(c.req.query("nam") ?? "0", 10);

  if (!thang || !nam) {
    return c.json({ error: "Cần truyền: thang (1-12), nam" }, 400);
  }

  const bills = await repo.findByMonth(thang, nam);
  return c.json({ thang, nam, total: bills.length, data: bills });
});

// ── GET /bills/due-soon?days=7 — tất cả HĐ sắp đến hạn ─────────────────────
billsRouter.get("/due-soon", async (c) => {
  const days = parseInt(c.req.query("days") ?? "7", 10);
  const bills = await repo.findDueSoon(days);
  return c.json({ dueSoonDays: days, total: bills.length, data: bills });
});

// ── GET /bills/npc/:idHdon — electricity_bills nguồn NPC (id_hdon URL-encode) ─
billsRouter.get("/npc/:idHdon", async (c) => {
  let idHdon: string;
  try {
    idHdon = decodeURIComponent(c.req.param("idHdon"));
  } catch {
    return c.json({ error: "idHdon không hợp lệ" }, 400);
  }
  const bill = await repo.findByNpcIdHdon(idHdon);
  if (!bill) {
    return c.json({ error: `Không tìm thấy electricity_bills cho id_hdon` }, 404);
  }
  return c.json({ provider: "EVN_NPC", data: bill });
});

// ── GET /bills/:invoiceId — lấy theo invoiceId (CPC — ID_HDON) ───────────────
billsRouter.get("/:invoiceId", async (c) => {
  const id = parseInt(c.req.param("invoiceId"), 10);
  if (isNaN(id)) return c.json({ error: "invoiceId phải là số nguyên" }, 400);
  const bill = await repo.findById(id);
  if (!bill) return c.json({ error: `Không tìm thấy invoiceId=${id}` }, 404);
  return c.json({ data: bill });
});
