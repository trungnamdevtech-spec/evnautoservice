import type { Page } from "playwright";
import {
  postNpcHoaDonNpcForm,
  type NpcHoaDonFormParams,
  type NpcHoaDonFormResult,
} from "./npcHoaDonNpcFormPost.js";

/** @deprecated Dùng NpcHoaDonFormParams */
export type NpcXemChiTietHoaDonParams = NpcHoaDonFormParams;
export type NpcXemChiTietHoaDonResult = NpcHoaDonFormResult;

/**
 * POST `/HoaDon/XemChiTietHoaDon_NPC` — PDF thông báo tiền điện (thông báo hóa đơn).
 */
export async function postNpcXemChiTietHoaDon(
  page: Page,
  params: NpcHoaDonFormParams,
): Promise<NpcHoaDonFormResult> {
  return postNpcHoaDonNpcForm(page, "XemChiTietHoaDon_NPC", params);
}

/**
 * POST `/HoaDon/XemHoaDon_NPC` — PDF hóa đơn thanh toán (cùng tham số form với XemChiTiet).
 */
export async function postNpcXemHoaDonNpc(page: Page, params: NpcHoaDonFormParams): Promise<NpcHoaDonFormResult> {
  return postNpcHoaDonNpcForm(page, "XemHoaDon_NPC", params);
}
