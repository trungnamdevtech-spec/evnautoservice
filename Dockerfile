# --- build ---
FROM node:20-bookworm-slim AS build
WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime: image có sẵn Chromium + OS deps cho Playwright ---
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Phiên bản @playwright/test trong image khớp với dependency playwright ^1.49.x
USER pwuser

CMD ["node", "dist/index.js"]
