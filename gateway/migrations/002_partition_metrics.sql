-- ==============================================================================
-- BẢN MIGRATION 002: THIẾT LẬP RANGE PARTITIONING CHO DỮ LIỆU TELEMETRY (v3.1)
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: database (chủ trì), backend, tester
-- ==============================================================================

SET lock_timeout = '2s';
SET statement_timeout = '10s';

-- 1. BẢNG DỮ LIỆU ĐO ĐẠC TÀI NGUYÊN PHÂN VÙNG THEO NGÀY (metrics_history)
-- LÝ DO PHI TRỰC GIÁC (RATIONALE):
-- Dữ liệu nhịp tim được ghi với tần suất cao (3s/lần/node). Nếu dùng bảng đơn và chạy lệnh
-- DELETE định kỳ, cơ chế MVCC của PostgreSQL sẽ tích lũy hàng triệu Dead Tuples, làm phình
-- dung lượng đĩa và suy kiệt I/O.
-- Cấu trúc PARTITION BY RANGE (recorded_at) cho phép thu hồi không gian đĩa tức thời trong
-- O(1) (< 5ms) bằng lệnh DROP TABLE trên các phân vùng hết hạn, không cần chạy VACUUM FULL.
CREATE TABLE IF NOT EXISTS metrics_history (
    node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    cpu_percent REAL NOT NULL CHECK (cpu_percent >= 0.0 AND cpu_percent <= 100.0),
    ram_used_bytes BIGINT NOT NULL CHECK (ram_used_bytes >= 0),
    ram_total_bytes BIGINT NOT NULL CHECK (ram_total_bytes > 0),
    ram_percent REAL NOT NULL CHECK (ram_percent >= 0.0 AND ram_percent <= 100.0),
    disk_used_bytes BIGINT NOT NULL CHECK (disk_used_bytes >= 0),
    disk_total_bytes BIGINT NOT NULL CHECK (disk_total_bytes > 0),
    disk_percent REAL NOT NULL CHECK (disk_percent >= 0.0 AND disk_percent <= 100.0),
    network_rx_bytes BIGINT NOT NULL CHECK (network_rx_bytes >= 0),
    network_tx_bytes BIGINT NOT NULL CHECK (network_tx_bytes >= 0),
    uptime_seconds BIGINT NOT NULL CHECK (uptime_seconds >= 0),
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (node_id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- 2. PHÂN VÙNG DỰ PHÒNG MẶC ĐỊNH (DEFAULT PARTITION)
-- Bảo đảm không bao giờ bị từ chối chèn dữ liệu nếu chưa kịp tạo phân vùng ngày tương ứng
CREATE TABLE IF NOT EXISTS metrics_history_default
    PARTITION OF metrics_history DEFAULT;

-- 3. HÀM TỰ ĐỘNG TẠO PHÂN VÙNG THEO NGÀY (Automated Partition Maintenance)
CREATE OR REPLACE FUNCTION create_daily_metrics_partition(target_date DATE)
RETURNS TEXT AS $$
DECLARE
    partition_name TEXT;
    start_date TEXT;
    end_date TEXT;
BEGIN
    partition_name := 'metrics_history_y' || to_char(target_date, 'YYYY_MM_DD');
    start_date := to_char(target_date, 'YYYY-MM-DD 00:00:00+00');
    end_date := to_char(target_date + 1, 'YYYY-MM-DD 00:00:00+00');

    -- Kiểm tra xem phân vùng đã tồn tại chưa
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = partition_name
    ) THEN
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF metrics_history
             FOR VALUES FROM (%L) TO (%L);',
            partition_name, start_date, end_date
        );
        -- Tạo chỉ mục cục bộ trên phân vùng phục vụ truy vấn đồ thị thời gian thực
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (node_id, recorded_at DESC);',
            'ix_' || partition_name || '_query', partition_name
        );
        RETURN 'Đã khởi tạo thành công phân vùng: ' || partition_name;
    END IF;

    RETURN 'Phân vùng đã tồn tại: ' || partition_name;
END;
$$ LANGUAGE plpgsql;

-- 4. HÀM TỰ ĐỘNG GIẢI PHÓNG PHÂN VÙNG QUÁ HẠN (Zero-Downtime Purge)
-- LÝ DO PHI TRỰC GIÁC: Xóa bảng phân vùng vật lý thay vì quét từng dòng DELETE
CREATE OR REPLACE FUNCTION drop_old_metrics_partitions(retention_days INT)
RETURNS TABLE(dropped_partition TEXT) AS $$
DECLARE
    part_record RECORD;
    cutoff_date DATE;
BEGIN
    cutoff_date := (now() AT TIME ZONE 'UTC')::date - retention_days;
    FOR part_record IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_inherits i ON i.inhrelid = c.oid
        WHERE i.inhparent = 'metrics_history'::regclass
          AND c.relname LIKE 'metrics_history_y%'
          AND c.relname != 'metrics_history_default'
    LOOP
        -- Trích xuất ngày từ tên phân vùng: metrics_history_yYYYY_MM_DD
        BEGIN
            IF to_date(substring(part_record.table_name from 'metrics_history_y(.*)'), 'YYYY_MM_DD') < cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS %I;', part_record.table_name);
                dropped_partition := part_record.table_name;
                RETURN NEXT;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Bỏ qua nếu tên phân vùng không đúng quy chuẩn ngày
            CONTINUE;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 5. KHỞI TẠO NGAY CÁC PHÂN VÙNG BAN ĐẦU (Hôm nay, hôm qua và ngày mai theo chuẩn UTC Date)
SELECT create_daily_metrics_partition(((now() AT TIME ZONE 'UTC')::date - 1));
SELECT create_daily_metrics_partition(((now() AT TIME ZONE 'UTC')::date));
SELECT create_daily_metrics_partition(((now() AT TIME ZONE 'UTC')::date + 1));
