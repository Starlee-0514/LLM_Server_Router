"""
LlamaProcessManager - llama-server 進程管理器

負責：
  - 組裝 llama-server 指令列（含模型路徑、引擎參數）
  - 注入環境變數（HSA_OVERRIDE_GFX_VERSION 等）
  - 以 subprocess.Popen 啟動/停止背景進程
  - 追蹤 PID、運行時間與狀態
"""
import logging
import os
import shlex
import subprocess
import time
import shutil
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from dataclasses import dataclass, field

from backend.app.core.config import settings
from backend.app.core.runtime_settings import get_runtime_command

logger = logging.getLogger(__name__)

_EARLY_EXIT_GRACE_SECONDS = 2.0
_RISKY_STARTUP_FLAGS = {
    "--flash-attn",
    "--cont-batching",
    "--no-kv-offload",
    "--parallel",
    "--cache-type-k",
    "--cache-type-v",
    "--threads-batch",
    "--tensor-split",
}
_FLAGS_WITH_VALUES = {
    "--parallel",
    "--cache-type-k",
    "--cache-type-v",
    "--threads",
    "--threads-batch",
    "--tensor-split",
    "--mmproj",
}


@dataclass
class RunningProcess:
    """描述一個正在運行的 llama-server 進程。"""
    process: subprocess.Popen
    engine_type: str
    model_path: str
    port: int
    started_at: float = field(default_factory=time.time)
    pid: int = 0
    phase: str = "starting"
    recent_output: deque = field(default_factory=lambda: deque(maxlen=50))
    _reader_thread: threading.Thread | None = field(default=None, repr=False)

    def __post_init__(self):
        self.pid = self.process.pid


# Patterns to detect llama-server phases from stderr output
_PHASE_PATTERNS: list[tuple[str, str]] = [
    ("llm_load_vocab", "loading vocabulary"),
    ("llm_load_tensors", "loading model tensors"),
    ("llm_load_print_meta", "loading model metadata"),
    ("warming up", "warming up"),
    ("server listening", "ready"),
    ("listening on", "ready"),
    ("slot is processing", "processing prompt"),
    ("slot update_slots", "generating"),
    ("slot released", "ready"),
    ("generate_response", "generating"),
    ("prompt eval time", "ready"),
    ("eval time", "ready"),
]


def _detect_phase(line: str) -> str | None:
    """Return a phase name if the line matches a known pattern, else None."""
    lower = line.lower()
    for pattern, phase in _PHASE_PATTERNS:
        if pattern in lower:
            return phase
    return None


def _start_output_reader(rp: RunningProcess, identifier: str = "") -> None:
    """Start a daemon thread to read stderr and update process phase."""
    from backend.app.core.dev_logs import log_process

    def _reader():
        stderr = rp.process.stderr
        if not stderr:
            return
        try:
            for line in stderr:
                stripped = line.rstrip("\n\r")
                if stripped:
                    rp.recent_output.append(stripped)
                    log_process(identifier or str(rp.pid), stripped)
                    detected = _detect_phase(stripped)
                    if detected:
                        rp.phase = detected
        except (ValueError, OSError):
            pass  # pipe closed

    t = threading.Thread(target=_reader, daemon=True, name=f"llama-stderr-{rp.pid}")
    rp._reader_thread = t
    t.start()


