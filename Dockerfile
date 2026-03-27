# --- build ---
# Toan bo dependency (ke ca dev: typescript) lay tu package-lock.json — can commit lockfile.
# Khong dung `npm install` tren may chu: chi `docker compose build` sau khi doi package.json.
FROM node:20-bookworm-slim AS build
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime: image có sẵn Chromium + OS deps cho Playwright ---
FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force \
  && node scripts/docker-verify-runtime.mjs

COPY --from=build /app/dist ./dist

# Runtime image được ghim cùng major/minor với package-lock (playwright 1.58.2).
USER pwuser

CMD ["node", "dist/index.js"]
