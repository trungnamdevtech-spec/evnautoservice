/**
 * Tránh tải browser trong Docker build (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
 * Runtime image dùng mcr.microsoft.com/playwright — browser có sẵn.
 */
if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") {
  console.log("[postinstall] bỏ qua playwright install (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)");
  process.exit(0);
}

const { execSync } = require("node:child_process");
try {
  execSync("npx playwright install chromium --with-deps", { stdio: "inherit" });
} catch {
  execSync("npx playwright install chromium", { stdio: "inherit" });
}
