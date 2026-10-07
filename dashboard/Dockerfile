# ==============================================================================
# DOCKERFILE ĐÓNG GÓI REACT 19 WEB CONSOLE DASHBOARD ĐA TẦNG (< 30MB)
# Dự án: ZT-ServerOps (do-an-co-so-nganh)
# Phụ trách: devops (chủ trì), frontend
# ==============================================================================

# GIAI ĐOẠN 1: BIÊN DỊCH VITE SPA (BUILDER STAGE)
FROM node:22-alpine AS builder

WORKDIR /app

# Tận dụng lớp bộ đệm của Docker (Docker Layer Caching)
COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

# GIAI ĐOẠN 2: MÁY CHỦ PHỤC VỤ TĨNH SIÊU NHẸ (RUNNER STAGE)
FROM nginx:alpine AS runner

WORKDIR /usr/share/nginx/html

# Xóa trang mặc định của Nginx
RUN rm -rf ./*

# Sao chép tệp thành phẩm từ giai đoạn biên dịch
COPY --from=builder /app/dist .
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
