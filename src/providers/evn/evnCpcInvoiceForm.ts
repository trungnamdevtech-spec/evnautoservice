import type { Locator, Page } from "playwright";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameCandidatesFor(value: string): string[] {
  const out: string[] = [value];
  const n = Number.parseInt(value, 10);
  if (!Number.isNaN(n) && String(n) !== value) {
    out.push(String(n));
  }
  if (value.length === 2 && value.startsWith("0")) {
    out.push(String(Number.parseInt(value, 10)));
  }
  return [...new Set(out)];
}

/** Chỉ dùng cho Ant Design Select (không phải react-select CPC). */
async function waitForOpenSelectMenu(page: Page, timeoutMs: number): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  const tryLocators = [
    () => page.locator('[id*="listbox"]').last(),
    () => page.locator('[role="listbox"]').last(),
    () => page.locator("div.react-select__menu").last(),
    () =>
      page
        .locator("div[class*='menu']")
        .filter({ has: page.locator('[role="option"]') })
        .last(),
  ];

  while (Date.now() < deadline) {
    for (const getLoc of tryLocators) {
      const loc = getLoc();
      try {
        await loc.waitFor({ state: "visible", timeout: 400 });
        return loc;
      } catch {
        /* next */
      }
    }
    await sleep(80);
  }

  throw new Error("Không thấy menu Ant/react menu");
}

async function selectOptionInOpenMenu(
  page: Page,
  menu: Locator,
  value: string,
  stepTimeoutMs: number,
): Promise<void> {
  const names = nameCandidatesFor(value);

  const tryAntInside = async (): Promise<boolean> => {
    const opts = menu.locator(".ant-select-item-option, .ant-select-item[role='option']");
    for (const name of names) {
      const byText = opts.filter({ hasText: new RegExp(`^\\s*${escapeRe(name)}\\s*$`) });
      if ((await byText.count()) > 0) {
        await byText.first().click({ timeout: stepTimeoutMs });
        return true;
      }
    }
    for (const name of names) {
      const byPartial = opts.filter({ hasText: name });
      if ((await byPartial.count()) === 1) {
        await byPartial.first().click({ timeout: stepTimeoutMs });
        return true;
      }
    }
    return false;
  };

  if (await tryAntInside()) return;

  for (const name of names) {
    const opt = menu.getByRole("option", { name, exact: true });
    if ((await opt.count()) > 0) {
      await opt.first().click({ timeout: stepTimeoutMs });
      return;
    }
  }

  for (const name of names) {
    const loose = menu.locator('[role="option"]').filter({ hasText: new RegExp(`^\\s*${escapeRe(name)}\\s*$`) });
    if ((await loose.count()) > 0) {
      await loose.first().click({ timeout: stepTimeoutMs });
      return;
    }
  }

  await menu
    .locator('[role="option"]')
    .filter({ hasText: new RegExp(`^\\s*${escapeRe(value)}\\s*$`) })
    .first()
    .click({ timeout: stepTimeoutMs });
}

async function selectOptionInOpenListbox(page: Page, value: string, stepTimeoutMs: number): Promise<void> {
  const menu = await waitForOpenSelectMenu(page, Math.min(stepTimeoutMs, 12_000));
  await selectOptionInOpenMenu(page, menu, value, stepTimeoutMs);
}

