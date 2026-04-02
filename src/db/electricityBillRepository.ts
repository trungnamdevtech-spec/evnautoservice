import type { Collection, Filter, Sort } from "mongodb";
import { getMongoDb } from "./mongo.js";
import type { ElectricityBill, ElectricityProvider } from "../types/electricityBill.js";
import type { NpcPdfKind } from "../services/npc/npcElectricityBillId.js";
import { npcBillKey } from "../services/npc/npcElectricityBillId.js";
import type { HanoiPdfKind } from "../services/hanoi/hanoiElectricityBillId.js";
import { hanoiBillKey } from "../services/hanoi/hanoiElectricityBillId.js";
import { PARSER_VERSION } from "../services/pdf/ElectricityBillParser.js";
import type { ElectricityBillRegionScope } from "./electricityBillRegionScope.js";
import { mergeFilterWithRegion } from "./electricityBillRegionScope.js";

const COLLECTION = "electricity_bills";

export interface BillQueryOptions {
  maKhachHang?: string;
  maDonViQuanLy?: string;
  /** Lọc theo nguồn — EVN_NPC: chỉ NPC; EVN_CPC: CPC + bản ghi cũ không có `provider` */
  provider?: ElectricityProvider;
  /**
   * Khi không truyền `provider`: lọc theo miền (mặc định EVN_CPC — không trộn NPC).
   * `all`: không lọc miền (trộn toàn bộ — chỉ dùng khi cần).
   */
  regionScope?: ElectricityBillRegionScope;
  ky?: 1 | 2 | 3;
  thang?: number;
  nam?: number;
  /** Tìm hóa đơn có hạn thanh toán trước ngày này */
  hanThanhToanBefore?: Date;
  /** Tìm hóa đơn có hạn thanh toán từ ngày này */
  hanThanhToanAfter?: Date;
  status?: ElectricityBill["status"];
  limit?: number;
  sort?: Sort;
  /**
   * Chỉ EVN_NPC: lọc loại PDF — thông báo vs HĐ GTGT thanh toán.
   * `all` hoặc không truyền: cả hai (kèm bản ghi cũ không có `npcPdfKind`).
   */
  npcPdfKind?: NpcPdfKind | "all";
}

export class ElectricityBillRepository {
  private colPromise: Promise<Collection<ElectricityBill>> | null = null;

  private async col(): Promise<Collection<ElectricityBill>> {
    if (!this.colPromise) {
      this.colPromise = (async () => {
        const db = await getMongoDb();
        const c = db.collection<ElectricityBill>(COLLECTION);
        // Unique: một hóa đơn chỉ có một bản ghi parsed
        // CPC (và bản ghi cũ không có provider): invoiceId vẫn unique. NPC dùng billKey / npcIdHdon — không ép unique invoiceId.
        await c
          .createIndex(
            { invoiceId: 1 },
            {
              unique: true,
              partialFilterExpression: {
                $or: [{ provider: "EVN_CPC" }, { provider: { $exists: false } }],
              },
              background: true,
            },
          )
          .catch(() => undefined);
        await c.createIndex({ billKey: 1 }, { unique: true, sparse: true, background: true }).catch(() => undefined);
        await c.createIndex({ npcIdHdon: 1 }, { sparse: true, background: true }).catch(() => undefined);
        await c.createIndex({ provider: 1 }, { background: true }).catch(() => undefined);
        // Query theo khách hàng + kỳ
        await c.createIndex(
          { maKhachHang: 1, "kyBill.ky": 1, "kyBill.thang": 1, "kyBill.nam": 1 },
          { background: true },
        ).catch(() => undefined);
        // Query theo hạn thanh toán (reminder, báo cáo sắp đến hạn)
        await c.createIndex({ hanThanhToan: 1 }, { background: true }).catch(() => undefined);
        // Query theo đơn vị điện lực
        await c.createIndex({ maDonViQuanLy: 1 }, { background: true }).catch(() => undefined);
        // EVN_HANOI: truy vấn theo KH + tháng/năm (mọi kỳ) hoặc theo id hệ thống
        await c
          .createIndex(
            { provider: 1, maKhachHang: 1, "kyBill.thang": 1, "kyBill.nam": 1 },
            { background: true },
          )
          .catch(() => undefined);
        await c
          .createIndex({ provider: 1, hanoiIdHdon: 1 }, { sparse: true, background: true })
          .catch(() => undefined);
        // Query trạng thái parse (pending / error để re-parse)
        await c.createIndex({ status: 1 }, { background: true }).catch(() => undefined);
        return c;
      })();
    }
    return this.colPromise;
  }

