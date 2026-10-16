# Playwright's image ships Node plus a Chromium matching playwright-core's version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/data \
    TZ=Asia/Tokyo \
    PORT=8080

EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
