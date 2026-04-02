"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getStatus, getHealth, getModelGroups, type AllProcessesStatus, type ModelGroup } from "@/lib/api";

export default function DashboardPage() {
  const [status, setStatus] = useState<AllProcessesStatus | null>(null);
  const [health, setHealth] = useState<{ service: string; version: string; status: string } | null>(null);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    getStatus().then(setStatus).catch((e) => setError(e.message));
    getHealth().then(setHealth).catch(() => {});
    getModelGroups().then(setGroups).catch(() => {});
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4 mb-8">
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
                GPU Target
              </CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-lg font-semibold">890M</span>
              <p className="text-xs text-muted-foreground mt-1">64GB Unified · Strix Point</p>
            </CardContent>
          </Card>
        </div>

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
