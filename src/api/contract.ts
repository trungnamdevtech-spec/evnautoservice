/**
 * Phiên bản hợp đồng API (số version dùng trong header / discovery).
 * File catalog OpenAPI/constraints có thể chỉ tồn tại local (thư mục docs_autocheckenv/ không push git).
 */
export const API_SERVICE_VERSION = "1.4.3" as const;
export const API_CATALOG_VERSION = "1.4.3" as const;
/** Phiên bản tài liệu ràng buộc tích hợp Agent Gateway */
export const API_CONSTRAINTS_DOC_VERSION = "1.4.3" as const;

/** Số operation trong agent-gateway-api-catalog.json (kiểm tra khi đổi catalog) */
export const API_CATALOG_OPERATIONS_COUNT = 42 as const;
export const API_AUTH_SCHEME = "apiKey" as const;
export const API_AUTH_HEADER = "x-api-key" as const;

/** Đường dẫn tài liệu trong repo (tham chiếu discovery) */
export const API_DOCS_PATHS = {
  catalogMd: "docs_autocheckenv/agent-gateway-api-catalog.md",
  catalogJson: "docs_autocheckenv/agent-gateway-api-catalog.json",
  openApiYaml: "docs_autocheckenv/openapi.yaml",
  integrationConstraints: "docs_autocheckenv/evn-autocheck-integration-constraints.md",
  /** CPC vs NPC (miền điện) — ngữ cảnh cho Agent Gateway */
  projectContext: "docs_autocheckenv/PROJECT_CONTEXT.md",
} as const;
