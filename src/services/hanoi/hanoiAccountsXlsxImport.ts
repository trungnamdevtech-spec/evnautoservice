import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { logger } from "../../core/logger.js";

export interface HanoiXlsxRow {
  username: string;
  passwordPlain: string;
  label?: string;
}

/** Khóa duy nhất: username + mật khẩu (phân biệt hoa thường). */
export function hanoiAccountDedupeKey(row: HanoiXlsxRow): string {
  return `${row.username}\0${row.passwordPlain}`;
}

/**
 * Giữ thứ tự dòng đầu tiên, bỏ các dòng trùng cùng (username, password).
 */
export function dedupeHanoiAccountRows(rows: HanoiXlsxRow[]): {
  unique: HanoiXlsxRow[];
  duplicateRowsDropped: number;
} {
  const seen = new Set<string>();
  const unique: HanoiXlsxRow[] = [];
  for (const row of rows) {
    const k = hanoiAccountDedupeKey(row);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(row);
  }
  return { unique, duplicateRowsDropped: rows.length - unique.length };
}

/**
 * Excel: số điện thoại / ô hyperlink / rich text → chuỗi hiển thị.
 */
export function excelCellToTrimmedString(cell: { value: unknown }): string {
  const v = cell.value;
  if (v == null || v === "") return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v).trim();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim();
    if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
    }
  }
  return String(v).trim();
}

/**
 * Đọc file Excel (cột A=username, B=password, C=label tùy chọn).
 * Bỏ qua dòng tiêu đề nếu A1 không phải mã khách hàng (chứa chữ "username"/"tài khoản").
 * Tự động loại trùng (username + password) — giữ bản ghi xuất hiện trước.
 */
export async function readHanoiAccountsFromXlsx(filePath: string): Promise<HanoiXlsxRow[]> {
  if (!existsSync(filePath)) {
    throw new Error(`File không tồn tại: ${filePath}`);
  }

  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const ws = wb.worksheets[0];
  if (!ws) {
    throw new Error("File Excel không có worksheet nào");
  }

  const rows: HanoiXlsxRow[] = [];
  let firstDataRow = 1;

  // Phát hiện hàng tiêu đề
  const firstCell = ws.getCell(1, 1).value;
  const firstCellStr = String(firstCell ?? "").trim().toLowerCase();
  if (
    firstCellStr === "" ||
    /username|tài khoản|tên đăng nhập|account|stt|no\.|#/i.test(firstCellStr)
  ) {
    firstDataRow = 2;
  }

  ws.eachRow((row, rowNumber) => {
    if (rowNumber < firstDataRow) return;
    const username = excelCellToTrimmedString(row.getCell(1));
    const passwordPlain = excelCellToTrimmedString(row.getCell(2));
    const labelCell = excelCellToTrimmedString(row.getCell(3));
    const label = labelCell || undefined;

    if (!username || !passwordPlain) return;
    rows.push({ username, passwordPlain, label });
  });

  const { unique, duplicateRowsDropped } = dedupeHanoiAccountRows(rows);
  if (duplicateRowsDropped > 0) {
    logger.info(
      `[hanoi-xlsx] Đã lọc ${duplicateRowsDropped} dòng trùng (cùng username+password), còn ${unique.length} dòng duy nhất.`,
    );
  }

  return unique;
}

/**
 * Đọc file danh sách tài khoản plain text (mỗi dòng: username|password hoặc username password).
 * Dự phòng khi không có file Excel.
 */
export async function readHanoiAccountsFromText(filePath: string): Promise<HanoiXlsxRow[]> {
  const content = await readFile(filePath, "utf-8");
  const rows: HanoiXlsxRow[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.includes("|") ? trimmed.split("|") : trimmed.split(/\s+/);
    const username = (parts[0] ?? "").trim();
    const passwordPlain = (parts[1] ?? "").trim();
    const label = (parts[2] ?? "").trim() || undefined;
    if (!username || !passwordPlain) continue;
    rows.push({ username, passwordPlain, label });
  }
  const { unique, duplicateRowsDropped } = dedupeHanoiAccountRows(rows);
  if (duplicateRowsDropped > 0) {
    logger.info(
      `[hanoi-txt] Đã lọc ${duplicateRowsDropped} dòng trùng (username+password), còn ${unique.length} dòng.`,
    );
  }
  return unique;
}
