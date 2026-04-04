"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  getStatus,
  getHealth,
  getModelGroups,
  getRequestMetrics,
  getSystemMetrics,
  getRecentBenchmarks,
  type AllProcessesStatus,
  type ModelGroup,
  type RequestMetrics,
  type SystemMetrics,
  type RecentBenchmarkItem,
} from "@/lib/api";

export default function DashboardPage() {
  const [status, setStatus] = useState<AllProcessesStatus | null>(null);
  const [health, setHealth] = useState<{ service: string; version: string; status: string } | null>(null);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [requestMetrics, setRequestMetrics] = useState<RequestMetrics | null>(null);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [recentBenchmarks, setRecentBenchmarks] = useState<RecentBenchmarkItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [statusData, healthData, groupsData, requestData, systemData, benchmarkData] = await Promise.all([
        getStatus(),
        getHealth(),
        getModelGroups(),
        getRequestMetrics(),
        getSystemMetrics(),
        getRecentBenchmarks(5),
      ]);
      setStatus(statusData);
      setHealth(healthData);
      setGroups(groupsData);
      setRequestMetrics(requestData);
      setSystemMetrics(systemData);
      setRecentBenchmarks(benchmarkData);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to refresh dashboard data");
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (seconds: number | null) => {
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  };

  const formatBytes = (bytes: number | null) => {
    if (bytes === null || bytes === undefined) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            系統總覽與運行中的模型
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            ⚠ 無法連線到後端: {error}
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4 mb-4">
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Backend Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${health ? "bg-emerald-500 shadow-lg shadow-emerald-500/50 animate-pulse" : "bg-red-500"}`} />
                <span className="text-lg font-semibold">{health ? "Online" : "Offline"}</span>
              </div>
              {health && <p className="text-xs text-muted-foreground mt-1">v{health.version}</p>}
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Active Models
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
                {status?.active_count ?? 0}
              </span>
              <p className="text-xs text-muted-foreground mt-1">running processes</p>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Saved Groups
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold">{groups.length}</span>
              <p className="text-xs text-muted-foreground mt-1">model presets</p>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                GPU Usage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold">
                {systemMetrics?.gpu.busy_percent !== null && systemMetrics?.gpu.busy_percent !== undefined
                  ? `${systemMetrics.gpu.busy_percent}%`
                  : "—"}
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                VRAM {formatBytes(systemMetrics?.gpu.vram_used_bytes ?? null)} / {formatBytes(systemMetrics?.gpu.vram_total_bytes ?? null)}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 mb-8">
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Memory Usage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold">
                {systemMetrics?.memory.used_percent !== null && systemMetrics?.memory.used_percent !== undefined
                  ? `${systemMetrics.memory.used_percent.toFixed(1)}%`
                  : "—"}
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                {formatBytes(systemMetrics?.memory.used_bytes ?? null)} / {formatBytes(systemMetrics?.memory.total_bytes ?? null)}
              </p>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                API Requests Today
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold">{requestMetrics?.total ?? 0}</span>
              <p className="text-xs text-muted-foreground mt-1">
                Local {(((requestMetrics?.local_ratio ?? 0) * 100).toFixed(0))}% / Remote {(((requestMetrics?.remote_ratio ?? 0) * 100).toFixed(0))}%
              </p>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Recent Benchmarks
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold">{recentBenchmarks.length}</span>
              <p className="text-xs text-muted-foreground mt-1">latest test records</p>
            </CardContent>
          </Card>
        </div>

        <h2 className="text-lg font-semibold mb-4">Recent Benchmark Summary</h2>
        {recentBenchmarks.length > 0 ? (
          <div className="rounded-lg border border-border/40 overflow-hidden mb-8">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Model</th>
                  <th className="px-4 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Engine</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">PP t/s</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">TG t/s</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {recentBenchmarks.map((row) => (
                  <tr key={row.id} className="hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3 text-xs font-medium">{row.model_name}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant="outline" className="uppercase text-[10px]">{row.engine_type}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{row.pp_tokens_per_second?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">{row.tg_tokens_per_second?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">{row.created_at ? new Date(row.created_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Card className="border-dashed border-border/40 bg-card/30 mb-8">
            <CardContent className="py-8 text-sm text-muted-foreground text-center">
              No recent benchmark records yet.
            </CardContent>
          </Card>
        )}

        {/* Running Processes */}
        <h2 className="text-lg font-semibold mb-4">Running Processes</h2>
        {status?.processes && status.processes.length > 0 ? (
          <div className="grid gap-3">
            {status.processes.map((proc) => (
              <Card key={proc.identifier} className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-4">
                    <div className="h-3 w-3 rounded-full bg-emerald-500 shadow-lg shadow-emerald-500/50 animate-pulse" />
                    <div>
                      <p className="font-semibold text-sm">{proc.identifier}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate max-w-md">{proc.model_path}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary" className="font-mono text-xs">
                      PID {proc.pid}
                    </Badge>
                    <Badge variant="outline" className="uppercase text-xs">
                      {proc.engine_type}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-xs">
                      :{proc.port}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatUptime(proc.uptime_seconds)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="border-dashed border-border/40 bg-card/30">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-muted-foreground text-sm">No models are currently running.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Go to <span className="font-semibold text-foreground">Models</span> to start one.
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