  /**
   * Upsert một hóa đơn đã parse.
   *
   * **Trùng lặp / idempotency**
   * - CPC: khóa theo `invoiceId` (ID_HDON) hoặc `billKey: cpc:<id>`.
   * - NPC: khóa theo `billKey: npc:<id_hdon>` hoặc `npcIdHdon` — cùng một hóa đơn không tạo hai bản ghi;
   *   parse lại chỉ ghi đè bản hiện có (cùng parseVersion khi batch bỏ qua nhờ `findPendingNpcParse`).
   */
  async upsert(bill: ElectricityBill): Promise<{ isNew: boolean }> {
    const c = await this.col();
    const now = new Date();
    const { _id, createdAt, ...rest } = bill;
    const filter =
      bill.billKey != null && bill.billKey.length > 0
        ? { billKey: bill.billKey }
        : bill.npcIdHdon != null && bill.npcIdHdon.length > 0
          ? { npcIdHdon: bill.npcIdHdon }
          : {
              invoiceId: bill.invoiceId,
              $or: [
                { provider: { $ne: "EVN_NPC" as const } },
                { provider: { $exists: false } },
              ],
            };
    const result = await c.updateOne(
      filter,
      {
        $set: { ...rest, updatedAt: now },
        $setOnInsert: { createdAt: createdAt ?? now },
        // Xóa parseError cũ nếu lần này parse thành công
        $unset: { parseError: "" },
      },
      { upsert: true },
    );
    return { isNew: result.upsertedCount === 1 };
  }

