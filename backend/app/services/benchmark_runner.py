"""
llama-bench 效能測試執行器

自動替換 llama-server 的路徑尋找 llama-bench，並解析 stdout 寫入資料庫。
支援即時串流輸出 (SSE) 與批次執行。
"""
import asyncio
import json
import logging
import re
import shutil
from pathlib import Path
from typing import AsyncGenerator

from backend.app.core.process_manager import EngineType
from backend.app.core.runtime_settings import (
    get_hsa_override_gfx_version,
    get_llama_rocm_path,
    get_llama_vulkan_path,
)

logger = logging.getLogger(__name__)

# 正規表達式，解析 llama-bench Markdown 表格格式
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
        server_path = get_llama_rocm_path()
    else:
        server_path = get_llama_vulkan_path()
        
    bench_path = server_path.replace("llama-server", "llama-bench")
    
    if bench_path.startswith("~/"):
        bench_path = str(Path(bench_path).expanduser())
        
    if not shutil.which(bench_path):
        if Path(bench_path).is_dir():
            bench_path = str(Path(bench_path) / "llama-bench")
            if not shutil.which(bench_path) and not Path(bench_path).exists():
                raise FileNotFoundError(f"找不到 llama-bench 二進位檔: {bench_path}")
        else:
            raise FileNotFoundError(f"找不到 llama-bench: {bench_path} (請確認在 PATH 內或輸入完整路徑)")
            
    return bench_path


def _build_cmd(
    bench_path: str,
    model_path: str,
    n_gpu_layers: int,
    batch_size: int,
    ubatch_size: int,
    n_prompt: int,
    n_gen: int,
    flash_attn: int,
    no_kv_offload: int,
) -> list[str]:
    """Build the llama-bench command list."""
    return [
        bench_path,
        "-m", model_path,
        "-n", str(n_gen),
        "-p", str(n_prompt),
        "-ngl", str(n_gpu_layers),
        "-b", str(batch_size),
        "-ub", str(ubatch_size),
        "-fa", str(flash_attn),
        "-nkvo", str(no_kv_offload),
        "--progress",
    ]


def parse_results(stdout_text: str) -> dict:
    """Parse llama-bench stdout for pp/tg tokens per second."""
    results: dict = {}
    for line in stdout_text.splitlines():
        match = BENCH_ROW_REGEX.search(line)
        if match:
            test_type = match.group("test").strip()
            ts_val = float(match.group("ts").strip())
            if test_type.startswith("pp"):
                results["pp_tokens_per_second"] = ts_val
            elif test_type.startswith("tg"):
                results["tg_tokens_per_second"] = ts_val
            continue

        # Fallback
        if line.startswith("|") and ("pp" in line.lower() or "tg" in line.lower()):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 8:
                test_type = parts[6].lower()
                ts_str = parts[7]
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
    return results


async def run_benchmark_stream(
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
) -> AsyncGenerator[str, None]:
    """串流執行 llama-bench，即時 yield SSE 事件。

    Events:
      event: log   data: {"line": "..."}        — 即時 log 行
      event: done  data: {"results": {...}}     — 完成，含解析結果
      event: error data: {"error": "..."}       — 錯誤
    """
    engine = EngineType(engine_type.lower())

    try:
        bench_path = _get_bench_binary(engine)
    except FileNotFoundError as e:
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
        return

    cmd = _build_cmd(bench_path, model_path, n_gpu_layers, batch_size,
                     ubatch_size, n_prompt, n_gen, flash_attn, no_kv_offload)

    env = {}
    if engine == EngineType.ROCM:
        env["HSA_OVERRIDE_GFX_VERSION"] = get_hsa_override_gfx_version()

    cmd_str = " ".join(cmd)
    logger.info(f"執行 llama-bench (streaming): {cmd_str}")

    # Emit the command itself
    yield f"event: log\ndata: {json.dumps({'line': f'$ {cmd_str}'})}\n\n"

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )

    stdout_lines: list[str] = []
    full_log_lines: list[str] = [f"$ {cmd_str}"]

    async def _read_stream(stream, label: str):
        """Read a stream line by line."""
        while True:
            raw = await stream.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\n\r")
            yield (label, line)

    # Read stderr and stdout concurrently by merging into a single queue
    queue: asyncio.Queue[tuple[str, str] | None] = asyncio.Queue()

    async def _reader(stream, label: str):
        while True:
            raw = await stream.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\n\r")
            await queue.put((label, line))
        await queue.put(None)  # sentinel

    # Start readers for both streams
    readers = [
        asyncio.create_task(_reader(process.stderr, "stderr")),
        asyncio.create_task(_reader(process.stdout, "stdout")),
    ]

    finished_count = 0
    while finished_count < 2:
        item = await queue.get()
        if item is None:
            finished_count += 1
            continue
        label, line = item
        full_log_lines.append(line)
        if label == "stdout":
            stdout_lines.append(line)
        # Emit every line to frontend in real-time
        yield f"event: log\ndata: {json.dumps({'line': line})}\n\n"

    await asyncio.gather(*readers)
    await process.wait()

    full_log = "\n".join(full_log_lines)
    stdout_text = "\n".join(stdout_lines)

    if process.returncode != 0:
        error_msg = f"llama-bench exited with code {process.returncode}"
        logger.error(error_msg)
        yield f"event: error\ndata: {json.dumps({'error': error_msg, 'raw_output': full_log})}\n\n"
        return

    # Parse results
    results = parse_results(stdout_text)
    results["raw_output"] = full_log

    logger.info(f"Benchmark results: pp={results.get('pp_tokens_per_second')}, tg={results.get('tg_tokens_per_second')}")

    yield f"event: done\ndata: {json.dumps(results)}\n\n"


# Keep the non-streaming version for backward compatibility / import usage
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
    """非同步執行 llama-bench 並解析輸出（非串流版本）。"""
    engine = EngineType(engine_type.lower())
    bench_path = _get_bench_binary(engine)

    cmd = _build_cmd(bench_path, model_path, n_gpu_layers, batch_size,
                     ubatch_size, n_prompt, n_gen, flash_attn, no_kv_offload)

    env = {}
    if engine == EngineType.ROCM:
        env["HSA_OVERRIDE_GFX_VERSION"] = get_hsa_override_gfx_version()

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

    results = parse_results(stdout_text)
    results["raw_output"] = full_log

    logger.info(f"Benchmark results: {results}")
    return results
