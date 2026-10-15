#!/usr/bin/env bash
# ==============================================================================
# mowftee-guild: Bộ điều khiển & Quản trị Kỹ năng cho Google Antigravity (AGY)
# ==============================================================================

set -euo pipefail

DEST_DIR="${HOME}/.gemini/config/skills"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${SOURCE_DIR}/skills"
TEMPLATES_DIR="${SOURCE_DIR}/templates/memory"

# Màu sắc hiển thị terminal
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BLUE=''; CYAN=''; BOLD=''; RESET=''
fi

ACTION="${1:-install}"
TARGET_PATH="${2:-.}"

case "$ACTION" in
  install)
    echo -e "${BOLD}${CYAN}⚔️  Đang cài đặt mowftee-guild vào Antigravity...${RESET}"
    mkdir -p "$DEST_DIR"
    
    count=0
    for skill_path in "$SKILLS_DIR"/*; do
      if [[ -d "$skill_path" ]]; then
        skill_name="$(basename "$skill_path")"
        target_dir="$DEST_DIR/$skill_name"
        mkdir -p "$target_dir"
        cp "$skill_path/SKILL.md" "$target_dir/SKILL.md"
        echo -e "  ${GREEN}[+] Đã nạp cao thủ:${RESET} ${BOLD}@$skill_name${RESET}"
        count=$((count + 1))
      fi
    done
    
    echo -e "${CYAN}==========================================================${RESET}"
    echo -e "${GREEN}✅ Thành công! Đã nạp $count cao thủ vào: $DEST_DIR${RESET}"
    echo -e "👉 Trong Antigravity, bạn chỉ cần gõ: ${BOLD}@tech-lead, @frontend, @backend...${RESET} để triệu hồi."
    echo -e "${CYAN}==========================================================${RESET}"
    ;;

  init)
    abs_target="$(cd "$TARGET_PATH" 2>/dev/null && pwd || echo "$TARGET_PATH")"
    echo -e "${BOLD}${BLUE}🏛️  Đang khởi tạo Bộ Nhớ Dự Án (.memory/) tại:${RESET} ${BOLD}$abs_target${RESET}"
    
    mem_dir="$abs_target/.memory"
    mkdir -p "$mem_dir/adr"
    
    if [[ ! -f "$mem_dir/architecture.md" ]]; then
      cp "$TEMPLATES_DIR/architecture.md" "$mem_dir/architecture.md"
      echo -e "  ${GREEN}[+] Đã tạo:${RESET} .memory/architecture.md"
    else
      echo -e "  ${YELLOW}[!] Đã tồn tại:${RESET} .memory/architecture.md (giữ nguyên)"
    fi

    if [[ ! -f "$mem_dir/progress.md" ]]; then
      cp "$TEMPLATES_DIR/progress.md" "$mem_dir/progress.md"
      echo -e "  ${GREEN}[+] Đã tạo:${RESET} .memory/progress.md"
    else
      echo -e "  ${YELLOW}[!] Đã tồn tại:${RESET} .memory/progress.md (giữ nguyên)"
    fi

    if [[ ! -f "$mem_dir/gate-checklist.md" ]]; then
      cp "$TEMPLATES_DIR/gate-checklist-template.md" "$mem_dir/gate-checklist.md"
      echo -e "  ${GREEN}[+] Đã tạo:${RESET} .memory/gate-checklist.md"
    fi

    if [[ ! -f "$mem_dir/test-evidence.md" ]]; then
      cp "$TEMPLATES_DIR/test-evidence-template.md" "$mem_dir/test-evidence.md"
      echo -e "  ${GREEN}[+] Đã tạo:${RESET} .memory/test-evidence.md"
    fi

    if [[ ! -f "$mem_dir/adr/0001-khoi-tao-du-an.md" ]]; then
      cp "$TEMPLATES_DIR/adr-template.md" "$mem_dir/adr/0001-khoi-tao-du-an.md"
      sed -i 's/\[Mã số\]/0001/g' "$mem_dir/adr/0001-khoi-tao-du-an.md"
      sed -i 's/\[Tên Quyết Định Kiến Trúc Ngắn Gọn\]/Khởi tạo kiến trúc dự án với mowftee-guild/g' "$mem_dir/adr/0001-khoi-tao-du-an.md"
      echo -e "  ${GREEN}[+] Đã tạo:${RESET} .memory/adr/0001-khoi-tao-du-an.md"
    fi

    echo -e "${CYAN}==========================================================${RESET}"
    echo -e "${GREEN}✅ Khởi tạo Bộ Nhớ Dự Án hoàn tất!${RESET}"
    echo -e "👉 Mở Antigravity tại thư mục này và gõ:"
    echo -e "   ${BOLD}\"@tech-lead Hãy đọc .memory/ và bắt đầu phân chia công việc.\"${RESET}"
    echo -e "${CYAN}==========================================================${RESET}"
    ;;

  check|status)
    echo -e "${BOLD}${CYAN}🔍 Kiểm tra tính toàn vẹn của mowftee-guild...${RESET}\n"
    printf "%-16s %-10s %-12s %-15s\n" "CHUYÊN GIA" "FILE SIZE" "FRONTMATTER" "ANTIGRAVITY"
    echo "---------------------------------------------------------"

    all_good=true
    for skill_path in "$SKILLS_DIR"/*; do
      if [[ -d "$skill_path" ]]; then
        skill_name="$(basename "$skill_path")"
        skill_file="$skill_path/SKILL.md"
        installed_file="$DEST_DIR/$skill_name/SKILL.md"
        
        # 1. Kích thước
        if [[ -f "$skill_file" ]]; then
          size="$(du -h "$skill_file" | cut -f1)"
        else
          size="MISSING"
          all_good=false
        fi

        # 2. Frontmatter check
        if grep -q "^name: $skill_name" "$skill_file" && grep -q "^description:" "$skill_file"; then
          fm_status="${GREEN}Hợp lệ${RESET}"
        else
          fm_status="${RED}Lỗi${RESET}"
          all_good=false
        fi

        # 3. Installation check
        if [[ -f "$installed_file" ]]; then
          inst_status="${GREEN}Đã nạp${RESET}"
        else
          inst_status="${YELLOW}Chưa nạp${RESET}"
          all_good=false
        fi

        printf "%-16s %-10s %-21b %-24b\n" "@$skill_name" "$size" "$fm_status" "$inst_status"
      fi
    done

    echo "---------------------------------------------------------"
    if $all_good; then
      echo -e "${GREEN}🎉 Toàn bộ 10 chuyên gia đều hoàn hảo và sẵn sàng chiến đấu!${RESET}"
    else
      echo -e "${YELLOW}⚠️  Có cảnh báo. Hãy chạy './setup.sh install' để đồng bộ lại.${RESET}"
    fi
    ;;

  uninstall)
    echo -e "${BOLD}${YELLOW}🧹 Đang gỡ bỏ các kỹ năng mowftee-guild khỏi Antigravity...${RESET}"
    for skill_path in "$SKILLS_DIR"/*; do
      if [[ -d "$skill_path" ]]; then
        skill_name="$(basename "$skill_path")"
        target_dir="$DEST_DIR/$skill_name"
        if [[ -d "$target_dir" ]]; then
          rm -rf "$target_dir"
          echo -e "  ${RED}[-] Đã gỡ bỏ:${RESET} @$skill_name"
        fi
      fi
    done
    echo -e "${GREEN}✅ Đã dọn dẹp sạch sẽ!${RESET}"
    ;;

  *)
    echo -e "${BOLD}Cách sử dụng mowftee-guild:${RESET}"
    echo "  ./setup.sh install          # Cài đặt/cập nhật toàn bộ 10 chuyên gia vào Antigravity"
    echo "  ./setup.sh check            # Kiểm tra trạng thái & tính toàn vẹn của 10 chuyên gia"
    echo "  ./setup.sh init [path]      # Khởi tạo nhanh thư mục .memory/ vào dự án bất kỳ"
    echo "  ./setup.sh uninstall        # Gỡ bỏ toàn bộ chuyên gia khỏi Antigravity"
    exit 1
    ;;
esac
