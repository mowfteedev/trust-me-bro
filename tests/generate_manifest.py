#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def get_sha256(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def main():
    commit_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=BASE_DIR, text=True).strip()
    manifest = {
        "timestamp": "2026-10-13T22:42:00+07:00",
        "git_commit": commit_sha,
        "branch": "minh-thanh",
        "evidence_files": {},
        "source_modified_files": {}
    }

    evidence_dir = os.path.join(BASE_DIR, "evidence_v3")
    for fname in sorted(os.listdir(evidence_dir)):
        fpath = os.path.join(evidence_dir, fname)
        if os.path.isfile(fpath) and fname != "manifest_sha256.json":
            manifest["evidence_files"][fname] = {
                "sha256": get_sha256(fpath),
                "size_bytes": os.path.getsize(fpath)
            }

    source_files = [
        "docker-compose.yml",
        "gateway/src/config/env.ts",
        "gateway/src/server.ts",
        "gateway/src/services/bastion.ts",
        "gateway/src/services/sweeper.ts",
        "gateway/src/services/telegram.ts",
        "gateway/src/services/migration-runner.ts",
        "gateway/src/scripts/run-migrations.ts",
        "gateway/src/scripts/run-maintenance.ts",
        "gateway/src/scripts/bootstrap-admin.ts",
        "gateway/src/routes/telemetry.ts",
        "gateway/migrations/006_remediate_default_seed_and_credentials.sql",
        "deploy/db/01_create_app_roles.sql",
        "deploy/scripts/maintenance-retention.sh",
        "dashboard/src/services/api.ts",
        "dashboard/src/App.tsx"
    ]

    for sf in source_files:
        full_sf = os.path.join(BASE_DIR, sf)
        if os.path.isfile(full_sf):
            manifest["source_modified_files"][sf] = {
                "sha256": get_sha256(full_sf),
                "size_bytes": os.path.getsize(full_sf)
            }

    out_file = os.path.join(evidence_dir, "manifest_sha256.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"✅ Đã tạo thành công manifest JSON tại: {out_file}")

if __name__ == "__main__":
    main()
