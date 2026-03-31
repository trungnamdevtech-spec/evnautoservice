/**
 * Giải mã file JSON export từ MongoDB (mảng các object có username + passwordEncrypted).
 *
 * Xuất trên server (chỉ ciphertext):
 *   docker compose exec mongo mongosh evn_scraper --quiet --eval "JSON.stringify(db.npc_accounts.find({}, { username: 1, passwordEncrypted: 1, _id: 0 }).toArray())" > npc-encrypted.json
 *
 * Trên máy dev (có .env với NPC_CREDENTIALS_SECRET đúng với lúc mã hóa):
 *   node --import tsx src/scripts/decrypt-npc-export-from-json.ts npc-encrypted.json
 *   node --import tsx src/scripts/decrypt-npc-export-from-json.ts npc-encrypted.json --tsv > passwords.tsv
 *   node --import tsx src/scripts/decrypt-npc-export-from-json.ts npc-encrypted.json --xlsx npc-decrypted.xlsx
 *
 * Không commit file chứa mật khẩu rõ.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { decryptNpcPassword } from "../services/crypto/npcCredentials.js";

const secretRaw = process.env.NPC_CREDENTIALS_SECRET?.trim();
if (!secretRaw) {
  console.error("[decrypt-npc-export] Thiếu NPC_CREDENTIALS_SECRET trong môi trường hoặc .env");
  process.exit(1);
}
const secret = secretRaw;

const argv = process.argv.slice(2);
const tsv = argv.includes("--tsv");
const xlsx = argv.includes("--xlsx");
const positional = argv.filter((a) => a !== "--tsv" && a !== "--xlsx");
const inputPath = positional[0];
/** Khi --xlsx: đối số thứ 2 là đường dẫn .xlsx (tuỳ chọn) */
const xlsxOutPath =
  xlsx && positional[1] && positional[1].toLowerCase().endsWith(".xlsx")
    ? positional[1]
    : xlsx && inputPath
      ? inputPath.replace(/\.json$/i, "-decrypted.xlsx")
      : undefined;

if (!inputPath) {
  console.error(
    "Usage: node --import tsx src/scripts/decrypt-npc-export-from-json.ts <export.json> [--tsv | --xlsx [output.xlsx]]",
  );
  process.exit(1);
}

const raw = readFileSync(inputPath, "utf8");
let rows: Array<{ username?: string; passwordEncrypted?: string }>;
try {
  rows = JSON.parse(raw) as Array<{ username?: string; passwordEncrypted?: string }>;
} catch (e) {
  console.error("[decrypt-npc-export] JSON không hợp lệ — kiểm tra file đủ dấu ] và dấu ngoặc.");
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error("[decrypt-npc-export] File JSON phải là mảng [...]");
  process.exit(1);
}

type DecryptedRow = { username: string; password: string | null; error?: string };

function decryptAll(): DecryptedRow[] {
  const out: DecryptedRow[] = [];
  for (const r of rows) {
    const u = r.username ?? "";
    const enc = r.passwordEncrypted ?? "";
    if (!enc) {
      out.push({ username: u, password: null, error: "empty_encrypted" });
      continue;
    }
    try {
      out.push({ username: u, password: decryptNpcPassword(enc, secret) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ username: u, password: null, error: msg });
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (xlsx && xlsxOutPath) {
    const decrypted = decryptAll();
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("accounts", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = [
      { header: "username", key: "u", width: 22 },
      { header: "password", key: "p", width: 40 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of decrypted) {
      sheet.addRow({
        u: row.username,
        p: row.password ?? (row.error ? `[LỖI: ${row.error}]` : ""),
      });
    }
    await wb.xlsx.writeFile(xlsxOutPath);
    console.info(`[decrypt-npc-export] Đã ghi ${decrypted.length} dòng → ${xlsxOutPath}`);
    return;
  }

  if (tsv) {
    console.log("username\tpassword");
  }
  for (const r of decryptAll()) {
    if (tsv) {
      console.log(`${r.username}\t${r.password ?? (r.error ? `[DECRYPT_ERROR: ${r.error}]` : "")}`);
    } else {
      console.log(JSON.stringify(r));
    }
  }
}

main().catch((err) => {
  console.error("[decrypt-npc-export]", err);
  process.exit(1);
});
