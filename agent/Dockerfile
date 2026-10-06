# ==============================================================================
# DOCKERFILE ĐÓNG GÓI ENDPOINT WORKER DAEMON SIÊU NHẸ (< 45MB)
# Dự án: ZT-ServerOps (do-an-co-so-nganh)
# Phụ trách: devops (chủ trì), agent, tester
# ==============================================================================

FROM python:3.12-alpine

WORKDIR /app

ENV PYTHONUNBUFFERED=1

# Tạo người dùng và nhóm không đặc quyền để tăng cường phòng thủ
RUN addgroup -S ztgroup && adduser -S ztuser -G ztgroup

# Sao chép toàn bộ mã nguồn của Agent
COPY src/ /app/

# Chuyển quyền sở hữu cho người dùng không đặc quyền
RUN chown -R ztuser:ztgroup /app

USER ztuser

CMD ["python3", "/app/main.py"]
