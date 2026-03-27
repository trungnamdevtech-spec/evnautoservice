/**
 * Chạy trong Dockerfile sau `npm ci --omit=dev` để fail build sớm nếu thiếu module runtime.
 * Không phụ thuộc devDependencies.
 */
await Promise.all([
  import("archiver"),
  import("hono"),
  import("mongodb"),
  import("@hono/node-server"),
  import("exceljs"),
  import("pdf-parse"),
  import("playwright"),
  import("playwright-extra"),
]);
console.log("[docker] runtime deps ok");
