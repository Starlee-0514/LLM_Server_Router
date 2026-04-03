"""
llama-bench 效能測試執行器

自動替換 llama-server 的路徑尋找 llama-bench，並解析 stdout 寫入資料庫。
"""
import asyncio
import logging
import re
import shutil
from pathlib import Path

from backend.app.core.config import settings
from backend.app.core.process_manager import EngineType

logger = logging.getLogger(__name__)

# 正規表達式，解析 llama-bench Markdown 表格格式
# | model | size | params | backend | ngl | test | t/s | ...
# 例如：
# | llama 7B | 6.61 GiB | 7.24 B | ROCm | 99 | pp512 | 120.5 | ...
# | qwen35 9B | 5.23 GiB | 8.95 B | ROCm | 999 | pp512 | 365.20 ± 3.22 |
BENCH_ROW_REGEX = re.compile(
    r"\|\s*(?P<model>[^|]+)\s*\|"      # model
    r"\s*(?P<size>[^|]+)\s*\|"       # size
    r"\s*(?P<params>[^|]+)\s*\|"     # params
    r"\s*(?P<backend>[^|]+)\s*\|"    # backend
    r"\s*(?P<ngl>\d+)\s*\|"          # ngl
    r"\s*(?P<test>pp\d+|tg\d+)\s*\|" # test
    r"\s*(?P<ts>[\d.]+)[^|]*\|"      # t/s (只抓前面的數字，忽略 ± 等符號)
)


def _get_bench_binary(engine_type: EngineType) -> str:
    """自動推導 llama-bench 的路徑。"""
    if engine_type == EngineType.ROCM:
        server_path = settings.llama_rocm_path
    else:
        server_path = settings.llama_vulkan_path
        
    bench_path = server_path.replace("llama-server", "llama-bench")
    
    # 支援 `~/` 路徑展開
    if bench_path.startswith("~/"):
        bench_path = str(Path(bench_path).expanduser())
        
    # 若在 PATH 內，此方法能正確定位
    if not shutil.which(bench_path):
        # 也有可能是傳入的是資料夾，嘗試補上 llama-bench
        if Path(bench_path).is_dir():
            bench_path = str(Path(bench_path) / "llama-bench")
            if not shutil.which(bench_path) and not Path(bench_path).exists():
                raise FileNotFoundError(f"找不到 llama-bench 二進位檔: {bench_path}")
        else:
            raise FileNotFoundError(f"找不到 llama-bench: {bench_path} (請確認在 PATH 內或輸入完整路徑)")
            
    return bench_path


async def run_benchmark_async(
    model_name: str,
    model_path: str,
    engine_type: str = "rocm",
    n_gpu_layers: int = 999,
    batch_size: int = 512,
    ubatch_size: int = 512,
    ctx_size: int = 4096,
    n_prompt: int = 512,
    n_gen: int = 128,
    flash_attn: int = 0,
    no_kv_offload: int = 0,
) -> dict[str, float]:
    """非同步執行 llama-bench 並解析輸出。"""
    engine = EngineType(engine_type.lower())
    bench_path = _get_bench_binary(engine)

    cmd = [
        bench_path,
        "-m", model_path,
        "-n", str(n_gen),
        "-p", str(n_prompt),
        "-ngl", str(n_gpu_layers),
        "-b", str(batch_size),
        "-ub", str(ubatch_size),
        "-fa", str(flash_attn),
        "-nkvo", str(no_kv_offload),
    ]

    env = {}
    if engine == EngineType.ROCM:
        env["HSA_OVERRIDE_GFX_VERSION"] = settings.hsa_override_gfx_version

    cmd_str = ' '.join(cmd)
    logger.info(f"執行 llama-bench: {cmd_str}")

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    stdout, stderr = await process.communicate()
    stdout_text = stdout.decode("utf-8")
    stderr_text = stderr.decode("utf-8")

    # Build full execution log: command + stderr (GPU info, loading) + stdout (results)
    full_log_parts = [f"$ {cmd_str}", ""]
    if stderr_text.strip():
        full_log_parts.append(stderr_text.strip())
        full_log_parts.append("")
    if stdout_text.strip():
        full_log_parts.append(stdout_text.strip())
    full_log = "\n".join(full_log_parts)

    if process.returncode != 0:
        logger.error(f"llama-bench failed:\n{stderr_text}")
        raise RuntimeError(f"llama-bench 執行失敗\n{full_log}")

    # 解析輸出
    results = {"raw_output": full_log}
    for line in stdout_text.splitlines():
        # 方法 1：Regex
        match = BENCH_ROW_REGEX.search(line)
        if match:
            test_type = match.group("test").strip()
            ts_val = float(match.group("ts").strip())
            
            if test_type.startswith("pp"):
                results["pp_tokens_per_second"] = ts_val
            elif test_type.startswith("tg"):
                results["tg_tokens_per_second"] = ts_val
            continue

        # 方法 2：Fallback 分割 (針對某些版本格式微調)
        if line.startswith("|") and ("pp" in line.lower() or "tg" in line.lower()):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 8:
                test_type = parts[6].lower()
                ts_str = parts[7]
                # 只擷取數字部分
                num_match = re.search(r"[\d.]+", ts_str)
                if num_match:
                    try:
                        ts_val = float(num_match.group(0))
                        if "pp" in test_type:
                            results["pp_tokens_per_second"] = ts_val
                        elif "tg" in test_type:
                            results["tg_tokens_per_second"] = ts_val
                    except:
                        pass

    logger.info(f"Benchmark results: {results}")
    return results
