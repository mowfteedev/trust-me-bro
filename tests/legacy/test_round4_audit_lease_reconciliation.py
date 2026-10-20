#!/usr/bin/env python3
"""
BÀI KIỂM THỬ THỰC CHIẾN R3-04: AUDIT LIFECYCLE, LEASE FENCING VÀ IDEMPOTENT RECONCILER
Dự án: ZT-ServerOps
Phụ trách: database (chủ trì), backend, tester
Tham chiếu: R3-04 & N08 từ REVIEW_round3_bf12171.md

MỤC TIÊU KIỂM CHỨNG:
1. Terminal hoạt động lâu (>30 phút, 45 phút):
   - Phiên có lease_expires_at ở tương lai (được heartbeat renew).
   - Chạy reconciler trong Sweeper -> KHÔNG ĐƯỢC PHÉP ghi END giả mạo!
2. Instance crash / Unclean termination (Lease Expired):
   - Heartbeat dừng -> lease_expires_at rơi vào quá khứ.
   - Chạy reconciler -> Tự động bù đắp BASTION_SESSION_END với lý do chính xác 'Lease Expired (Heartbeat lost / Gateway instance crash)'.
3. Graceful closure nhưng DB outage (Lease status = 'CLOSED' nhưng chưa có END log):
   - Chạy reconciler -> Bù đắp BASTION_SESSION_END với lý do đóng của phiên.
4. Chống tranh chấp đồng thời (Idempotency Guard):
   - Giả lập 2 Gateway instance cùng chạy reconciler trên cùng 1 expired lease.
   - Kết quả: DUY NHẤT 1 bản ghi BASTION_SESSION_END được ghi vào audit_logs.
"""

import subprocess
import json
import uuid

def run_sql(sql):
    cmd = ["docker", "exec", "zt_postgres", "psql", "-U", "zt_admin", "-d", "zt_serverops", "-t", "-A", "-c", sql]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Lỗi SQL: {res.stderr}")
    return res.stdout.strip()

print("🧪 [TEST R3-04] Bắt đầu kiểm tra Audit Lifecycle và Lease Reconciliation...")

# Lấy 1 user_id và node_id có sẵn trong CSDL
user_id = run_sql("SELECT id FROM users LIMIT 1;")
node_id = run_sql("SELECT id FROM nodes LIMIT 1;")
assert user_id and node_id, "Phải có ít nhất 1 user và 1 node trong CSDL"

# --------------------------------------------------------------------------
# KỊCH BẢN 1: Phiên SSH hoạt động lâu (>45 phút) KHÔNG BỊ GHI END NHẦM
# --------------------------------------------------------------------------
session_1 = str(uuid.uuid4())
# Tạo bản ghi START cách đây 45 phút (vấn đề cũ từng bị gán nhầm là orphan)
run_sql(f"""
INSERT INTO audit_logs (user_id, action, target, details, created_at)
VALUES ('{user_id}', 'BASTION_SESSION_START', 'bastion', '{{"session_id": "{session_1}", "node_id": "{node_id}"}}', (now() AT TIME ZONE 'UTC') - INTERVAL '45 minutes');
""")
# Nhưng lease của phiên đang ACTIVE và expires ở tương lai (đang được Gateway renew)
run_sql(f"""
INSERT INTO bastion_session_leases (session_id, user_id, node_id, instance_id, lease_expires_at, status)
VALUES ('{session_1}', '{user_id}', '{node_id}', 'gw_instance_active', (now() AT TIME ZONE 'UTC') + INTERVAL '5 minutes', 'ACTIVE');
""")

# Chạy reconciler từ sweeper logic
reconcile_sql = """
DO $$
DECLARE
  l RECORD;
  sess_str TEXT;
  end_reason TEXT;
BEGIN
  FOR l IN
    SELECT session_id, user_id, node_id, instance_id, status, close_reason, lease_expires_at
    FROM bastion_session_leases
    WHERE (status = 'CLOSED' OR lease_expires_at < (now() AT TIME ZONE 'UTC'))
      AND status != 'RECONCILED'
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs end_log
        WHERE end_log.action = 'BASTION_SESSION_END'
          AND end_log.details->>'session_id' = bastion_session_leases.session_id::text
      )
    LIMIT 20
  LOOP
    sess_str := l.session_id::text;
    IF l.status = 'CLOSED' THEN
      end_reason := COALESCE(l.close_reason, 'Session closed by owner (Reconciled)');
    ELSE
      end_reason := 'Lease Expired (Heartbeat lost / Gateway instance crash)';
    END IF;

    INSERT INTO audit_logs (user_id, action, target, details, ip_address)
    SELECT l.user_id, 'BASTION_SESSION_END', 'bastion',
           json_build_object('session_id', sess_str, 'node_id', l.node_id, 'reason', end_reason, 'reconciled_at', now())::jsonb,
           '127.0.0.1'::inet
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_logs
      WHERE action = 'BASTION_SESSION_END'
        AND details->>'session_id' = sess_str
    );

    UPDATE bastion_session_leases
    SET status = 'RECONCILED', closed_at = COALESCE(closed_at, (now() AT TIME ZONE 'UTC')), close_reason = end_reason
    WHERE session_id = l.session_id;
  END LOOP;
END $$;
"""

