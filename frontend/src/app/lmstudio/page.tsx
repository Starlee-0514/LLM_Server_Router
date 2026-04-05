"use client";

import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getLMStudioCliStatus,
  getLMStudioStatus,
  lmStudioModelLoad,
  lmStudioModelUnload,
  lmStudioRegisterProvider,
  lmStudioServerStart,
  lmStudioServerStop,
  type LMStudioCliCheck,
  type LMStudioCommandResult,
  type LMStudioStatus,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={[
        "inline-block size-2.5 rounded-full",
        running ? "bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]" : "bg-zinc-500",
      ].join(" ")}
    />
  );
}

function CmdOutput({ result }: { result: LMStudioCommandResult | null }) {
  if (!result) return null;
  return (
    <div
      className={[
        "mt-3 rounded-md border px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all",
        result.success
          ? "border-emerald-400/30 bg-emerald-500/5 text-emerald-300"
          : "border-red-400/30 bg-red-500/5 text-red-300",
      ].join(" ")}
    >
      <span className="font-semibold">{result.success ? "✓" : "✗"} {result.message}</span>
      {result.stdout && <div className="mt-1 opacity-70">{result.stdout.trim()}</div>}
      {result.stderr && <div className="mt-1 opacity-50">{result.stderr.trim()}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LMStudioPage() {
  const [cliCheck, setCliCheck] = useState<LMStudioCliCheck | null>(null);
  const [status, setStatus] = useState<LMStudioStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(1234);
  const [bindAddr, setBindAddr] = useState("");
  const [loadId, setLoadId] = useState("");
  const [loadGpu, setLoadGpu] = useState("");
  const [loadCtx, setLoadCtx] = useState("");
  const [unloadId, setUnloadId] = useState("");
  const [cmdResult, setCmdResult] = useState<LMStudioCommandResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [regResult, setRegResult] = useState<string | null>(null);
  const [providerName, setProviderName] = useState("LM Studio");

  // ---- probe on mount + on demand ----
  const probe = useCallback(async () => {
    setProbing(true);
    try {
      const [cli, s] = await Promise.all([
        getLMStudioCliStatus(),
        getLMStudioStatus(host, port),
      ]);
      setCliCheck(cli);
      setStatus(s);
    } catch {
      //
    } finally {
      setProbing(false);
    }
  }, [host, port]);

  useEffect(() => {
    probe();
  }, []);

  // ---- command wrapper ----
  const run = async (fn: () => Promise<LMStudioCommandResult>) => {
    setBusy(true);
    setCmdResult(null);
    try {
      const r = await fn();
      setCmdResult(r);
      await probe();
    } catch (e: any) {
      setCmdResult({ success: false, message: e.message ?? "Error", stdout: "", stderr: "" });
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async () => {
    try {
      const r = await lmStudioRegisterProvider(host, port, providerName);
      setRegResult(
        r.created
          ? `✓ Registered as provider #${r.id} (${r.name} @ ${r.base_url})`
          : `✓ Updated existing provider #${r.id}`,
      );
    } catch (e: any) {
      setRegResult(`✗ ${e.message ?? "Failed"}`);
    }
  };

  const isRunning = status?.running ?? false;
  const cliOk = cliCheck?.available ?? false;

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
              <StatusDot running={isRunning} />
              LM Studio
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage your local LM Studio server via the{" "}
              <code className="text-xs font-mono bg-muted px-1 rounded">lms</code> CLI,
              then register it as an OpenAI-compatible provider in the router.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={probe} disabled={probing}>
            {probing ? "Probing…" : "Refresh"}
          </Button>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          {/* ---- Status card ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <StatusDot running={isRunning} />
                Server Status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* CLI check */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">lms CLI installed</span>
                <Badge
                  variant="outline"
                  className={cliOk
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-400/30"
                    : "bg-red-500/10 text-red-300 border-red-400/30"}
                >
                  {cliCheck ? (cliOk ? "found" : "missing") : "…"}
                </Badge>
              </div>
              {!cliOk && cliCheck && (
                <p className="text-xs text-muted-foreground rounded bg-muted/30 px-2 py-1.5">
                  {cliCheck.message}
                </p>
              )}

              {/* Server running */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">HTTP server</span>
                <Badge
                  variant="outline"
                  className={isRunning
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-400/30"
                    : "bg-zinc-500/10 text-zinc-400 border-zinc-500/30"}
                >
                  {status ? (isRunning ? `running :${status.port}` : "stopped") : "…"}
                </Badge>
              </div>

              {/* Loaded models */}
              {isRunning && status && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Loaded models</p>
                  {status.loaded_models.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">None loaded</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {status.loaded_models.map((m) => (
                        <Badge key={m} variant="outline" className="text-[11px] font-mono">
                          {m}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Connection config */}
              <div className="pt-2 border-t border-border/30 grid grid-cols-[1fr_80px] gap-2">
                <div className="space-y-1">
                  <Label htmlFor="lms-host" className="text-xs">Host</Label>
                  <Input id="lms-host" value={host} onChange={(e) => setHost(e.target.value)} className="h-8 text-sm font-mono" placeholder="127.0.0.1" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lms-port" className="text-xs">Port</Label>
                  <Input id="lms-port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className="h-8 text-sm font-mono" placeholder="1234" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ---- Server control ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Server Control</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="lms-bind" className="text-xs">Bind address (optional)</Label>
                <Input
                  id="lms-bind"
                  value={bindAddr}
                  onChange={(e) => setBindAddr(e.target.value)}
                  placeholder="Leave blank for localhost only, or 0.0.0.0 for LAN"
                  className="h-8 text-sm font-mono"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={busy || !cliOk}
                  onClick={() => run(() => lmStudioServerStart(port, bindAddr || undefined))}
                >
                  {busy ? "Running…" : "Start Server"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !cliOk || !isRunning}
                  onClick={() => run(lmStudioServerStop)}
                >
                  Stop
                </Button>
              </div>

              {!cliOk && (
                <p className="text-xs text-amber-400/80">
                  Install the lms CLI to enable server control:{" "}
                  <code className="bg-muted px-1 rounded">npm install -g @lmstudio/lms</code>
                </p>
              )}

              <CmdOutput result={cmdResult} />
            </CardContent>
          </Card>

          {/* ---- Model load ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Load Model</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="lms-load-id" className="text-xs">Model identifier</Label>
                <Input
                  id="lms-load-id"
                  value={loadId}
                  onChange={(e) => setLoadId(e.target.value)}
                  placeholder="e.g. lmstudio-community/Qwen3-8B-GGUF"
                  className="text-sm font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use the model key from LM Studio's library — same as <code className="bg-muted px-0.5 rounded">lms load &lt;identifier&gt;</code>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="lms-gpu" className="text-xs">GPU offload (0–1, blank=auto)</Label>
                  <Input id="lms-gpu" value={loadGpu} onChange={(e) => setLoadGpu(e.target.value)} placeholder="auto" className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lms-ctx" className="text-xs">Context length (blank=default)</Label>
                  <Input id="lms-ctx" type="number" value={loadCtx} onChange={(e) => setLoadCtx(e.target.value)} placeholder="default" className="h-8 text-sm" />
                </div>
              </div>
              <Button
                className="w-full"
                disabled={busy || !cliOk || !loadId.trim()}
                onClick={() =>
                  run(() =>
                    lmStudioModelLoad(
                      loadId.trim(),
                      loadGpu ? parseFloat(loadGpu) : undefined,
                      loadCtx ? parseInt(loadCtx, 10) : undefined,
                    ),
                  )
                }
              >
                {busy ? "Loading…" : "Load Model"}
              </Button>
            </CardContent>
          </Card>

          {/* ---- Model unload ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Unload Model</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Quick-unload currently loaded models */}
              {isRunning && (status?.loaded_models.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-2">Quick unload:</p>
                  <div className="flex flex-wrap gap-1">
                    {status!.loaded_models.map((m) => (
                      <button
                        key={m}
                        disabled={busy || !cliOk}
                        onClick={() => run(() => lmStudioModelUnload(m))}
                        className="rounded border border-border/40 bg-muted/20 px-2 py-1 text-[11px] font-mono hover:bg-accent transition-colors disabled:opacity-50 cursor-pointer"
                      >
                        ✕ {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="lms-unload-id" className="text-xs">Identifier (optional)</Label>
                <Input
                  id="lms-unload-id"
                  value={unloadId}
                  onChange={(e) => setUnloadId(e.target.value)}
                  placeholder="Leave blank with 'Unload All'"
                  className="text-sm font-mono"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={busy || !cliOk || !unloadId.trim()}
                  onClick={() => run(() => lmStudioModelUnload(unloadId.trim()))}
                >
                  Unload
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy || !cliOk}
                  onClick={() => run(() => lmStudioModelUnload(undefined, true))}
                >
                  Unload All
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ---- Register as provider ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Register as Router Provider</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                Add the running LM Studio server as an{" "}
                <span className="text-foreground/80">openai_compatible</span> provider — the router
                will forward requests to it just like any other provider. No API key needed.
              </p>
              <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto]">
                <div className="space-y-1">
                  <Label htmlFor="reg-name" className="text-xs">Provider name</Label>
                  <Input
                    id="reg-name"
                    value={providerName}
                    onChange={(e) => setProviderName(e.target.value)}
                    placeholder="LM Studio"
                  />
                </div>
                <div className="space-y-1 opacity-60">
                  <Label className="text-xs">URL (auto)</Label>
                  <Input value={`http://${host}:${port}`} readOnly className="text-xs font-mono bg-muted/30" />
                </div>
                <div className="flex items-end">
                  <Button
                    onClick={handleRegister}
                    disabled={!providerName.trim()}
                    className="w-full sm:w-auto"
                  >
                    Register
                  </Button>
                </div>
              </div>
              {regResult && (
                <p
                  className={[
                    "mt-3 text-sm rounded px-3 py-2",
                    regResult.startsWith("✓")
                      ? "bg-emerald-500/10 text-emerald-300"
                      : "bg-red-500/10 text-red-300",
                  ].join(" ")}
                >
                  {regResult}
                </p>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                After registering, create a route in{" "}
                <a href="/routes" className="underline underline-offset-2">Routes</a>{" "}
                or add a virtual alias in{" "}
                <a href="/mapping" className="underline underline-offset-2">Mapping</a>{" "}
                that forwards to this provider.
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
