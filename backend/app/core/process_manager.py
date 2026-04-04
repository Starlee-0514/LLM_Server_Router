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
import signal
import subprocess
import time
import shutil
from pathlib import Path
from enum import Enum
from dataclasses import dataclass, field

from backend.app.core.config import settings
from backend.app.core.runtime_settings import (
    get_hsa_override_gfx_version,
    get_llama_rocm_path,
    get_llama_vulkan_path,
)

logger = logging.getLogger(__name__)


class EngineType(str, Enum):
    ROCM = "rocm"
    VULKAN = "vulkan"


@dataclass
class RunningProcess:
    """描述一個正在運行的 llama-server 進程。"""
    process: subprocess.Popen
    engine_type: EngineType
    model_path: str
    port: int
    started_at: float = field(default_factory=time.time)
    pid: int = 0

    def __post_init__(self):
        self.pid = self.process.pid


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

    def _allocate_port(self) -> int:
        """自動尋找下一個未被佔用的 Port。"""
        used_ports = {p.port for p in self._active_processes.values()}
        port = self._base_port
        while port in used_ports:
            port += 1
        return port

    def _get_binary_path(self, engine_type: EngineType) -> str:
        """根據引擎類型取得對應的 llama-server 二進位檔案路徑。"""
        if engine_type == EngineType.ROCM:
            server_path = get_llama_rocm_path()
        elif engine_type == EngineType.VULKAN:
            server_path = get_llama_vulkan_path()
        else:
            raise ValueError(f"不支援的引擎類型: {engine_type}")

        if server_path.startswith("~/"):
            server_path = str(Path(server_path).expanduser())

        if not shutil.which(server_path):
            if Path(server_path).is_dir():
                server_path = str(Path(server_path) / "llama-server")
                if not shutil.which(server_path) and not Path(server_path).exists():
                    raise FileNotFoundError(f"找不到 llama-server 二進位檔: {server_path}")
            else:
                raise FileNotFoundError(f"找不到 llama-server: {server_path} (請確認在 PATH 內或輸入完整路徑)")

        return server_path

    def _build_env(self, engine_type: EngineType) -> dict[str, str]:
        """建構子進程的環境變數。"""
        env = os.environ.copy()

        # ROCm 需要 HSA_OVERRIDE_GFX_VERSION
        if engine_type == EngineType.ROCM:
            hsa_override = get_hsa_override_gfx_version()
            env["HSA_OVERRIDE_GFX_VERSION"] = hsa_override
            logger.info(
                f"注入環境變數: HSA_OVERRIDE_GFX_VERSION={hsa_override}"
            )

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

    def start_server(
        self,
        identifier: str,
        model_path: str,
        engine_type: EngineType | str = EngineType.ROCM,
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

        # 確保 engine_type 是 Enum
        if isinstance(engine_type, str):
            engine_type = EngineType(engine_type.lower())

        port = self._allocate_port()
        binary_path = self._get_binary_path(engine_type)
        env = self._build_env(engine_type)
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

        logger.info(f"啟動 llama-server [{identifier}]: {' '.join(cmd)}")

        try:
            process = subprocess.Popen(
                cmd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except OSError as e:
            raise RuntimeError(f"啟動失敗: {e}\n指令: {cmd}")

        rp = RunningProcess(
            process=process,
            engine_type=engine_type,
            model_path=model_path,
            port=port,
        )
        self._active_processes[identifier] = rp

        logger.info(
            f"[{identifier}] llama-server 已啟動 (PID={process.pid}, "
            f"engine={engine_type.value}, port={port})"
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
            "engine_type": rp.engine_type.value,
            "model_path": rp.model_path,
            "port": rp.port,
            "uptime_seconds": round(uptime, 2),
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


# 全域單例
llama_process_manager = LlamaProcessManager()
