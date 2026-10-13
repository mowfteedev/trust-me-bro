# ==============================================================================
# DOCKERFILE ĐÓNG GÓI CONTROL PLANE GATEWAY (ĐA TẦNG - MULTI-STAGE BUILD)
# Dự án: ZT-ServerOps (do-an-co-so-nganh)
# Phụ trách: devops (chủ trì), security
# ==============================================================================

# --- TẦNG 1: BIÊN DỊCH MÃ NGUỒN TYPESCRIPT (BUILDER) ---
FROM node:20-alpine AS builder

WORKDIR /app

# Nạp package.json và cài đặt toàn bộ dependencies phục vụ build
COPY package.json tsconfig.json ./
RUN npm install

# Sao chép mã nguồn và biên dịch TypeScript sang JavaScript
COPY src/ ./src/
RUN npm run build

# Loại bỏ devDependencies để thu gọn kích thước ảnh đóng gói
RUN npm prune --production

# --- TẦNG 2: MÔI TRƯỜNG THỰC THI TỐI GIẢN (PRODUCTION RUNTIME) ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Sử dụng người dùng không đặc quyền node (UID/GID 1000) sẵn có trong node:20-alpine
# để đồng bộ quyền hạn với host filesystem (tránh lỗi EACCES với keys chmod 600/700)
RUN mkdir -p /app/logs/audit /app/keys && chown -R node:node /app/logs /app/keys

# Sao chép các tệp đã biên dịch, thư mục migrations và node_modules tối giản từ tầng builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=node:node migrations/ ./migrations/

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
