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
	@echo -e "  ${GREEN}make test${RESET}    - Unit tests Agent và Gateway (DB/fetch giả lập)"
	@echo -e "  ${GREEN}make e2e${RESET}     - Kiểm tra cụm demo thật và DB test riêng"
	@echo -e "  ${GREEN}make mock${RESET}    - Kích hoạt trình giả lập tải 50 Endpoint Hosts"
	@echo -e "  ${GREEN}make logs${RESET}    - Giám sát luồng nhật ký thời gian thực của cụm Gateway & Proxy"
	@echo -e "  ${GREEN}make clean${RESET}   - Dọn dẹp tệp rác, bộ nhớ đệm Python/Node và nhật ký tạm"
	@echo -e "  ${GREEN}make status${RESET}  - Kiểm tra trạng thái tiến trình và các cổng dịch vụ Zero-Trust\n"

up:
	@python3 deploy/scripts/demo.py up

down:
	@python3 deploy/scripts/demo.py down

test:
	@python3 agent/tests/test_unit_agent.py
	@docker build --target builder -t zt_course_tests gateway
	@docker run --rm -v "$(CURDIR)/gateway/tests:/app/tests:ro" zt_course_tests npm test
	@echo "Unit tests dùng mock DB/fetch; chạy make e2e để kiểm chứng cụm thật."

e2e:
	@python3 deploy/scripts/demo.py check

mock:
	@echo -e "${CYAN}==> Khởi chạy trình giả lập 50 Endpoint Hosts...${RESET}"
	@python3 deploy/scripts/mock-nodes.py --count 50 --dry-run

status:
	@python3 deploy/scripts/demo.py status

logs:
	@python3 deploy/scripts/demo.py logs

clean:
	@echo -e "${YELLOW}==> Dọn dẹp tệp rác và bộ đệm hệ thống...${RESET}"
	@find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
	@find . -type f -name "*.pyo" -delete 2>/dev/null || true
	@find . -type f -name "*.log" ! -name "adversarial-report.log" -delete 2>/dev/null || true
	@echo -e "${GREEN}✔ Đã dọn dẹp sạch sẽ không gian làm việc.${RESET}"
