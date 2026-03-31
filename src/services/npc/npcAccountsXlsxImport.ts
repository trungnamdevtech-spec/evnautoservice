/**
 * Đọc file .xlsx (cột A: username, B: password) và ghi vào npc_accounts qua NpcAccountRepository.
 * Dùng chung cho script CLI và (tuỳ chọn) import khi khởi động app.
 */

import path from "node:path";
import ExcelJS from "exceljs";
import { NpcAccountRepository } from "../../db/npcAccountRepository.js";
import type { TaskRepository } from "../../db/taskRepository.js";

/** Giá trị ô: số, chuỗi, rich text — đưa về chuỗi trim. */
export function cellToTrimmedString(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && v !== null && "richText" in v && Array.isArray((v as ExcelJS.CellRichTextValue).richText)) {
    return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("").trim();
  }
  if (typeof v === "object" && v !== null && "formula" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    return r == null ? "" : String(r).trim();
  }
  return String(v).trim();
}

function looksLikeHeaderRow(username: string, password: string): boolean {
  const u = username.toLowerCase();
  const p = password.toLowerCase();
  const headerHints = ["user", "username", "tk", "mã", "login", "tài khoản"];
  const passHints = ["pass", "password", "mk", "mật khẩu", "pwd"];
  const uLooks = headerHints.some((h) => u.includes(h));
  const pLooks = passHints.some((h) => p.includes(h));
  return uLooks && pLooks && username.length < 40;
}

export interface NpcXlsxParseResult {
  rows: Array<{ username: string; passwordPlain: string }>;
  sheetName: string;
  skippedEmpty: number;
  skippedNoUser: number;
  skippedNoPass: number;
  skippedHeader: number;
  lastRowNumber: number;
}

/**
 * Đọc file .xlsx, trả về danh sách dòng hợp lệ (chưa ghi DB).
 */
export async function parseNpcAccountsXlsx(absPath: string, sheetName?: string): Promise<NpcXlsxParseResult> {
  const abs = path.resolve(absPath);
  if (!/\.xlsx$/i.test(abs)) {
    throw new Error("Chỉ hỗ trợ .xlsx (Excel 2007+).");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(abs);

  let sheet: ExcelJS.Worksheet | undefined;
  if (sheetName) {
    sheet = workbook.getWorksheet(sheetName);
    if (!sheet) throw new Error(`Không tìm thấy sheet: ${sheetName}`);
  } else {
    sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("Workbook không có sheet nào.");
  }

  const rows: Array<{ username: string; passwordPlain: string }> = [];
  let skippedEmpty = 0;
  let skippedNoUser = 0;
  let skippedNoPass = 0;
  let skippedHeader = 0;
  let lastRowNumber = 0;

  sheet.eachRow((row, rowNumber) => {
    lastRowNumber = rowNumber;
    const username = cellToTrimmedString(row.getCell(1));
    const pw = cellToTrimmedString(row.getCell(2));

    if (!username && !pw) {
      skippedEmpty++;
      return;
    }
    if (!username && pw) {
      skippedNoUser++;
      return;
    }
    if (username && !pw) {
      skippedNoPass++;
      return;
    }

    if (rowNumber === 1 && looksLikeHeaderRow(username, pw)) {
      skippedHeader++;
      return;
    }

    rows.push({ username, passwordPlain: pw });
  });

  return {
    rows,
    sheetName: sheet.name,
    skippedEmpty,
    skippedNoUser,
    skippedNoPass,
    skippedHeader,
    lastRowNumber,
  };
}

export interface NpcXlsxImportDbResult {
  inserted: number;
  skipped: number;
  errors: string[];
  parse: NpcXlsxParseResult;
}

/**
 * Parse + insert vào MongoDB (mật khẩu mã hóa trong repository).
 */
export async function importNpcAccountsFromXlsxFile(
  repo: InstanceType<typeof NpcAccountRepository>,
  absPath: string,
  sheetName?: string,
): Promise<NpcXlsxImportDbResult> {
  const parse = await parseNpcAccountsXlsx(absPath, sheetName);
  if (parse.rows.length === 0) {
    return { inserted: 0, skipped: 0, errors: ["Không có dòng dữ liệu hợp lệ"], parse };
  }
  const result = await repo.insertManyAccounts(parse.rows);
  return {
    inserted: result.inserted,
    skipped: result.skipped,
    errors: result.errors,
    parse,
  };
}

export interface ReplaceNpcAccountsFromXlsxResult extends NpcXlsxImportDbResult {
  /** Số bản ghi đã xóa trước khi nạp lại */
  deleted: number;
  /** Số task EVN_NPC đã xóa (khi bật wipeNpcTasks) */
  npcTasksDeleted?: number;
}

/**
 * Thay thế toàn bộ tài khoản NPC: đọc Excel trước — **chỉ khi có ít nhất một dòng hợp lệ**
 * mới xóa hết collection rồi insert (tránh DB trống vì file sai).
 * `wipeNpcTasks`: sau khi parse OK, xóa mọi `scrape_tasks` provider EVN_NPC (tránh task cũ sau khi đổi id tài khoản).
 */
export async function replaceAllNpcAccountsFromXlsxFile(
  repo: InstanceType<typeof NpcAccountRepository>,
  absPath: string,
  sheetName?: string,
  opts?: { wipeNpcTasks?: boolean; taskRepo?: InstanceType<typeof TaskRepository> },
): Promise<ReplaceNpcAccountsFromXlsxResult> {
  const parse = await parseNpcAccountsXlsx(absPath, sheetName);
  if (parse.rows.length === 0) {
    throw new Error(
      "Không có dòng dữ liệu hợp lệ trong Excel — không thực hiện xóa (tránh làm trống DB).",
    );
  }

  let npcTasksDeleted: number | undefined;
  if (opts?.wipeNpcTasks && opts.taskRepo) {
    npcTasksDeleted = await opts.taskRepo.deleteAllByProvider("EVN_NPC");
  }

  const deleted = await repo.deleteAll();
  const result = await repo.insertManyAccounts(parse.rows);
  return {
    deleted,
    npcTasksDeleted,
    inserted: result.inserted,
    skipped: result.skipped,
    errors: result.errors,
    parse,
  };
}