  /**
   * Đánh dấu parse lỗi cho một invoiceId.
   */
  async markError(invoiceId: number, pdfPath: string, error: string): Promise<void> {
    const c = await this.col();
    const now = new Date();
    await c.updateOne(
      { invoiceId },
      {
        $set: {
          invoiceId,
          pdfPath,
          status: "error",
          parseError: error.slice(0, 1000),
          parseVersion: PARSER_VERSION,
          parsedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  /** Đánh dấu parse lỗi cho một bản ghi NPC (theo id_hdon). */
  async markNpcError(
    npcIdHdon: string,
    invoiceId: number,
    pdfPath: string,
    error: string,
    kind: NpcPdfKind = "thong_bao",
  ): Promise<void> {
    const c = await this.col();
    const now = new Date();
    const billKey = npcBillKey(npcIdHdon, kind);
    await c.updateOne(
      { billKey },
      {
        $set: {
          billKey,
          npcIdHdon,
          npcPdfKind: kind,
          provider: "EVN_NPC" as const,
          invoiceId,
          pdfPath,
          status: "error",
          parseError: error.slice(0, 1000),
          parseVersion: PARSER_VERSION,
          parsedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  /** Đánh dấu parse lỗi cho một bản ghi EVN HANOI (theo idHdon + loại PDF). */
  async markHanoiError(
    idHdon: string,
    invoiceId: number,
    pdfPath: string,
    error: string,
    kind: HanoiPdfKind = "tien_dien",
  ): Promise<void> {
    const c = await this.col();
    const now = new Date();
    const billKey = hanoiBillKey(idHdon, kind);
    await c.updateOne(
      { billKey },
      {
        $set: {
          billKey,
          hanoiIdHdon: idHdon,
          hanoiPdfKind: kind,
          provider: "EVN_HANOI" as const,
          invoiceId,
          pdfPath,
          status: "error",
          parseError: error.slice(0, 1000),
          parseVersion: PARSER_VERSION,
          parsedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  /** Tìm một hóa đơn theo invoiceId (CPC — ID_HDON). */
  async findById(invoiceId: number): Promise<ElectricityBill | null> {
    const c = await this.col();
    return c.findOne({
      $or: [
        { billKey: `cpc:${invoiceId}` },
        {
          invoiceId,
          $or: [
            { provider: { $ne: "EVN_NPC" as const } },
            { provider: { $exists: false } },
          ],
        },
      ],
    });
  }

  /** Một bản ghi theo `provider` + `invoiceId` — an toàn khi trùng số giữa miền (Hanoi surrogate vs CPC). */
  async findByProviderInvoiceId(
    provider: ElectricityProvider,
    invoiceId: number,
  ): Promise<ElectricityBill | null> {
    const c = await this.col();
    return c.findOne({ provider, invoiceId });
  }

  /** Tra cứu theo `billKey` (CPC/NPC). */
  async findByBillKey(billKey: string): Promise<ElectricityBill | null> {
    const c = await this.col();
    return c.findOne({ billKey });
  }

  /**
   * Tra cứu bản ghi đã parse theo id_hdon NPC.
   * `thong_bao` (mặc định): PDF thông báo — XemChiTietHoaDon_NPC.
   * `thanh_toan`: PDF hóa đơn thanh toán — XemHoaDon_NPC.
   */
  /**
   * Hóa đơn EVN_HANOI đã parse: toàn bộ kỳ trong tháng/năm (0–3 bản ghi tiền điện, mỗi kỳ một `idHdon`;
   * có thể thêm GTGT nếu đã tải — lọc `hanoiPdfKind` nếu cần).
   */
  async findHanoiParsedByCustomerMonth(
    maKhachHang: string,
    thang: number,
    nam: number,
  ): Promise<ElectricityBill[]> {
    const c = await this.col();
    return c
      .find({
        provider: "EVN_HANOI" as const,
        maKhachHang: maKhachHang.toUpperCase(),
        status: "parsed" as const,
        "kyBill.thang": thang,
        "kyBill.nam": nam,
      })
      .sort({ "kyBill.ky": 1, hanoiPdfKind: 1 })
      .toArray();
  }

  /**
   * Một bản EVN_HANOI đã parse đúng KH + kỳ/tháng/năm (API ensure-bill).
   * Mặc định: PDF tiền điện (`tien_dien` hoặc bản cũ thiếu `hanoiPdfKind`).
   */
  async findHanoiParsedByCustomerPeriod(
    maKhachHang: string,
    ky: 1 | 2 | 3,
    thang: number,
    nam: number,
    hanoiPdfKind: HanoiPdfKind | "any" = "tien_dien",
  ): Promise<ElectricityBill | null> {
    const c = await this.col();
    const maUpper = maKhachHang.trim().toUpperCase();
    const base = {
      provider: "EVN_HANOI" as const,
      maKhachHang: maUpper,
      status: "parsed" as const,
      "kyBill.ky": ky,
      "kyBill.thang": thang,
      "kyBill.nam": nam,
    };
    if (hanoiPdfKind === "any") {
      return c.findOne(base, { sort: { parsedAt: -1, updatedAt: -1 } });
    }
    if (hanoiPdfKind === "tien_dien") {
      return c.findOne(
        {
          ...base,
          $or: [{ hanoiPdfKind: { $exists: false } }, { hanoiPdfKind: "tien_dien" }],
        },
        { sort: { parsedAt: -1, updatedAt: -1 } },
      );
    }
    return c.findOne({ ...base, hanoiPdfKind: "gtgt" }, { sort: { parsedAt: -1, updatedAt: -1 } });
  }

  async findByNpcIdHdon(idHdon: string, kind: NpcPdfKind = "thong_bao"): Promise<ElectricityBill | null> {
    const c = await this.col();
    if (kind === "thanh_toan") {
      return c.findOne({ billKey: npcBillKey(idHdon, "thanh_toan") });
    }
    return c.findOne({
      $or: [
        { billKey: npcBillKey(idHdon, "thong_bao") },
        {
          npcIdHdon: idHdon,
          $or: [{ npcPdfKind: { $exists: false } }, { npcPdfKind: "thong_bao" }],
        },
      ],
    });
  }

  /**
   * Hóa đơn NPC đã parse cho đúng một KH + kỳ/tháng/năm (một bản mới nhất nếu có trùng).
   * Dùng API agent: có sẵn trong DB hay cần quét.
   * `npcPdfKind`: `thong_bao` (mặc định) = PDF thông báo; `thanh_toan` = HĐ GTGT (XemHoaDon_NPC).
   */
  async findNpcParsedByCustomerPeriod(
    maKhachHang: string,
    ky: 1 | 2 | 3,
    thang: number,
    nam: number,
    npcPdfKind: NpcPdfKind = "thong_bao",
  ): Promise<ElectricityBill | null> {
    const c = await this.col();
    const base = {
      provider: "EVN_NPC" as const,
      maKhachHang: maKhachHang.toUpperCase(),
      status: "parsed" as const,
      "kyBill.ky": ky,
      "kyBill.thang": thang,
      "kyBill.nam": nam,
    };
    if (npcPdfKind === "thanh_toan") {
      return c.findOne({ ...base, npcPdfKind: "thanh_toan" }, { sort: { parsedAt: -1, updatedAt: -1 } });
    }
    return c.findOne(
      {
        ...base,
        $or: [{ npcPdfKind: { $exists: false } }, { npcPdfKind: "thong_bao" }],
      },
      { sort: { parsedAt: -1, updatedAt: -1 } },
    );
  }

  /**
   * Tìm hóa đơn theo nhiều điều kiện.
   * Dùng cho API tra cứu từ hệ thống khác.
   */
  async find(opts: BillQueryOptions = {}): Promise<ElectricityBill[]> {
    const c = await this.col();
    const filter: Filter<ElectricityBill> = {};

    if (opts.maKhachHang) filter.maKhachHang = opts.maKhachHang;
    if (opts.maDonViQuanLy) filter.maDonViQuanLy = opts.maDonViQuanLy;
    if (opts.provider === "EVN_NPC") {
      filter.provider = "EVN_NPC";
    } else if (opts.provider === "EVN_CPC") {
      Object.assign(filter, mergeFilterWithRegion({}, "EVN_CPC"));
    } else if (opts.provider) {
      filter.provider = opts.provider;
    } else {
      const scope = opts.regionScope ?? "EVN_CPC";
      if (scope !== "all") {
        Object.assign(filter, mergeFilterWithRegion({}, scope));
      }
    }
    if (opts.ky !== undefined) filter["kyBill.ky"] = opts.ky;
    if (opts.thang !== undefined) filter["kyBill.thang"] = opts.thang;
    if (opts.nam !== undefined) filter["kyBill.nam"] = opts.nam;
    if (opts.status) filter.status = opts.status;

    if (opts.hanThanhToanBefore || opts.hanThanhToanAfter) {
      filter.hanThanhToan = {};
      if (opts.hanThanhToanBefore) filter.hanThanhToan.$lt = opts.hanThanhToanBefore;
      if (opts.hanThanhToanAfter) filter.hanThanhToan.$gte = opts.hanThanhToanAfter;
    }

    if (opts.provider === "EVN_NPC" && opts.npcPdfKind && opts.npcPdfKind !== "all") {
      if (opts.npcPdfKind === "thanh_toan") {
        filter.npcPdfKind = "thanh_toan";
      } else {
        filter.$or = [{ npcPdfKind: { $exists: false } }, { npcPdfKind: "thong_bao" }];
      }
    }

    return c
      .find(filter)
      .sort(opts.sort ?? { hanThanhToan: 1 })
      .limit(opts.limit ?? 500)
      .toArray();
  }

  /**
   * Lấy danh sách hóa đơn cần parse (chưa parse, hoặc bị lỗi, hoặc parseVersion cũ).
   * Dùng để queue parse-all-pdfs.
   */
  async findPendingParse(invoiceIds: number[]): Promise<Set<number>> {
    if (invoiceIds.length === 0) return new Set();
    const c = await this.col();
    const parsed = await c
      .find(
        { invoiceId: { $in: invoiceIds }, status: "parsed", parseVersion: PARSER_VERSION },
        { projection: { invoiceId: 1 } },
      )
      .toArray();
    const parsedSet = new Set(parsed.map((d) => d.invoiceId));
    // Trả về những ID chưa có hoặc bị lỗi hoặc cần re-parse
    return new Set(invoiceIds.filter((id) => !parsedSet.has(id)));
  }

  /** id_hdon NPC chưa parse hoặc cần re-parse (version cũ / lỗi) — chỉ bản ghi thông báo (không tính `npcPdfKind=thanh_toan`). */
  async findPendingNpcParse(idHdons: string[]): Promise<Set<string>> {
    if (idHdons.length === 0) return new Set(idHdons);
    const c = await this.col();
    const parsed = await c
      .find(
        {
          npcIdHdon: { $in: idHdons },
          status: "parsed",
          parseVersion: PARSER_VERSION,
          $or: [{ npcPdfKind: { $exists: false } }, { npcPdfKind: "thong_bao" }],
        },
        { projection: { npcIdHdon: 1 } },
      )
      .toArray();
    const done = new Set(
      parsed.map((d) => d.npcIdHdon).filter((x): x is string => typeof x === "string" && x.length > 0),
    );
    return new Set(idHdons.filter((id) => !done.has(id)));
  }

  /** Thống kê tổng tiền theo tháng/năm — dùng cho dashboard / reporting API */
  async aggregateByMonth(
    nam: number,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<{ thang: number; soHoaDon: number; tongTien: number; tongDienKwh: number }[]> {
    const c = await this.col();
    const match = mergeFilterWithRegion({ "kyBill.nam": nam, status: "parsed" }, regionScope);
    return c
      .aggregate<{ thang: number; soHoaDon: number; tongTien: number; tongDienKwh: number }>([
        { $match: match },
        {
          $group: {
            _id: "$kyBill.thang",
            soHoaDon: { $sum: 1 },
            tongTien: { $sum: "$tongKet.tongTienThanhToan" },
            tongDienKwh: { $sum: "$tongKet.tongDienNangTieuThu" },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, thang: "$_id", soHoaDon: 1, tongTien: 1, tongDienKwh: 1 } },
      ])
      .toArray();
  }

  /** Tìm hóa đơn sắp đến hạn thanh toán trong N ngày tới */
  async findDueSoon(
    withinDays: number,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<ElectricityBill[]> {
    const now = new Date();
    const until = new Date(now.getTime() + withinDays * 86_400_000);
    return this.find({
      hanThanhToanAfter: now,
      hanThanhToanBefore: until,
      status: "parsed",
      sort: { hanThanhToan: 1 },
      regionScope,
    });
  }

  // ── maKhachHang-first queries ─────────────────────────────────────────────

  /** Toàn bộ hóa đơn của 1 mã khách hàng, sắp xếp mới nhất trước */
  async findByCustomer(
    maKhachHang: string,
    opts: { thang?: number; nam?: number; ky?: 1 | 2 | 3; regionScope?: ElectricityBillRegionScope } = {},
  ): Promise<ElectricityBill[]> {
    const { regionScope = "EVN_CPC", ...rest } = opts;
    return this.find({
      maKhachHang: maKhachHang.toUpperCase(),
      ...rest,
      status: "parsed",
      sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 },
      limit: 200,
      regionScope,
    });
  }

  /** Hóa đơn mới nhất của 1 mã khách hàng */
  async findLatestByCustomer(
    maKhachHang: string,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<ElectricityBill | null> {
    const c = await this.col();
    const filter = mergeFilterWithRegion(
      { maKhachHang: maKhachHang.toUpperCase(), status: "parsed" },
      regionScope,
    );
    return c.findOne(filter, { sort: { "kyBill.nam": -1, "kyBill.thang": -1, "kyBill.ky": -1 } });
  }

  /** Hóa đơn của 1 KH đến hạn trong N ngày tới */
  async findCustomerDueSoon(
    maKhachHang: string,
    withinDays: number,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<ElectricityBill[]> {
    const now = new Date();
    const until = new Date(now.getTime() + withinDays * 86_400_000);
    return this.find({
      maKhachHang: maKhachHang.toUpperCase(),
      hanThanhToanAfter: now,
      hanThanhToanBefore: until,
      status: "parsed",
      sort: { hanThanhToan: 1 },
      regionScope,
    });
  }

  /**
   * Tất cả hóa đơn trong 1 kỳ/tháng/năm — dùng cho Excel export.
   * Trả về đầy đủ, sắp theo maKhachHang.
   */
  async findByPeriod(
    ky: 1 | 2 | 3,
    thang: number,
    nam: number,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<ElectricityBill[]> {
    const c = await this.col();
    const filter = mergeFilterWithRegion(
      { "kyBill.ky": ky, "kyBill.thang": thang, "kyBill.nam": nam, status: "parsed" },
      regionScope,
    );
    return c.find(filter).sort({ maKhachHang: 1 }).toArray();
  }

  /** Tất cả hóa đơn trong 1 tháng/năm (tất cả kỳ) — dùng cho Excel export tháng */
  async findByMonth(
    thang: number,
    nam: number,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<ElectricityBill[]> {
    const c = await this.col();
    const filter = mergeFilterWithRegion(
      { "kyBill.thang": thang, "kyBill.nam": nam, status: "parsed" },
      regionScope,
    );
    return c.find(filter).sort({ maKhachHang: 1, "kyBill.ky": 1 }).toArray();
  }

  /** Danh sách tất cả mã khách hàng unique có trong DB (theo miền) */
  async listAllCustomers(regionScope: ElectricityBillRegionScope = "EVN_CPC"): Promise<string[]> {
    const c = await this.col();
    const q = mergeFilterWithRegion({ status: "parsed" }, regionScope);
    return c.distinct("maKhachHang", q);
  }

  /** Thống kê lịch sử tiêu thụ của 1 KH theo tháng */
  async customerConsumptionHistory(
    maKhachHang: string,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<
    { nam: number; thang: number; ky: number; tongKwh: number; tongTien: number; hanThanhToan: Date }[]
  > {
    const c = await this.col();
    const match = mergeFilterWithRegion(
      { maKhachHang: maKhachHang.toUpperCase(), status: "parsed" },
      regionScope,
    );
    return c
      .aggregate<{ nam: number; thang: number; ky: number; tongKwh: number; tongTien: number; hanThanhToan: Date }>([
        { $match: match },
        {
          $project: {
            nam: "$kyBill.nam",
            thang: "$kyBill.thang",
            ky: "$kyBill.ky",
            tongKwh: "$tongKet.tongDienNangTieuThu",
            tongTien: "$tongKet.tongTienThanhToan",
            hanThanhToan: 1,
          },
        },
        { $sort: { nam: -1, thang: -1, ky: -1 } },
      ])
      .toArray();
  }

  /** Thống kê tổng kỳ theo tháng/năm — grouped by KH */
  async aggregateByPeriod(
    ky: 1 | 2 | 3,
    thang: number,
    nam: number,
    regionScope: ElectricityBillRegionScope = "EVN_CPC",
  ): Promise<{
    soKhachHang: number;
    tongTien: number;
    tongKwh: number;
    tongThue: number;
  }> {
    const c = await this.col();
    const match = mergeFilterWithRegion(
      { "kyBill.ky": ky, "kyBill.thang": thang, "kyBill.nam": nam, status: "parsed" },
      regionScope,
    );
    const [result] = await c
      .aggregate<{ soKhachHang: number; tongTien: number; tongKwh: number; tongThue: number }>([
        { $match: match },
        {
          $group: {
            _id: null,
            soKhachHang: { $sum: 1 },
            tongTien: { $sum: "$tongKet.tongTienThanhToan" },
            tongKwh: { $sum: "$tongKet.tongDienNangTieuThu" },
            tongThue: { $sum: "$tongKet.tienThueGTGT" },
          },
        },
      ])
      .toArray();
    return result ?? { soKhachHang: 0, tongTien: 0, tongKwh: 0, tongThue: 0 };
  }
}
