/**
 * Với mỗi file PDF trong output/pdfs/npc: parse lại từ file, lấy bản ghi DB theo id_hdon,
 * so sánh snapshot dữ liệu (bỏ metadata) để xác nhận DB khớp nội dung PDF.
 *
 * Usage:
 *   node --import tsx src/scripts/verify-npc-pdfs-vs-db.ts
 */

import "dotenv/config";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { getMongoDb, closeMongo } from "../db/mongo.js";
import { ElectricityBillRepository } from "../db/electricityBillRepository.js";
import { parseElectricityBillPdf } from "../services/pdf/ElectricityBillParser.js";
import { npcInvoiceIdSurrogateFromIdHdon } from "../services/npc/npcElectricityBillId.js";
import { parseNpcPdfFilename } from "../services/npc/npcPdfFilename.js";
import { env } from "../config/env.js";
import type { ElectricityBill } from "../types/electricityBill.js";

async function collectPdfFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await collectPdfFiles(full)));
      } else if (entry.name.endsWith(".pdf")) {
        results.push(full);
      }
    }
  } catch {
    // thư mục không tồn tại
  }
  return results;
}

/** Chuẩn hóa ngày (UTC date-only) để so khớp Mongo ↔ parse mới */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Snapshot chỉ các trường kinh doanh — không gồm pdfPath, createdAt, parsedAt, … */
function dataSnapshot(b: ElectricityBill): Record<string, unknown> {
  return {
    billKey: b.billKey ?? null,
    provider: b.provider ?? null,
    npcIdHdon: b.npcIdHdon ?? null,
    invoiceId: b.invoiceId,
    maKhachHang: b.maKhachHang.toUpperCase(),
    maDonViQuanLy: b.maDonViQuanLy,
    kyBill: {
      ky: b.kyBill.ky,
      thang: b.kyBill.thang,
      nam: b.kyBill.nam,
      soDays: b.kyBill.soDays,
      ngayBatDau: dayKey(b.kyBill.ngayBatDau),
      ngayKetThuc: dayKey(b.kyBill.ngayKetThuc),
    },
    donViDien: {
      maSoThue: b.donViDien.maSoThue,
      dienThoai: b.donViDien.dienThoai,
    },
    khachHang: {
      dienThoai: b.khachHang.dienThoai.trim(),
      maSoThue: b.khachHang.maSoThue.trim(),
    },
    congTo: b.congTo,
    chiSoDien: b.chiSoDien,
    giaDien: b.giaDien,
    tongKet: {
      tongDienNangTieuThu: b.tongKet.tongDienNangTieuThu,
      tongTienDienChuaThue: b.tongKet.tongTienDienChuaThue,
      thueSuatGTGT: b.tongKet.thueSuatGTGT,
      tienThueGTGT: b.tongKet.tienThueGTGT,
      tongTienThanhToan: b.tongKet.tongTienThanhToan,
      bangChu: b.tongKet.bangChu.replace(/\s+/g, " ").trim(),
    },
    hanThanhToan: dayKey(b.hanThanhToan),
    soHoaDon: {
      ngayKy: dayKey(b.soHoaDon.ngayKy),
    },
    status: b.status,
    parseVersion: b.parseVersion,
  };
}

function diffSnapshots(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  prefix = "",
): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const va = a[k];
    const vb = b[k];
    if (va === undefined && vb === undefined) continue;
    if (va === undefined) {
      out.push(`${path}: thiếu ở PDF-parse`);
      continue;
    }
    if (vb === undefined) {
      out.push(`${path}: thiếu ở DB`);
      continue;
    }
    const aObj = typeof va === "object" && va !== null && !Array.isArray(va);
    const bObj = typeof vb === "object" && vb !== null && !Array.isArray(vb);
    if (aObj && bObj) {
      out.push(...diffSnapshots(va as Record<string, unknown>, vb as Record<string, unknown>, path));
    } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
      out.push(`${path}: PDF="${JSON.stringify(va)}" DB="${JSON.stringify(vb)}"`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  await getMongoDb();
  const billRepo = new ElectricityBillRepository();
  const npcDir = path.join(env.pdfOutputDir, "npc");
  const files = await collectPdfFiles(npcDir);
  console.info(`[verify-npc] Thư mục: ${path.resolve(npcDir)}`);
  console.info(`[verify-npc] Số file PDF: ${files.length}`);

  let ok = 0;
  let fail = 0;
  let skip = 0;

  for (const filePath of files) {
    const meta = parseNpcPdfFilename(filePath);
    if (!meta) {
      console.warn(`[verify-npc] Bỏ qua — tên file không đúng pattern: ${filePath}`);
      skip++;
      continue;
    }

    const invSurrogate = npcInvoiceIdSurrogateFromIdHdon(meta.idHdon);
    const kyNum = parseInt(meta.ky, 10);
    const kyTrongKy = (kyNum >= 1 && kyNum <= 3 ? kyNum : 1) as 1 | 2 | 3;
    const fresh = await parseElectricityBillPdf(
      filePath,
      invSurrogate,
      meta.maKh.toUpperCase(),
      "NPC",
      {
        maSogcs: "",
        kyHieu: "",
        soSery: "",
        ngayPhatHanh: new Date(),
      },
      { npc: { npcIdHdon: meta.idHdon, kyTrongKy } },
    );

    if (!fresh.success || !fresh.bill) {
      console.warn(`[verify-npc] ✗ Parse PDF lỗi ${meta.idHdon.slice(0, 12)}… — ${fresh.error}`);
      fail++;
      continue;
    }

    const dbBill = await billRepo.findByNpcIdHdon(meta.idHdon);
    if (!dbBill) {
      console.warn(`[verify-npc] ✗ Không có bản ghi DB cho id_hdon=${meta.idHdon.slice(0, 20)}…`);
      fail++;
      continue;
    }

    if (dbBill.status !== "parsed") {
      console.warn(
        `[verify-npc] ✗ DB status=${dbBill.status} (parseError=${dbBill.parseError?.slice(0, 80) ?? "—"})`,
      );
      fail++;
      continue;
    }

    const sPdf = dataSnapshot(fresh.bill);
    const sDb = dataSnapshot(dbBill);
    const diffs = diffSnapshots(sPdf, sDb);

    if (diffs.length > 0) {
      console.warn(`[verify-npc] ✗ Lệch DB ↔ PDF: ${path.basename(filePath)}`);
      for (const d of diffs) console.warn(`         ${d}`);
      fail++;
    } else {
      console.info(`[verify-npc] ✓ ${path.basename(filePath)} — ${meta.maKh} kỳ ${fresh.bill.kyBill.ky}/${fresh.bill.kyBill.thang}/${fresh.bill.kyBill.nam}`);
      ok++;
    }
  }

  console.info(`\n[verify-npc] Kết quả: ${ok} khớp | ${fail} lệch/lỗi | ${skip} bỏ qua`);
  await closeMongo();
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[verify-npc] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
