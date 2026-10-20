#!/usr/bin/env python3
"""Remove Python bytecode only; preserve runtime data, evidence and symlinks."""
import os
from pathlib import Path


PROTECTED_DIRS = {
    '.git', '.memory', 'keys', 'docs', 'logs', 'node_modules',
    '.venv', 'venv', 'env',
}


def clean_python_cache(root: Path) -> tuple[int, int]:
    removed_files = removed_dirs = 0
    cache_dirs = []

    def fail(error):
        raise error

    for directory, directories, filenames in os.walk(root, followlinks=False, onerror=fail):
        base = Path(directory)
        directories[:] = [name for name in directories
                          if name not in PROTECTED_DIRS and not (base / name).is_symlink()]
        if base.name == '__pycache__':
            cache_dirs.append(base)
        for name in filenames:
            path = base / name
            if path.suffix in ('.pyc', '.pyo') and not path.is_symlink() and path.is_file():
                path.unlink()
                removed_files += 1

    # Do not recursively remove cache directories: keep any non-bytecode evidence.
    for path in reversed(cache_dirs):
        if not any(path.iterdir()):
            path.rmdir()
            removed_dirs += 1
    return removed_files, removed_dirs


if __name__ == '__main__':
    try:
        files, directories = clean_python_cache(Path(__file__).resolve().parents[2])
    except OSError as error:
        raise SystemExit(f'Không dọn được bytecode Python: {error}') from error
    print(f'Đã xóa {files} tệp bytecode Python và {directories} thư mục __pycache__ rỗng.')
    print('Giữ nguyên log, dữ liệu, keys, docs, .memory, .git, node_modules và symlink.')