class LlamaProcessManager:
    """管理多個 llama-server 進程的生命週期。

    支援同時運行多個模型，並會自動分配可用的埠號。

    Usage:
        manager = LlamaProcessManager()
        manager.start_server("my_model1", "/models/m1.gguf", EngineType.ROCM)
        status = manager.get_status("my_model1")
        manager.stop_server("my_model1")
    """

    def __init__(self):
        # identifier -> RunningProcess
        self._active_processes: dict[str, RunningProcess] = {}
        # 用於自動分配 port 的起始點
        self._base_port = settings.llama_server_port
        # Ring buffer for recent events (max 200 entries)
        self._event_log: deque[dict] = deque(maxlen=200)

    def _allocate_port(self) -> int:
        """自動尋找下一個未被佔用的 Port。"""
        used_ports = {p.port for p in self._active_processes.values()}
        port = self._base_port
        while port in used_ports:
            port += 1
        return port

    def _log_event(self, event_type: str, identifier: str, detail: str = "", **extra: object) -> None:
        """Append a timestamped event to the ring buffer."""
        self._event_log.append({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "identifier": identifier,
            "detail": detail,
            **extra,
        })

    def get_event_log(self, limit: int = 100) -> list[dict]:
        """Return the most recent *limit* events (newest first)."""
        items = list(self._event_log)
        items.reverse()
        return items[:limit]

    def _get_binary_path(self, runtime_name: str) -> tuple[str, dict[str, str]]:
        """根據運行時名稱取得 llama-server 執行檔路徑與環境變數。"""
        server_path, runtime_env = get_runtime_command(runtime_name)

        if server_path.startswith("~/"):
            server_path = str(Path(server_path).expanduser())

        if not shutil.which(server_path):
            if Path(server_path).is_dir():
                server_path = str(Path(server_path) / "llama-server")
                if not shutil.which(server_path) and not Path(server_path).exists():
                    raise FileNotFoundError(f"找不到 llama-server 二進位檔: {server_path}")
            else:
                raise FileNotFoundError(f"找不到 llama-server: {server_path} (請確認在 PATH 內或輸入完整路徑)")

        return server_path, runtime_env

    def _build_env(self, runtime_env: dict[str, str]) -> dict[str, str]:
        """建構子進程的環境變數。"""
        env = os.environ.copy()

        for key, value in runtime_env.items():
            env[key] = value
            logger.info("注入運行時環境變數: %s=%s", key, value)

        return env

    def _build_command(
        self,
        binary_path: str,
        model_path: str,
        port: int,
        n_gpu_layers: int = 999,
        batch_size: int = 512,
        ubatch_size: int = 512,
        ctx_size: int = 4096,
        extra_args: list[str] | None = None,
    ) -> list[str]:
        """組裝 llama-server 啟動指令。"""
        cmd = [
            binary_path,
            "--model", model_path,
            "--port", str(port),
            "--n-gpu-layers", str(n_gpu_layers),
            "--batch-size", str(batch_size),
            "--ubatch-size", str(ubatch_size),
            "--ctx-size", str(ctx_size),
            "--host", "0.0.0.0",
        ]

        if extra_args:
            cmd.extend(extra_args)

        return cmd

    def _collect_process_output(self, process: subprocess.Popen) -> tuple[str, str]:
        stdout_text = ""
        stderr_text = ""
        if process.stdout:
            try:
                stdout_text = process.stdout.read() or ""
            except Exception:
                stdout_text = ""
        if process.stderr:
            try:
                stderr_text = process.stderr.read() or ""
            except Exception:
                stderr_text = ""
        return stdout_text.strip(), stderr_text.strip()

    def _await_early_exit(self, process: subprocess.Popen, grace_seconds: float = _EARLY_EXIT_GRACE_SECONDS) -> tuple[int, str, str] | None:
        deadline = time.time() + grace_seconds
        while time.time() < deadline:
            return_code = process.poll()
            if return_code is not None:
                stdout_text, stderr_text = self._collect_process_output(process)
                return return_code, stdout_text, stderr_text
            time.sleep(0.15)
        return None

    def _strip_risky_startup_args(self, extra_args: list[str] | None) -> list[str]:
        if not extra_args:
            return []

        safe_args: list[str] = []
        index = 0
        while index < len(extra_args):
            token = extra_args[index]
            if token in _RISKY_STARTUP_FLAGS:
                if token in _FLAGS_WITH_VALUES and index + 1 < len(extra_args):
                    index += 2
                    continue
                index += 1
                continue
            safe_args.append(token)
            if token in _FLAGS_WITH_VALUES and index + 1 < len(extra_args):
                safe_args.append(extra_args[index + 1])
                index += 2
                continue
            index += 1
        return safe_args

    def _launch_process(self, cmd: list[str], env: dict[str, str]) -> subprocess.Popen:
        try:
            return subprocess.Popen(
                cmd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except OSError as e:
            raise RuntimeError(f"啟動失敗: {e}\n指令: {shlex.join(cmd)}")

    def start_server(
        self,
        identifier: str,
        model_path: str,
        engine_type: str = "rocm",
        n_gpu_layers: int = 999,
        batch_size: int = 512,
        ubatch_size: int = 512,
        ctx_size: int = 4096,
        extra_args: list[str] | None = None,
    ) -> RunningProcess:
        """啟動一個 llama-server 進程。

        如果已存在相同 identifier 的進程，發出錯誤。

        Args:
            identifier: 唯一標識符（例如模型檔名）
            model_path: .gguf 模型檔案路徑
            engine_type: 引擎類型 ("rocm" | "vulkan")
            n_gpu_layers: GPU layer 數量
            batch_size: batch size
            ubatch_size: micro-batch size
            ctx_size: context size
            extra_args: 額外的 CLI 參數

        Returns:
            RunningProcess 描述啟動的進程
        """
        # 清理已自行結束的 zombie 進程
        self._cleanup_dead_processes()

        if identifier in self._active_processes:
            raise ValueError(f"進程 {identifier} 已經在運行中，請勿重複啟動。")

        runtime_name = engine_type.strip()
        if not runtime_name:
            raise ValueError("運行時名稱不可為空")

        port = self._allocate_port()
        binary_path, runtime_env = self._get_binary_path(runtime_name)
        env = self._build_env(runtime_env)
        cmd = self._build_command(
            binary_path=binary_path,
            model_path=model_path,
            port=port,
            n_gpu_layers=n_gpu_layers,
            batch_size=batch_size,
            ubatch_size=ubatch_size,
            ctx_size=ctx_size,
            extra_args=extra_args,
        )

        logger.info("啟動 llama-server [%s]: %s", identifier, shlex.join(cmd))
        self._log_event("launch", identifier, detail=shlex.join(cmd), engine=runtime_name, port=port)
        process = self._launch_process(cmd, env)

        early_exit = self._await_early_exit(process)
        if early_exit is not None:
            return_code, stdout_text, stderr_text = early_exit
            fallback_args = self._strip_risky_startup_args(extra_args)
            if fallback_args != (extra_args or []):
                fallback_cmd = self._build_command(
                    binary_path=binary_path,
                    model_path=model_path,
                    port=port,
                    n_gpu_layers=n_gpu_layers,
                    batch_size=batch_size,
                    ubatch_size=ubatch_size,
                    ctx_size=ctx_size,
                    extra_args=fallback_args,
                )
                logger.warning(
                    "[%s] llama-server 啟動後立即退出 (rc=%s)，改用安全參數重試: %s",
                    identifier,
                    return_code,
                    shlex.join(fallback_cmd),
                )
                self._log_event("retry", identifier, detail=shlex.join(fallback_cmd), rc=return_code)
                process = self._launch_process(fallback_cmd, env)
                early_exit = self._await_early_exit(process)
                if early_exit is None:
                    extra_args = fallback_args
                else:
                    return_code, stdout_text, stderr_text = early_exit

            if early_exit is not None:
                detail = stderr_text or stdout_text or "llama-server 在啟動後立即退出，沒有輸出更多資訊。"
                self._log_event("error", identifier, detail=detail[-500:], rc=return_code)
                raise RuntimeError(
                    f"llama-server 啟動失敗 (return code={return_code})\n"
                    f"指令: {shlex.join(cmd)}\n"
                    f"輸出: {detail[-1500:]}"
                )

        rp = RunningProcess(
            process=process,
            engine_type=runtime_name,
            model_path=model_path,
            port=port,
        )
        self._active_processes[identifier] = rp
        _start_output_reader(rp, identifier)

        self._log_event("running", identifier, detail=f"PID={process.pid}", pid=process.pid, engine=runtime_name, port=port)
        logger.info(
            f"[{identifier}] llama-server 已啟動 (PID={process.pid}, "
            f"engine={runtime_name}, port={port})"
        )

        return rp

    def stop_server(self, identifier: str) -> bool:
        """停止指定的 llama-server 進程。"""
        if identifier not in self._active_processes:
            logger.info(f"進程 {identifier} 不存在或未運行")
            return False

        rp = self._active_processes[identifier]
        proc = rp.process
        pid = rp.pid

        self._log_event("stop", identifier, detail=f"PID={pid}")
        try:
            # 先嘗試 graceful shutdown (SIGTERM)
            proc.terminate()
            try:
                proc.wait(timeout=10)
                logger.info(f"[{identifier}] llama-server (PID={pid}) 已優雅停止")
            except subprocess.TimeoutExpired:
                # 超時則強制結束 (SIGKILL)
                logger.warning(f"[{identifier}] SIGTERM 超時，強制結束 PID={pid}")
                proc.kill()
                proc.wait(timeout=5)
                logger.info(f"[{identifier}] llama-server (PID={pid}) 已強制停止")
        except ProcessLookupError:
            logger.warning(f"[{identifier}] 進程 PID={pid} 已不存在")
        finally:
            del self._active_processes[identifier]

        return True

    def stop_all(self):
        """停止所有運行的進程。"""
        identifiers = list(self._active_processes.keys())
        for idf in identifiers:
            self.stop_server(idf)

    def _cleanup_dead_processes(self):
        """內部方法：清理已經自行退出（崩潰或主動結束）的 process。"""
        dead_ids = []
        for idf, rp in list(self._active_processes.items()):
            if rp.process.poll() is not None:
                dead_ids.append(idf)
                self._log_event("exited", idf, detail=f"rc={rp.process.returncode}", rc=rp.process.returncode, pid=rp.pid)
                logger.info(
                    f"[{idf}] llama-server (PID={rp.pid}) 已經自行退出 "
                    f"(return code={rp.process.returncode})"
                )
        for dead_id in dead_ids:
            del self._active_processes[dead_id]

    def get_status(self, identifier: str) -> dict:
        """取得單一進程狀態。"""
        self._cleanup_dead_processes()
        if identifier not in self._active_processes:
            return {
                "identifier": identifier,
                "is_running": False,
                "pid": None,
                "engine_type": None,
                "model_path": None,
                "port": None,
                "uptime_seconds": None,
            }

        rp = self._active_processes[identifier]
        uptime = time.time() - rp.started_at

        return {
            "identifier": identifier,
            "is_running": True,
            "pid": rp.pid,
            "engine_type": rp.engine_type,
            "model_path": rp.model_path,
            "port": rp.port,
            "uptime_seconds": round(uptime, 2),
            "phase": rp.phase,
            "recent_output": list(rp.recent_output)[-10:],
        }

    def get_all_status(self) -> list[dict]:
        """取得所有運行中的進程狀態。"""
        self._cleanup_dead_processes()
        return [self.get_status(idf) for idf in self._active_processes.keys()]

    def get_router_port_for_model(self, search_term: str) -> int | None:
        """給定尋找詞（檔名或路徑的一部分），回傳其對應的 port。
        用於 OpenAI api router 轉發時導向正確的背景服務。
        """
        self._cleanup_dead_processes()
        for idf, rp in self._active_processes.items():
            if search_term in idf or search_term in rp.model_path:
                return rp.port
        return None

    def get_first_running_process(self) -> tuple[str, int] | None:
        """回傳第一個正在運行中的 process 的 (identifier, port)，無則回傳 None。

        用於 local_process 路由找不到名稱對應的 process 時的 fallback。
        當用戶以邏輯別名（如 Local_Model_62k）設定 Route 但 process manager
        以不同 identifier 啟動了模型時，允許路由仍能指向實際在跑的 process。
        """
        self._cleanup_dead_processes()
        for idf, rp in self._active_processes.items():
            return idf, rp.port
        return None


# 全域單例
llama_process_manager = LlamaProcessManager()
