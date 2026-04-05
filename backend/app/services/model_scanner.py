"""
GGUF 模型掃描服務

遞迴掃描指定目錄下的所有 .gguf 檔案，並解析模型元資料。
"""
import logging
import re
from pathlib import Path

from backend.app.schemas import GGUFFileInfo

logger = logging.getLogger(__name__)

# 常見的量化格式
QUANT_PATTERNS = [
    "IQ1_S", "IQ1_M", "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M",
    "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M", "IQ4_XS", "IQ4_NL",
    "Q2_K_S", "Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L",
    "Q4_0", "Q4_1", "Q4_K_S", "Q4_K_M", "Q4_K_L",
    "Q5_0", "Q5_1", "Q5_K_S", "Q5_K_M", "Q5_K_L",
    "Q6_K", "Q8_0", "F16", "F32", "BF16",
]

# 參數大小的正則 (e.g., 0.5B, 1.5B, 7B, 70B, 405B)
PARAM_SIZE_REGEX = re.compile(r"[\-_](\d+(?:\.\d+)?[Bb])[\-_\.]")

# 排除模式：測試、臨時、不完整的檔案
EXCLUSION_PATTERNS = [
    r"test",
    r"debug",
    r"temp",
    r"tmp",
    r"\.partial",
    r"\.incomplete",
    r"~",
    r"\.back",
    r"\.old",
    r"\.bak",
]


def _is_mmproj_file(filename: str) -> bool:
    """檢查是否為 multimodal projector (mmproj) 檔案。"""
    name_lower = filename.lower()
    return "mmproj" in name_lower or "projector" in name_lower


def _normalize_stem_for_match(filename: str) -> str:
    """標準化檔名，供 base model / mmproj 關聯比對。"""
    stem = Path(filename).stem.lower()
    stem = re.sub(r"(mmproj|projector|vision|clip)", " ", stem)
    stem = re.sub(r"(f16|f32|bf16|fp16|fp32)", " ", stem)
    stem = re.sub(r"(q\d+(_k_[sml]|_[01])?|iq\d+(_[a-z]+)?)", " ", stem)
    stem = re.sub(r"\d+(\.\d+)?b", " ", stem)
    stem = re.sub(r"[-_\.]+", " ", stem)
    stem = re.sub(r"\s+", " ", stem)
    return stem.strip()


def _token_overlap_score(a: str, b: str) -> int:
    """計算兩個標準化字串 token 重疊分數。"""
    ta = {t for t in a.split(" ") if t}
    tb = {t for t in b.split(" ") if t}
    if not ta or not tb:
        return 0
    return len(ta.intersection(tb))


def _link_multimodal_relations(models: list[GGUFFileInfo]) -> None:
    """將 mmproj 檔案與同目錄最相近的 base model 建立關聯。"""
    by_parent: dict[str, list[GGUFFileInfo]] = {}
    for m in models:
        by_parent.setdefault(m.parent_dir, []).append(m)

    for _, items in by_parent.items():
        projectors = [m for m in items if m.model_type == "multimodal_projector"]
        bases = [m for m in items if m.model_type != "multimodal_projector"]

        if not projectors or not bases:
            continue

        for pj in projectors:
            pj_norm = _normalize_stem_for_match(pj.filename)
            best_base: GGUFFileInfo | None = None
            best_score = -1

            for base in bases:
                base_norm = _normalize_stem_for_match(base.filename)
                score = _token_overlap_score(pj_norm, base_norm)
                if score > best_score:
                    best_score = score
                    best_base = base

            if best_base is None:
                continue

            # 若目錄下只有一個 base 或 token overlap > 0，建立關聯
            if len(bases) == 1 or best_score > 0:
                best_base.model_type = "multimodal_base"
                best_base.related_mmproj_path = pj.filepath
                pj.related_base_model_path = best_base.filepath


