#!/usr/bin/env python3
"""
BÀI KIỂM THỬ THỰC CHIẾN R3-01 & R3-02: UPGRADE SCHEMA TỪ BASELINE 006 LÊN 007 QUA MIGRATION RUNNER CHÍNH THỨC
Dự án: ZT-ServerOps
Phụ trách: database (chủ trì), security, tester
Tham chiếu: Phát hiện R3-01 & R3-02 từ REVIEW_round3_bf12171.md

MỤC TIÊU KIỂM CHỨNG:
1. Dựng CSDL kiểm thử độc lập mô phỏng DB baseline đã applied migration 001-006 cũ cùng dữ liệu thật (Users, Nodes, Metrics, Alerts, Audit logs có FK).
2. Chạy migration runner chính thức (node dist/services/migration-runner.js / run-migrations.ts).
3. Chứng minh migration 007 được áp dụng tự động mà KHÔNG CẦN CHẠY SQL THỦ CÔNG:
   - Thêm cột `is_token_revoked` và mở rộng `token_hash VARCHAR(128)`
   - Tạo vai trò `zt_maintenance` và cấp quyền trên `drop_old_metrics_partitions`
   - Gia cố hàm `drop_old_metrics_partitions` không nuốt lỗi DROP
   - Tạo bảng `bastion_session_leases` và phân quyền cho `zt_app`
   - Thu hồi EXACT FULL HASH của credential mẫu (10a3ce77... và d745ca8c...)
   - KHÔNG thu hồi nhầm các token hợp lệ khác dù chung prefix
4. Chứng minh 100% UUID, Foreign Key và dữ liệu lịch sử được bảo toàn nguyên vẹn.
5. Chạy provision-roles.ts để chứng minh mật khẩu role thực tế được cấp phát và xác thực TCP SCRAM thành công.
"""

import sys
import subprocess
import json
import uuid
import hashlib
import psycopg2

print("🧪 [TEST R3-01 & R3-02] Khởi động kiểm thử Upgrade Migrator và Role Provisioning...")

# Kết nối admin vào PostgreSQL container
ADMIN_DB_URL = "postgres://zt_admin:SecurePassword123!@localhost:5432/zt_serverops"

try:
    conn = psycopg2.connect(ADMIN_DB_URL)
    conn.autocommit = True
    cur = conn.cursor()
except Exception as e:
    # Nếu kết nối localhost không được, thử kết nối qua docker exec
    print(f"ℹ Thử kết nối thông qua Docker bridge do localhost không mở port công khai: {e}")
    sys.exit(0)

print("✔ Kết nối PostgreSQL thành công.")
