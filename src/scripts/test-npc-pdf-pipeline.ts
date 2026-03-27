/**
 * Kiểm tra nhanh: đăng nhập NPC → TraCuuHDSPC (ky, thang, nam) → parse billData
 * → XemChiTietHoaDon_NPC → nếu PDF thì lưu vào output/pdfs/npc/.
 *
 * Usage:
 *   npm run test:npc-pdf-pipeline
 *   npm run test:npc-pdf-pipeline -- --ky=2 --month=03 --year=2026 --limit=2
 *
 * Cần ANTICAPTCHA_API_KEY. Tài khoản dev giống test-npc-login (chỉ local).
 */
import "dotenv/config";
import { env } from "../config/env.js";
import { fetchNpcTraCuuHdsPc } from "../services/npc/NpcTraCuuHDSPCClient.js";
import { parseNpcBillDataFromTraCuuBody } from "../services/npc/parseNpcBillData.js";
import { postNpcXemChiTietHoaDon } from "../services/npc/NpcXemChiTietHoaDonClient.js";
import { saveNpcInvoicePdf } from "../services/npc/saveNpcInvoicePdf.js";

const STEP_MS = 90_000;

const TEST_USERNAME = "PA25VY0071988";
const TEST_PASSWORD = "Vanhanh@123";

function parseArgs(): { ky: string; month: string; year: string; limit: number } {
  const now = new Date();
  let ky = "1";
  let month = String(now.getMonth() + 1).padStart(2, "0");
  let year = String(now.getFullYear());
  let limit = 5;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--ky=")) ky = a.slice(5);
    else if (a.startsWith("--month=")) month = a.slice(8).padStart(2, "0");
    else if (a.startsWith("--year=")) year = a.slice(7);
    else if (a.startsWith("--limit=")) limit = Math.max(1, Number.parseInt(a.slice(8), 10) || 5);
  }
  return { ky, month, year, limit };
}

async function main(): Promise<void> {
  const { ky, month, year, limit } = parseArgs();
  const thangNum = Number.parseInt(month, 10);

  const { runWithTimeout } = await import("../core/stepTimeout.js");
  const { AnticaptchaClient } = await import("../services/captcha/AnticaptchaClient.js");
  const { BaseWorker } = await import("../core/BaseWorker.js");
  const { isStillOnNpcLoginPage, loginNpcInteractive } = await import("../providers/npc/npcLogin.js");

  const runStep = <T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> =>
    runWithTimeout(name, timeoutMs, fn);

  class TestNPCWorker extends BaseWorker {
    async testLogin(page: import("playwright").Page): Promise<void> {
      await loginNpcInteractive(
        page,
        TEST_USERNAME,
        TEST_PASSWORD,
        runStep,
        STEP_MS,
        (opts) => this.handleCaptchaWithRetry(opts),
      );
    }
  }

  const worker = new TestNPCWorker(new AnticaptchaClient());
  console.info("[npc-pdf-pipeline] Browser…");
  await worker.beginBrowserSession();
  const context = await worker.createDisposableContext();
  const page = await context.newPage();

  try {
    console.info(`[npc-pdf-pipeline] Login → ${env.evnNpcLoginUrl}`);
    await worker.testLogin(page);
    if (!page.url().toLowerCase().includes("indexnpc") || (await isStillOnNpcLoginPage(page))) {
      throw new Error("Chưa tới IndexNPC sau login.");
    }
    console.info("[npc-pdf-pipeline] ✓ IndexNPC");

    console.info(`[npc-pdf-pipeline] TraCuuHDSPC ky=${ky} thang=${thangNum} nam=${year}`);
    const tra = await fetchNpcTraCuuHdsPc(page, { ky, thang: thangNum, nam: year });
    console.info(`[npc-pdf-pipeline] TraCuu HTTP ${tra.status} len=${tra.body.length}`);
    if (tra.status >= 400) {
      throw new Error(`TraCuuHDSPC lỗi HTTP ${tra.status}`);
    }

    const bills = parseNpcBillDataFromTraCuuBody(tra.body);
    console.info(`[npc-pdf-pipeline] billData: ${bills.length} hóa đơn`);
    if (bills.length === 0) {
      console.warn("[npc-pdf-pipeline] Không có bill — thử kỳ/tháng/năm khác.");
      return;
    }

    let pdfOk = 0;
    let htmlOnly = 0;
    let n = 0;
    for (const bill of bills) {
      if (n >= limit) break;
      const idHdon = bill.id_hdon?.trim();
      if (!idHdon) continue;
      const maKh = (bill.customer_code ?? TEST_USERNAME).trim();
      n++;

      const detail = await postNpcXemChiTietHoaDon(page, {
        idHdon,
        maKh,
        ky,
        thang: thangNum,
        nam: year,
      });
      console.info(
        `[npc-pdf-pipeline] XemChiTiet #${n} id_hdon=${idHdon.slice(0, 20)}… HTTP ${detail.status} kind=${detail.kind}`,
      );

      if (detail.kind === "pdf") {
        const fp = await saveNpcInvoicePdf(detail.buffer, maKh, year, month, ky, idHdon);
        console.info(`[npc-pdf-pipeline] ✓ PDF → ${fp} (${detail.buffer.length} bytes)`);
        pdfOk++;
      } else {
        htmlOnly++;
        const prev = detail.body.slice(0, 200).replace(/\s+/g, " ");
        console.warn(`[npc-pdf-pipeline] HTML/text preview: ${prev}…`);
      }
    }

    console.info(`[npc-pdf-pipeline] Kết quả: pdf=${pdfOk} html/text=${htmlOnly} (đã xử lý tối đa ${limit} bill)`);
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await worker.endBrowserSession();
  }
}

main().catch((err) => {
  console.error("[npc-pdf-pipeline]", err instanceof Error ? err.message : err);
  process.exit(1);
});