def _parse_gguf_metadata(filename: str, parent_dir: str) -> dict[str, str]:
    """從 GGUF 檔名與上層目錄解析出模型元資料。

    常見格式範例：
      - Qwen3.5-9B-Q4_K_M.gguf
      - Meta-Llama-3.1-8B-Instruct-Q5_K_M.gguf
      - lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf

    Returns:
        {"publisher": ..., "quantize": ..., "param_size": ..., "arch": ...}
    """
    meta: dict[str, str] = {
        "publisher": "",
        "quantize": "",
        "param_size": "",
        "arch": "",
    }

    name_no_ext = filename.replace(".gguf", "")

    # 1. Quantize: 在檔名中找已知量化格式
    name_upper = name_no_ext.upper()
    for q in QUANT_PATTERNS:
        if q in name_upper:
            meta["quantize"] = q
            break

    # 2. Param Size: 找 7B, 9B, 70B, 1.5B 之類
    pm = PARAM_SIZE_REGEX.search(filename)
    if pm:
        meta["param_size"] = pm.group(1).upper()

    # 3. Publisher: 從上層目錄推斷
    #    lmstudio 結構: publisher/ModelName-GGUF/file.gguf
    parts = Path(parent_dir).parts
    if len(parts) >= 2:
        # 檢查上上層 (publisher) -> 上層 (model-GGUF)
        potential_publisher = parts[-2] if len(parts) >= 2 else ""
        potential_model_dir = parts[-1]
        if "gguf" in potential_model_dir.lower() or "GGUF" in potential_model_dir:
            meta["publisher"] = potential_publisher
        else:
            # 仍嘗試 parent 是否為 publisher 結構
            meta["publisher"] = parts[-1]

    # 4. Arch: 從檔名提取模型架構（去掉 quant、param size、instruct 等）
    arch = name_no_ext
    # 去掉量化後綴
    if meta["quantize"]:
        arch = re.sub(re.escape(meta["quantize"]), "", arch, flags=re.IGNORECASE).strip("-_ ")
    # 去掉參數大小
    if meta["param_size"]:
        arch = re.sub(r"[\-_]?" + re.escape(meta["param_size"]) + r"[\-_]?", "-", arch, flags=re.IGNORECASE).strip("-_ ")
    # 去掉常見的後綴
    for suffix in ["Instruct", "Chat", "Base", "GGUF", "gguf"]:
        arch = arch.replace(f"-{suffix}", "").replace(f"_{suffix}", "")
    meta["arch"] = arch.strip("-_ ") or name_no_ext

    return meta




def _should_exclude_file(filename: str) -> bool:
    """檢查檔案是否應該被排除（測試、臨時、不完整等）。"""
    name_lower = filename.lower()
    for pattern in EXCLUSION_PATTERNS:
        if re.search(pattern, name_lower):
            return True
    return False


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
    """掃描單一目錄下的所有 .gguf 檔案。"""
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
        for gguf_path in sorted(dir_path.rglob("*.gguf")):
            if not gguf_path.is_file():
                continue

            # 排除測試、臨時、不完整的檔案
            if _should_exclude_file(gguf_path.name):
                logger.debug(f"排除檔案: {gguf_path.name} (符合排除模式)")
                continue

            try:
                stat = gguf_path.stat()
                parent = str(gguf_path.parent.resolve())
                meta = _parse_gguf_metadata(gguf_path.name, parent)
                models.append(
                    GGUFFileInfo(
                        filename=gguf_path.name,
                        filepath=str(gguf_path.resolve()),
                        size_bytes=stat.st_size,
                        size_human=_human_readable_size(stat.st_size),
                        parent_dir=parent,
                        publisher=meta["publisher"],
                        quantize=meta["quantize"],
                        param_size=meta["param_size"],
                        arch=meta["arch"],
                        model_type="multimodal_projector" if _is_mmproj_file(gguf_path.name) else "text",
                        related_mmproj_path="",
                        related_base_model_path="",
                    )
                )
            except OSError as e:
                errors.append(f"無法讀取檔案 {gguf_path}: {e}")

    except PermissionError as e:
        errors.append(f"目錄存取權限不足 {directory}: {e}")

    _link_multimodal_relations(models)

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