export async function setInvoiceKyThangNamViaHiddenInputs(
  page: Page,
  formSelector: string,
  values: { period: string; month: string; year: string },
): Promise<void> {
  // Tránh `page.evaluate` (đang gặp lỗi runtime `__name is not defined` trong môi trường desktop),
  // thay bằng thao tác trực tiếp qua Playwright locator.
  const form = page.locator(formSelector).first();

  // Một số page có thể render nhiều node trùng name; ưu tiên node cuối cùng
  // (thường là node state thật được submit).
  const periodEl = form.locator('input[name="period"]').last();
  const monthEl = form.locator('input[name="month"]').last();
  const yearEl = form.locator('input[name="year"]').last();

  // Một số form có thể render chậm, nên đợi attached trước khi fill.
  await Promise.all([
    periodEl.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined),
    monthEl.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined),
    yearEl.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined),
  ]);

  if ((await periodEl.count()) > 0) await periodEl.fill(values.period, { force: true }).catch(() => undefined);
  if ((await monthEl.count()) > 0) await monthEl.fill(values.month, { force: true }).catch(() => undefined);
  if ((await yearEl.count()) > 0) await yearEl.fill(values.year, { force: true }).catch(() => undefined);

  // Trigger change events để framework đọc lại state.
  await Promise.all([
    periodEl.dispatchEvent("change").catch(() => undefined),
    monthEl.dispatchEvent("change").catch(() => undefined),
    yearEl.dispatchEvent("change").catch(() => undefined),
  ]);
}

/**
 * CPC: react-select — click mở menu, gõ để filter, rồi click TRỰC TIẾP vào option khớp.
 * Không dùng Enter vì Enter đóng menu mà không đảm bảo chọn đúng option.
 * Không dùng Tab vì Tab nhảy focus khắp trang → cuộn lên xuống liên tục.
 */
export async function setInvoiceKyThangNamViaReactSelect(
  page: Page,
  formSelector: string,
  values: { period: string; month: string; year: string },
  stepTimeoutMs: number,
): Promise<void> {
  const form = page.locator(formSelector);
  await form.waitFor({ state: "visible", timeout: stepTimeoutMs });
  await form.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
  await sleep(80);

  const seq = [values.period, values.month, values.year] as const;

  for (let i = 0; i < seq.length; i++) {
    const value = seq[i];
    const name = i === 0 ? "period" : i === 1 ? "month" : "year";
    const wrapper = form.locator(`div.input-select:has(input[name="${name}"])`);
    await wrapper.waitFor({ state: "visible", timeout: stepTimeoutMs });

    const input = wrapper.locator('input[id^="react-select"]').first();
    await input.click({ timeout: stepTimeoutMs, force: true });
    await sleep(120);
    // Dựa theo id thực tế bạn cung cấp:
    // input id: react-select-6-input => option id: react-select-6-option-*
    // Cách này ổn định hơn class/menu vì portal mount/unmount liên tục.
    const inputId = (await input.getAttribute("id")) ?? "";
    const idPrefix = inputId.replace(/-input$/, "");
    const valueNum = String(Number.parseInt(value, 10)); // "02" -> "2"
    const wanted = Number.isNaN(Number.parseInt(value, 10)) ? value : valueNum;

    if (!idPrefix.startsWith("react-select-")) {
      throw new Error(`[form] react-select field "${name}": input id không hợp lệ: "${inputId}"`);
    }

    const optionsById = page.locator(`div[id^="${idPrefix}-option-"]:visible`);
    await optionsById.first().waitFor({ state: "visible", timeout: 3000 });

    const exactByText = optionsById.filter({ hasText: new RegExp(`^\\s*${escapeRe(wanted)}\\s*$`) }).first();
    if ((await exactByText.count()) === 0) {
      throw new Error(
        `[form] react-select field "${name}": không tìm thấy option text="${wanted}" cho prefix "${idPrefix}"`,
      );
    }
    await exactByText.click({ timeout: stepTimeoutMs });

    await sleep(150);
  }
}

export async function setInvoiceKyThangNamViaAntSelect(
  page: Page,
  formSelector: string,
  values: { period: string; month: string; year: string },
  stepTimeoutMs: number,
): Promise<void> {
  const form = page.locator(formSelector);
  const selects = form.locator(".ant-select");
  const count = await selects.count();
  if (count < 3) {
    throw new Error(`Form không có đủ 3 Ant Select (tìm thấy ${count})`);
  }

  const vals = [values.period, values.month, values.year] as const;

  for (let i = 0; i < 3; i++) {
    const val = vals[i];
    await selects.nth(i).click({ timeout: stepTimeoutMs });
    await sleep(350);
    await selectOptionInOpenListbox(page, val, stepTimeoutMs);
    await sleep(200);
    
  }
}
