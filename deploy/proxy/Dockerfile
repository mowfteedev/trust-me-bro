FROM node:22-alpine AS dashboard-build
WORKDIR /src/dashboard

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/tsconfig.json dashboard/vite.config.ts dashboard/postcss.config.js dashboard/tailwind.config.js dashboard/index.html ./
COPY dashboard/src/ ./src/
RUN npm run build

FROM caddy:2-alpine
COPY deploy/proxy/Caddyfile /etc/caddy/Caddyfile
COPY --from=dashboard-build /src/dashboard/dist /srv/dashboard
