"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getDevEvents,
  getDevLogs,
  getDevProcesses,
  getDevCompletions,
  getLogFiles,
  getLogFileUrl,
  type DevEvent,
  type DevLogEntry,
  type DevProcessDetail,
  type CompletionRecord,
  type LogFileInfo,
} from "@/lib/api";

const eventBadgeColor: Record<string, string> = {
  launch: "bg-blue-500/15 text-blue-300 border-blue-400/30",
  running: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  stop: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-400/30",
  retry: "bg-violet-500/15 text-violet-300 border-violet-400/30",
  exited: "bg-slate-500/15 text-slate-300 border-slate-400/30",
};

const logBadgeColor: Record<string, string> = {
  DEBUG: "bg-slate-500/15 text-slate-300 border-slate-400/30",
  INFO: "bg-cyan-500/15 text-cyan-300 border-cyan-400/30",
  WARNING: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  ERROR: "bg-rose-500/15 text-rose-300 border-rose-400/30",
  CRITICAL: "bg-rose-600/20 text-rose-200 border-rose-300/40",
};

export default function DevPage() {
  const [events, setEvents] = useState<DevEvent[]>([]);
  const [logs, setLogs] = useState<DevLogEntry[]>([]);
  const [processes, setProcesses] = useState<DevProcessDetail[]>([]);
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [completions, setCompletions] = useState<CompletionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [evts, procs, serviceLogs, files, comps] = await Promise.all([
        getDevEvents(200),
        getDevProcesses(),
        getDevLogs(250),
        getLogFiles().catch(() => []),
        getDevCompletions(30).catch(() => []),
      ]);
      setEvents(evts);
      setProcesses(procs);
      setLogs(serviceLogs);
      setLogFiles(files);
      setCompletions(comps);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dev data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!autoRefresh) return;
    const interval = window.setInterval(refresh, 3000);
    return () => window.clearInterval(interval);
  }, [refresh, autoRefresh]);

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour12: false });
    } catch {
      return iso;
    }
  };

  const formatUptime = (seconds: number | null) => {
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  };

  const phaseProgress: Record<string, number> = {
    starting: 5,
    "loading vocabulary": 15,
    "loading model metadata": 25,
    "loading model tensors": 50,
    "warming up": 80,
    "processing prompt": 90,
    generating: 95,
    ready: 100,
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dev Monitor</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Backend process events, service commands, and live benchmark progress
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-white/10">{events.length} events</Badge>
            <Badge className="bg-emerald-500/15 text-emerald-300">{processes.length} active</Badge>
            <Badge className="bg-cyan-500/15 text-cyan-300">{logs.length} logs</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoRefresh((prev) => !prev)}
            >
              {autoRefresh ? "Pause" : "Resume"}
            </Button>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? "..." : "Refresh"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Active Processes */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Active Processes</CardTitle>
          </CardHeader>
          <CardContent>
            {processes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active processes.</p>
            ) : (
              <div className="space-y-3">
                {processes.map((proc) => (
                  <div
                    key={proc.identifier}
                    className="rounded-md border border-border/40 bg-muted/20 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{proc.identifier}</p>
                        <p className="text-xs text-muted-foreground">
                          PID {proc.pid} · {proc.engine_type} · port {proc.port} · up {formatUptime(proc.uptime_seconds)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {proc.phase && (
                          <Badge className={
                            proc.phase === "ready" ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" :
                            proc.phase === "loading" ? "bg-amber-500/15 text-amber-300 border-amber-400/30" :
                            proc.phase === "error" ? "bg-red-500/15 text-red-300 border-red-400/30" :
                            "bg-blue-500/15 text-blue-300 border-blue-400/30"
                          }>
                            {proc.phase}
                          </Badge>
                        )}
                        <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-400/30">
                          Running
                        </Badge>
                      </div>
                    </div>
                    {proc.phase && proc.phase !== "ready" && (
                      <div className="mt-2">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                          <span>{proc.phase}</span>
                          <span>{phaseProgress[proc.phase] ?? 0}%</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-muted/30 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-blue-500 transition-all duration-700"
                            style={{ width: `${phaseProgress[proc.phase] ?? 0}%` }}
                          />
                        </div>
                      </div>
                    )}
                    {proc.command && (
                      <pre className="mt-2 max-h-20 overflow-auto rounded border border-border/40 bg-background/50 p-2 text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
                        {proc.command}
                      </pre>
                    )}
                    {proc.model_path && (
                      <p className="mt-1 text-[11px] text-muted-foreground font-mono truncate">
                        model: {proc.model_path}
                      </p>
                    )}
                    {proc.recent_output && proc.recent_output.length > 0 && (
                      <div className="mt-2 rounded border border-border/40 bg-background/50 p-2">
                        <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1">Recent Output</p>
                        <pre className="max-h-28 overflow-auto text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all">
                          {proc.recent_output.join("\n")}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Event Log */}
        {/* Recent Completions — shows prompt input, tokens, speed */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Recent Completions</CardTitle>
          </CardHeader>
          <CardContent>
            {completions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No completions recorded yet. Send a chat message to see data here.</p>
            ) : (
              <div className="max-h-[420px] space-y-2 overflow-y-auto">
                {completions.map((c, i) => {
                  const tps = c.elapsed > 0 ? (c.completion_tokens / c.elapsed).toFixed(1) : "—";
                  return (
                    <div
                      key={`${c.timestamp}-${i}`}
                      className="rounded-md border border-border/40 bg-muted/20 p-3 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-violet-500/15 text-violet-300 border-violet-400/30 text-[10px]">
                            {c.model}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">{formatTime(c.timestamp)}</span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] font-mono">
                          <span className="text-cyan-400" title="Prompt tokens">P:{c.prompt_tokens}</span>
                          <span className="text-emerald-400" title="Completion tokens">C:{c.completion_tokens}</span>
                          <span className="text-slate-300" title="Total tokens">T:{c.total_tokens}</span>
                          <span className="text-amber-400" title="Tokens per second">{tps} t/s</span>
                          <span className="text-slate-400" title="Elapsed time">{c.elapsed}s</span>
                        </div>
                      </div>
                      {c.prompt_preview && (
                        <div className="mt-1">
                          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Prompt: </span>
                          <span className="text-[11px] text-slate-300 italic">&quot;{c.prompt_preview}&quot;</span>
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground truncate" title={c.target}>
                        → {c.target}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Process Event Log */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Process Event Log</CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events recorded yet. Launch a model to see activity.</p>
            ) : (
              <div className="max-h-[600px] space-y-1 overflow-y-auto font-mono text-xs">
                {events.map((evt, i) => (
                  <div
                    key={`${evt.timestamp}-${i}`}
                    className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/20"
                  >
                    <span className="shrink-0 text-muted-foreground w-[72px]">
                      {formatTime(evt.timestamp)}
                    </span>
                    <Badge className={`shrink-0 text-[10px] px-1.5 py-0 ${eventBadgeColor[evt.type] ?? "bg-white/10"}`}>
                      {evt.type}
                    </Badge>
                    <span className="shrink-0 font-semibold w-[200px] truncate" title={evt.identifier}>
                      {evt.identifier}
                    </span>
                    <span className="text-muted-foreground break-all">{evt.detail}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mt-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Backend Service Log</CardTitle>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No backend log lines captured yet.</p>
            ) : (
              <div className="max-h-[520px] space-y-1 overflow-y-auto font-mono text-xs">
                {logs.map((entry, index) => {
                  const isCompletion = entry.message.startsWith("[Completion]");
                  const isAutoBench = entry.message.startsWith("[AutoBench]");
                  return (
                  <div
                    key={`${entry.timestamp}-${entry.logger}-${index}`}
                    className={`rounded px-2 py-2 hover:bg-muted/20 ${
                      isCompletion ? "border-l-2 border-emerald-500/60 bg-emerald-500/5" :
                      isAutoBench ? "border-l-2 border-blue-500/60 bg-blue-500/5" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="shrink-0 text-muted-foreground w-[72px]">
                        {formatTime(entry.timestamp)}
                      </span>
                      <Badge className={`shrink-0 text-[10px] px-1.5 py-0 ${logBadgeColor[entry.level] ?? "bg-white/10"}`}>
                        {entry.level}
                      </Badge>
                      {isCompletion && (
                        <Badge className="shrink-0 text-[10px] px-1.5 py-0 bg-emerald-500/15 text-emerald-300 border-emerald-400/30">
                          completion
                        </Badge>
                      )}
                      {isAutoBench && (
                        <Badge className="shrink-0 text-[10px] px-1.5 py-0 bg-blue-500/15 text-blue-300 border-blue-400/30">
                          bench
                        </Badge>
                      )}
                      <span className="text-[11px] text-slate-400">{entry.logger}</span>
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap break-all text-[11px] text-slate-200">
                      {entry.message}
                    </pre>
                  </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Persistent Log Files */}
        <Card className="mt-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Persistent Log Files</CardTitle>
          </CardHeader>
          <CardContent>
            {logFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No log files yet. Logs appear after first API call or process launch.</p>
            ) : (
              <div className="space-y-2">
                {logFiles.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-medium">{f.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {(f.size_bytes / 1024).toFixed(1)} KB · modified {formatTime(f.modified)}
                      </p>
                    </div>
                    <a
                      href={getLogFileUrl(f.name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-400 hover:text-blue-300 underline"
                    >
                      Download
                    </a>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
