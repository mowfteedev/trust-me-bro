# ==============================================================================
# MAKEFILE — HỆ THỐNG GIÁM SÁT HẠ TẦNG ZERO-TRUST (TRUST-ME-BRO)
# Đồ án cơ sở ngành — Nhóm 9 (Khoa CNTT - Đại học Công nghiệp Hà Nội)
# ==============================================================================

.PHONY: help up down test mock clean logs status e2e

SHELL := /bin/bash

# Màu sắc ANSI trực quan
CYAN := \033[0;36m
GREEN := \033[0;32m
YELLOW := \033[1;33m
RESET := \033[0m
BOLD := \033[1m

help:
	@echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════════════════╗${RESET}"
	@echo -e "${CYAN}║${RESET} ${BOLD}🛡️  BẢNG LỆNH ĐIỀU HÀNH HỆ THỐNG ZERO-TRUST (HAUI NHÓM 9 - MINH-THANH)    ${RESET} ${CYAN}║${RESET}"
	@echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════════════════╝${RESET}"
	@echo -e "  ${GREEN}make up${RESET}      - Khởi tạo bí mật runtime và kích hoạt toàn bộ cụm dịch vụ"
	@echo -e "  ${GREEN}make down${RESET}    - Dừng an toàn và giải phóng tài nguyên container"
	@echo -e "  ${GREEN}make test${RESET}    - Thực thi toàn diện các bộ kiểm thử tự động (Zero-Sleep)"
	@echo -e "  ${GREEN}make e2e${RESET}     - Chạy kịch bản nghiệm thu luồng E2E Smoke Test"
	@echo -e "  ${GREEN}make mock${RESET}    - Kích hoạt trình giả lập tải 50 Endpoint Hosts"
	@echo -e "  ${GREEN}make logs${RESET}    - Giám sát luồng nhật ký thời gian thực của cụm Gateway & Proxy"
	@echo -e "  ${GREEN}make clean${RESET}   - Dọn dẹp tệp rác, bộ nhớ đệm Python/Node và nhật ký tạm"
	@echo -e "  ${GREEN}make status${RESET}  - Kiểm tra trạng thái tiến trình và các cổng dịch vụ Zero-Trust\n"

up:
	@echo -e "${CYAN}==> [1/2] Khởi tạo bí mật runtime & cặp khóa Curve25519...${RESET}"
	@./deploy/scripts/init-secrets.sh
	@echo -e "${CYAN}==> [2/2] Kích hoạt toàn bộ cụm dịch vụ qua Docker Compose...${RESET}"
	@docker-compose up -d --build
	@echo -e "${GREEN}✔ Toàn bộ hệ thống đã khởi chạy thành công trong mạng Zero-Trust!${RESET}"

down:
	@echo -e "${YELLOW}==> Dừng toàn bộ cụm container và gỡ bỏ mạng nội bộ...${RESET}"
	@docker-compose down
	@echo -e "${GREEN}✔ Đã giải phóng toàn bộ tài nguyên cụm.${RESET}"

test:
	@echo -e "${CYAN}==> Thực thi toàn bộ bộ kiểm thử tự động đa tầng...${RESET}"
	@python3 tests/test_contracts.py
	@python3 tests/test_infrastructure.py
	@python3 tests/test_agent.py
	@python3 tests/test_gateway.py
	@python3 tests/test_dashboard.py
	@python3 tests/test_adversarial.py
	@python3 agent/tests/test_unit_agent.py
	@python3 gateway/tests/test_unit_gateway.py
	@echo -e "\n${GREEN}✔ 100% Bộ kiểm thử tự động đã vượt qua thành công!${RESET}"

e2e:
	@./tests/e2e/smoke-test.sh

mock:
	@echo -e "${CYAN}==> Khởi chạy trình giả lập 50 Endpoint Hosts...${RESET}"
	@python3 deploy/scripts/mock-nodes.py --count 50 --dry-run

status:
	@echo -e "${CYAN}==> Trạng thái các container dịch vụ:${RESET}"
	@docker-compose ps || echo "Lưu ý: Docker daemon chưa chạy trên host hoặc đang ở môi trường dev."

logs:
	@docker-compose logs -f gateway proxy

clean:
	@echo -e "${YELLOW}==> Dọn dẹp tệp rác và bộ đệm hệ thống...${RESET}"
	@find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
	@find . -type f -name "*.pyo" -delete 2>/dev/null || true
	@find . -type f -name "*.log" ! -name "adversarial-report.log" -delete 2>/dev/null || true
	@echo -e "${GREEN}✔ Đã dọn dẹp sạch sẽ không gian làm việc.${RESET}"
