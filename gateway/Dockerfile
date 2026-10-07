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

# Tạo nhóm và người dùng không đặc quyền (Non-root User) có UID/GID 10001
RUN addgroup -g 10001 -S appgroup && adduser -u 10001 -S appuser -G appgroup

# Khởi tạo trước thư mục lưu trữ log kiểm toán và cấp quyền sở hữu cho appuser
RUN mkdir -p /app/logs/audit /app/keys && chown -R appuser:appgroup /app/logs /app/keys

# Sao chép các tệp đã biên dịch và node_modules tối giản từ tầng builder
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

USER appuser

EXPOSE 3000

CMD ["node", "dist/server.js"]
