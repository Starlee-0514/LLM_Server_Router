"""
GGUF 模型掃描服務

遞迴掃描指定目錄下的所有 .gguf 檔案。
"""
import logging
from pathlib import Path

from backend.app.schemas import GGUFFileInfo

logger = logging.getLogger(__name__)


def _human_readable_size(size_bytes: int) -> str:
    """將位元組轉換為人類可讀的大小字串。"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 ** 2:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 ** 3:
        return f"{size_bytes / (1024 ** 2):.1f} MB"
    else:
        return f"{size_bytes / (1024 ** 3):.2f} GB"


def scan_directory(directory: str) -> tuple[list[GGUFFileInfo], list[str]]:
    """掃描單一目錄下的所有 .gguf 檔案。

    Args:
        directory: 要掃描的目錄路徑

    Returns:
        (models, errors) - 找到的模型清單與錯誤訊息列表
    """
    models: list[GGUFFileInfo] = []
    errors: list[str] = []

    dir_path = Path(directory)

    if not dir_path.exists():
        errors.append(f"目錄不存在: {directory}")
        return models, errors

    if not dir_path.is_dir():
        errors.append(f"路徑不是目錄: {directory}")
        return models, errors

    try:
        # 遞迴搜尋所有 .gguf 檔案
        for gguf_path in sorted(dir_path.rglob("*.gguf")):
            if not gguf_path.is_file():
                continue

            try:
                stat = gguf_path.stat()
                models.append(
                    GGUFFileInfo(
                        filename=gguf_path.name,
                        filepath=str(gguf_path.resolve()),
                        size_bytes=stat.st_size,
                        size_human=_human_readable_size(stat.st_size),
                        parent_dir=str(gguf_path.parent.resolve()),
                    )
                )
            except OSError as e:
                errors.append(f"無法讀取檔案 {gguf_path}: {e}")

    except PermissionError as e:
        errors.append(f"目錄存取權限不足 {directory}: {e}")

    return models, errors


def scan_directories(directories: list[str]) -> tuple[list[GGUFFileInfo], list[str]]:
    """掃描多個目錄下的所有 .gguf 檔案。

    Args:
        directories: 要掃描的目錄路徑列表

    Returns:
        (models, errors) - 合併後的模型清單與錯誤訊息列表
    """
    all_models: list[GGUFFileInfo] = []
    all_errors: list[str] = []

    # 使用 set 去除重複路徑
    seen_paths: set[str] = set()

    for directory in directories:
        directory = directory.strip()
        if not directory:
            continue

        logger.info(f"掃描目錄: {directory}")
        models, errors = scan_directory(directory)

        # 去重（基於完整路徑）
        for model in models:
            if model.filepath not in seen_paths:
                seen_paths.add(model.filepath)
                all_models.append(model)

        all_errors.extend(errors)

    logger.info(f"掃描完成: 共找到 {len(all_models)} 個 GGUF 檔案")
    return all_models, all_errors