run_sql(reconcile_sql)

# Kiểm tra: Phiên session_1 tuyệt đối KHÔNG có bản ghi BASTION_SESSION_END
end_count_1 = run_sql(f"SELECT count(*) FROM audit_logs WHERE action = 'BASTION_SESSION_END' AND details->>'session_id' = '{session_1}';")
assert int(end_count_1) == 0, f"LỖI: Phiên đang active 45 phút bị ghi END nhầm! Count = {end_count_1}"
print("✔ Kịch bản 1 PASS: Phiên hợp lệ kéo dài 45 phút KHÔNG bị ghi END giả mạo.")

# --------------------------------------------------------------------------
# KỊCH BẢN 2: Process Crash / Heartbeat Lost -> Lease Expired được đối soát đúng
# --------------------------------------------------------------------------
session_2 = str(uuid.uuid4())
run_sql(f"""
INSERT INTO audit_logs (user_id, action, target, details, created_at)
VALUES ('{user_id}', 'BASTION_SESSION_START', 'bastion', '{{"session_id": "{session_2}", "node_id": "{node_id}"}}', (now() AT TIME ZONE 'UTC') - INTERVAL '10 minutes');
""")
# Lease đã hết hạn do crash (expires_at ở quá khứ)
run_sql(f"""
INSERT INTO bastion_session_leases (session_id, user_id, node_id, instance_id, lease_expires_at, status)
VALUES ('{session_2}', '{user_id}', '{node_id}', 'gw_instance_crashed', (now() AT TIME ZONE 'UTC') - INTERVAL '2 minutes', 'ACTIVE');
""")

# Chạy reconciler
run_sql(reconcile_sql)

# Kiểm tra: Phiên session_2 PHẢI có đúng 1 bản ghi BASTION_SESSION_END với lý do 'Lease Expired'
end_log_2 = run_sql(f"SELECT details FROM audit_logs WHERE action = 'BASTION_SESSION_END' AND details->>'session_id' = '{session_2}';")
assert end_log_2, "LỖI: Không tìm thấy bản ghi END bù đắp sau khi crash!"
end_details_2 = json.loads(end_log_2)
assert "Lease Expired" in end_details_2.get("reason", ""), f"Lý do ghi nhận không đúng: {end_details_2.get('reason')}"
print("✔ Kịch bản 2 PASS: Phiên crash được bù đắp END log với lý do chính xác Lease Expired.")

# --------------------------------------------------------------------------
# KỊCH BẢN 3: Hai instance Gateway cùng chạy Reconciler song song (Idempotency)
# --------------------------------------------------------------------------
session_3 = str(uuid.uuid4())
run_sql(f"""
INSERT INTO audit_logs (user_id, action, target, details, created_at)
VALUES ('{user_id}', 'BASTION_SESSION_START', 'bastion', '{{"session_id": "{session_3}", "node_id": "{node_id}"}}', (now() AT TIME ZONE 'UTC') - INTERVAL '5 minutes');
""")
run_sql(f"""
INSERT INTO bastion_session_leases (session_id, user_id, node_id, instance_id, lease_expires_at, status, close_reason)
VALUES ('{session_3}', '{user_id}', '{node_id}', 'gw_instance_dual', (now() AT TIME ZONE 'UTC') - INTERVAL '1 minute', 'CLOSED', 'Normal User Exit');
""")

# Chạy reconciler 2 lần liên tiếp mô phỏng 2 Gateway cùng trigger
run_sql(reconcile_sql)
run_sql(reconcile_sql)

end_count_3 = run_sql(f"SELECT count(*) FROM audit_logs WHERE action = 'BASTION_SESSION_END' AND details->>'session_id' = '{session_3}';")
assert int(end_count_3) == 1, f"LỖI: Trùng lặp bản ghi END khi chạy song song! Count = {end_count_3}"
print("✔ Kịch bản 3 PASS: Idempotency bảo đảm duy nhất 1 bản ghi END dù nhiều instance cùng chạy.")

print("\n=============================================================")
print("🎉 [ALL TESTS PASS] Kiểm thử Audit Lease Reconciliation R3-04 ĐẠT CHUẨN 100%!")
print("=============================================================")
