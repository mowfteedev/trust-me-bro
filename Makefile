# ==============================================================================
# MAKEFILE — HỆ THỐNG GIÁM SÁT HẠ TẦNG ZERO-TRUST (TRUST-ME-BRO)
# Đồ án cơ sở ngành — Nhóm 9 (Khoa CNTT - Đại học Công nghiệp Hà Nội)
# ==============================================================================

.PHONY: help up down test mock clean logs status e2e doctor check-cpu check-telegram

SHELL := /bin/bash
PYTHON ?= python3
PROJECT ?= zt_demo
ENV_FILE ?= keys/demo.env
DEMO = $(PYTHON) deploy/scripts/demo.py
DEMO_FLAGS = --env-file "$(ENV_FILE)" --project "$(PROJECT)"

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
	@echo -e "  ${GREEN}make down${RESET}    - Dừng cụm; giữ nguyên volume DB, khóa và mật khẩu"
	@echo -e "  ${GREEN}make test${RESET}    - Unit tests Agent và Gateway (DB/fetch giả lập)"
	@echo -e "  ${GREEN}make e2e${RESET}     - API/SSH thật và DB test riêng; thu hồi phiên tài khoản demo"
	@echo -e "  ${GREEN}make doctor${RESET}  - Chẩn đoán chỉ đọc cấu hình và cụm đang chạy"
	@echo -e "  ${GREEN}make mock${RESET}    - Dry-run 50 node giả: sinh số liệu, không gửi HTTP/bơm tải Gateway"
	@echo -e "  ${GREEN}make logs${RESET}    - In tối đa 80 dòng log gần nhất mỗi dịch vụ Gateway/WireGuard/Worker"
	@echo -e "  ${GREEN}make clean${RESET}   - Chỉ dọn bytecode Python; giữ log, khóa, tài liệu và symlink"
	@echo -e "  ${GREEN}make status${RESET}  - Liệt kê container trong cụm (kể cả đã dừng)"
	@echo -e "  ${GREEN}make check-cpu${RESET}      - Lab CPU thật, DB riêng, ngưỡng thử và Telegram dry-run"
	@echo -e "  ${YELLOW}make check-telegram${RESET} - Gửi một cảnh báo thử Telegram THẬT đến chat đã ghép nối"
	@echo -e "\n  Cụm mặc định: PROJECT=zt_demo ENV_FILE=keys/demo.env PYTHON=python3"
	@echo -e "  Ví dụ: make status PROJECT=zt_check ENV_FILE=keys/check.env\n"

up:
	@$(DEMO) up $(DEMO_FLAGS)

down:
	@$(DEMO) down $(DEMO_FLAGS)

test:
	@docker build --target builder -t zt_agent_tests agent
	@docker run --rm zt_agent_tests go test ./...
	@docker build --target builder -t zt_course_tests gateway
	@docker run --rm -v "$(CURDIR)/gateway/tests:/app/tests:ro" zt_course_tests npm test
	@echo "Unit tests dùng mock DB/fetch; chạy make e2e để kiểm chứng cụm thật."

e2e:
	@echo "Kiểm tra cụm $(PROJECT): đăng nhập/logout sẽ thu hồi các phiên demo-admin/demo-viewer."
	@$(DEMO) check $(DEMO_FLAGS)

doctor:
	@$(DEMO) doctor $(DEMO_FLAGS)

check-cpu:
	@$(DEMO) check-cpu $(DEMO_FLAGS)

check-telegram:
	@echo "Gửi một cảnh báo thử Telegram THẬT đến chat đã ghép nối của cụm $(PROJECT)."
	@$(DEMO) check-telegram $(DEMO_FLAGS)

mock:
	@echo -e "${CYAN}==> Dry-run 50 node giả: chỉ sinh số liệu; không gửi HTTP, không kiểm chứng tải Gateway.${RESET}"
	@$(PYTHON) deploy/scripts/mock-nodes.py --count 50 --dry-run

status:
	@$(DEMO) status $(DEMO_FLAGS)

logs:
	@$(DEMO) logs $(DEMO_FLAGS)

clean:
	@$(PYTHON) deploy/scripts/clean.py
