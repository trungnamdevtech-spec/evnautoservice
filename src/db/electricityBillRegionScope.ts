import type { Filter } from "mongodb";
import type { ElectricityBill } from "../types/electricityBill.js";

/**
 * Phạm vi miền điện khi truy vấn `electricity_bills` (tránh trộn CPC / NPC).
 * - EVN_CPC: CPC + bản ghi cũ không có `provider` (coi là CPC).
 * - EVN_NPC: chỉ Điện lực miền Bắc (NPC).
 * - all: không lọc miền — chỉ dùng khi cần thống kê toàn hệ thống (rõ ràng).
 */
export type ElectricityBillRegionScope = "EVN_CPC" | "EVN_NPC" | "all";

const CPC_OR_LEGACY: Filter<ElectricityBill> = {
  $or: [{ provider: "EVN_CPC" as const }, { provider: { $exists: false } }],
};

/** Lọc Mongo theo miền (đặt trong $and cùng các điều kiện khác). */
export function regionScopeToFilter(scope: ElectricityBillRegionScope): Filter<ElectricityBill> {
  if (scope === "all") return {};
  if (scope === "EVN_NPC") return { provider: "EVN_NPC" as const };
  return CPC_OR_LEGACY;
}

/**
 * Query string: region hoặc provider — EVN_CPC | EVN_NPC | all (mặc định EVN_CPC).
 */
export function parseRegionScopeFromQuery(
  region: string | undefined,
  provider: string | undefined,
): ElectricityBillRegionScope {
  // Dùng || thay vì ?? để `region=` rỗng vẫn đọc được `provider=`
  const raw = (region?.trim() || provider?.trim() || "EVN_CPC").toUpperCase();
  if (raw === "EVN_NPC" || raw === "NPC") return "EVN_NPC";
  if (raw === "ALL" || raw === "MIXED" || raw === "*") return "all";
  return "EVN_CPC";
}

export function mergeFilterWithRegion(
  base: Filter<ElectricityBill>,
  scope: ElectricityBillRegionScope,
): Filter<ElectricityBill> {
  const rf = regionScopeToFilter(scope);
  if (Object.keys(rf).length === 0) return base;
  const entries = Object.keys(base);
  if (entries.length === 0) return rf;
  return { $and: [base, rf] };
}
