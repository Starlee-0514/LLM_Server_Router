"""
llama-bench 效能測試執行器

自動替換 llama-server 的路徑尋找 llama-bench，並解析 stdout 寫入資料庫。
"""
import asyncio
import logging
import re
from pathlib import Path

from backend.app.core.config import settings
from backend.app.core.process_manager import EngineType

logger = logging.getLogger(__name__)

# 正規表達式，解析 llama-bench Markdown 表格格式
# | model | size | params | backend | ngl | test | t/s | ...
# 例如：
# | llama 7B | 6.61 GiB | 7.24 B | ROCm | 99 | pp512 | 120.5 | ...
# | llama 7B | 6.61 GiB | 7.24 B | ROCm | 99 | tg128 | 34.2  | ...
BENCH_ROW_REGEX = re.compile(r"\|\s*([^|]+)\s*\|\s*[^|]+\s*\|\s*[^|]+\s*\|\s*([^|]+)\s*\|\s*(\d+)\s*\|\s*(pp\d+|tg\d+)\s*\|\s*([\d.]+)\s*\|")


def _get_bench_binary(engine_type: EngineType) -> str:
    """自動推導 llama-bench 的路徑。"""
    if engine_type == EngineType.ROCM:
        server_path = settings.llama_rocm_path
    else:
        server_path = settings.llama_vulkan_path
        
    bench_path = server_path.replace("llama-server", "llama-bench")
    if not Path(bench_path).exists():
        raise FileNotFoundError(f"找不到 llama-bench: {bench_path}")
    return bench_path


async def run_benchmark_async(
    model_name: str,
    model_path: str,
    engine_type: str = "rocm",
    n_gpu_layers: int = 999,
    batch_size: int = 512,
    ubatch_size: int = 512,
    ctx_size: int = 4096,
) -> dict[str, float]:
    """非同步執行 llama-bench 並解析輸出。

    Returns:
        {"pp_t_s": 120.5, "tg_t_s": 34.2} 或空字典
    """
    engine = EngineType(engine_type.lower())
    bench_path = _get_bench_binary(engine)

    # 執行基本的 prompt processing 512, text generation 128
    cmd = [
        bench_path,
        "-m", model_path,
        "-n", "128",   # generation tokens
        "-p", "512",   # prompt tokens
        "-ngl", str(n_gpu_layers),
        "-b", str(batch_size),
        "-ub", str(ubatch_size),
        "-c", str(ctx_size),
    ]

    env = {}
    if engine == EngineType.ROCM:
        env["HSA_OVERRIDE_GFX_VERSION"] = settings.hsa_override_gfx_version

    logger.info(f"執行 llama-bench: {' '.join(cmd)}")

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    stdout, stderr = await process.communicate()
    output = stdout.decode("utf-8")
    
    if process.returncode != 0:
        logger.error(f"llama-bench failed:\n{stderr.decode('utf-8')}")
        raise RuntimeError("llama-bench 執行失敗")

    # 解析輸出
    results = {}
    for line in output.splitlines():
        match = BENCH_ROW_REGEX.search(line)
        if match:
            test_type = match.group(4).strip() # pp512 or tg128
            ts_val = float(match.group(5).strip())
            
            if test_type.startswith("pp"):
                results["pp_tokens_per_second"] = ts_val
            elif test_type.startswith("tg"):
                results["tg_tokens_per_second"] = ts_val

    logger.info(f"Benchmark results: {results}")
    return results
