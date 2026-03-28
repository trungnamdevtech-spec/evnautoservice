import type { ElectricityBillRegionScope } from "../db/electricityBillRegionScope.js";
import { parseRegionScopeFromQuery } from "../db/electricityBillRegionScope.js";

/** Đọc `region` hoặc `provider` từ query — mặc định EVN_CPC (không trộn NPC). */
export function getRegionFromQuery(c: { req: { query: (name: string) => string | undefined } }): ElectricityBillRegionScope {
  return parseRegionScopeFromQuery(c.req.query("region"), c.req.query("provider"));
}
