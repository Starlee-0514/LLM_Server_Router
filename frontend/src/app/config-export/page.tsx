"use client";

import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  getConfigExportTargets,
  previewConfigExport,
  writeConfigExport,
  readCurrentConfigFile,
  type ConfigExportTarget,
  type ConfigExportResult,
  type ConfigCurrentFile,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type WriteMode = "patch" | "full";

// ---------------------------------------------------------------------------
// Helper: extract a specific provider key from JSON content string
// ---------------------------------------------------------------------------
function extractProviderEntry(content: string, providerKey: string): string {
  try {
    const parsed = JSON.parse(content);
    const entry = parsed?.providers?.[providerKey];
    if (entry === undefined) return `# key "${providerKey}" not found in current file`;
    return JSON.stringify(entry, null, 2);
  } catch {
    return "# could not parse current file";
  }
}

// ---------------------------------------------------------------------------
// Code block w/ copy button
// ---------------------------------------------------------------------------
function CodeBlock({
  content,
  maxH = "70vh",
  label,
  labelColor = "text-muted-foreground",
}: {
  content: string;
  maxH?: string;
  label?: string;
  labelColor?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="relative">
      {label && <p className={`text-xs font-semibold mb-1.5 ${labelColor}`}>{label}</p>}
      <pre
        className="rounded-lg border border-border/40 bg-background/80 p-4 text-xs font-mono overflow-auto whitespace-pre"
        style={{ maxHeight: maxH }}
      >
        {content}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 rounded border border-border/40 bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function ConfigExportPage() {
  // ---- state ----
  const [targets, setTargets] = useState<ConfigExportTarget[]>([]);
  const [selectedTarget, setSelectedTarget] = useState("pi-agent");
  const [selectedFormat, setSelectedFormat] = useState("json");

  // write mode
  const [writeMode, setWriteMode] = useState<WriteMode>("patch");
  const [providerKey, setProviderKey] = useState("llm-router");
  const [routerBaseUrl, setRouterBaseUrl] = useState("http://localhost:8000/v1");

  // output
  const [customPath, setCustomPath] = useState("");

  // data
  const [preview, setPreview] = useState<ConfigExportResult | null>(null);
  const [currentFile, setCurrentFile] = useState<ConfigCurrentFile | null>(null);

  // ui flags
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showPatchEntry, setShowPatchEntry] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  // tick: incrementing this forces a fresh preview fetch (for Refresh button)
  const [previewTick, setPreviewTick] = useState(0);

  // ---- load targets once ----
  useEffect(() => {
    getConfigExportTargets()
      .then((t) => {
        setTargets(t);
        if (t.length > 0) {
          setSelectedTarget(t[0].key);
          setSelectedFormat(t[0].formats[0] ?? "json");
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  // ---- auto-preview: fires on mount & whenever any param or previewTick changes ----
  // Uses abort/cleanup to prevent stale updates from concurrent fetches.
  useEffect(() => {
    if (!selectedTarget || !selectedFormat) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    previewConfigExport(selectedTarget, selectedFormat, writeMode, providerKey, routerBaseUrl)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.message ?? "Preview failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedTarget, selectedFormat, writeMode, providerKey, routerBaseUrl, previewTick]);

  // ---- manual refresh ----
  const handlePreview = useCallback(() => {
    setSuccess(null);
    setPreviewTick((t) => t + 1);
  }, []);

  // ---- load current file ----
  const handleLoadCurrent = useCallback(async () => {
    try {
      const result = await readCurrentConfigFile(selectedTarget);
      setCurrentFile(result);
      setShowCurrent(true);
    } catch (e: any) {
      setError(e.message ?? "Failed to read current file");
    }
  }, [selectedTarget]);

  // ---- write to disk ----
  const handleWrite = useCallback(async () => {
    setWriting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await writeConfigExport(
        selectedTarget,
        selectedFormat,
        customPath,
        writeMode,
        providerKey,
        routerBaseUrl,
      );
      if (result.ok) {
        setSuccess(`✅ ${result.message}`);
        // Refresh current file view if open
        if (showCurrent) handleLoadCurrent();
      } else {
        setError(result.message);
      }
    } catch (e: any) {
      setError(e.message ?? "Write failed");
    } finally {
      setWriting(false);
    }
  }, [selectedTarget, selectedFormat, customPath, writeMode, providerKey, routerBaseUrl, showCurrent, handleLoadCurrent]);

  // ---- download ----
  const handleDownload = useCallback(() => {
    if (!preview?.content) return;
    const ext = selectedFormat === "yaml" ? "yaml" : "json";
    const blob = new Blob([preview.content], {
      type: selectedFormat === "yaml" ? "text/yaml" : "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `models.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [preview, selectedFormat]);

  const activeTarget = targets.find((t) => t.key === selectedTarget);

  // ---- derived: what the diff shows ----
  // patch mode diff: old entry vs new entry
  const oldEntry =
    writeMode === "patch" && currentFile?.exists
      ? extractProviderEntry(currentFile.content, providerKey)
      : currentFile?.content ?? "";
  const newForDiff =
    writeMode === "patch" ? (preview?.patch_entry ?? "") : (preview?.content ?? "");
  const diffLeftLabel =
    writeMode === "patch"
      ? `Current providers["${providerKey}"] (before)`
      : "Current file (before)";
  const diffRightLabel =
    writeMode === "patch"
      ? `New providers["${providerKey}"] (after)`
      : "Generated config (after)";

  const hasCurrentEntry =
    writeMode === "patch" &&
    currentFile?.exists &&
    (() => {
      try {
        const p = JSON.parse(currentFile.content);
        return p?.providers?.[providerKey] !== undefined;
      } catch {
        return false;
      }
    })();

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        {/* ---- Header ---- */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Config Export</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Generate <code className="bg-muted px-1 rounded text-xs">models.json</code> for{" "}
            <span className="font-semibold text-foreground">pi agent</span> from your Routes &amp; local models
          </p>
        </div>

        {/* ---- Alerts ---- */}
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex items-center justify-between">
            <span>{error}</span>
            <button className="text-xs underline ml-4" onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
        {success && (
          <div className="mb-4 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-400 flex items-center justify-between">
            <span>{success}</span>
            <button className="text-xs underline ml-4" onClick={() => setSuccess(null)}>dismiss</button>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
          {/* ==================== Left panel ==================== */}
          <div className="space-y-5">

            {/* ---- Write Mode ---- */}
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Write Mode</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setWriteMode("patch")}
                    className={`rounded-lg border p-3 text-left transition-all ${
                      writeMode === "patch"
                        ? "border-primary/60 bg-primary/10 shadow-sm"
                        : "border-border/40 bg-muted/20 hover:bg-accent/50"
                    }`}
                  >
                    <p className="text-xs font-semibold">✎ Patch Section</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Only replaces one provider key. All other providers are preserved.
                    </p>
                  </button>
                  <button
                    onClick={() => setWriteMode("full")}
                    className={`rounded-lg border p-3 text-left transition-all ${
                      writeMode === "full"
                        ? "border-orange-500/60 bg-orange-500/10 shadow-sm"
                        : "border-border/40 bg-muted/20 hover:bg-accent/50"
                    }`}
                  >
                    <p className="text-xs font-semibold">⚠ Full Replace</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Replaces the entire file with Routes + local models only.
                    </p>
                  </button>
                </div>

                {writeMode === "full" && (
                  <div className="rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-400">
                    ⚠ Full Replace will overwrite the entire models.json. Providers like GitHub Copilot and OpenRouter that exist in the file will be removed. Use{" "}
                    <button className="underline" onClick={() => setWriteMode("patch")}>Patch Section</button>{" "}
                    to keep them.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ---- Patch Settings (patch mode only) ---- */}
            {writeMode === "patch" && (
              <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Patch Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Provider Key to Replace</Label>
                    <Input
                      value={providerKey}
                      onChange={(e) => setProviderKey(e.target.value)}
                      placeholder="llm-router"
                      className="text-xs font-mono h-8"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Only <code className="bg-muted px-0.5 rounded">providers[&quot;{providerKey}&quot;]</code> will be replaced.
                      {hasCurrentEntry ? (
                        <span className="text-yellow-400 ml-1">⚠ key exists in current file</span>
                      ) : currentFile?.exists ? (
                        <span className="text-green-400 ml-1">✓ key will be added (new)</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Router Base URL</Label>
                    <Input
                      value={routerBaseUrl}
                      onChange={(e) => setRouterBaseUrl(e.target.value)}
                      placeholder="http://localhost:8000/v1"
                      className="text-xs font-mono h-8"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      The endpoint pi agent sends requests to.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- Full mode: router URL ---- */}
            {writeMode === "full" && (
              <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Router Settings</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Router Base URL</Label>
                    <Input
                      value={routerBaseUrl}
                      onChange={(e) => setRouterBaseUrl(e.target.value)}
                      placeholder="http://localhost:8000/v1"
                      className="text-xs font-mono h-8"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- Output Settings ---- */}
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Output Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Format</Label>
                  <div className="flex gap-2">
                    {(activeTarget?.formats ?? ["json"]).map((f) => (
                      <Button
                        key={f}
                        variant={selectedFormat === f ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setSelectedFormat(f)}
                      >
                        {f.toUpperCase()}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Output Path <span className="text-muted-foreground">(empty = default)</span>
                  </Label>
                  <Input
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    placeholder={activeTarget?.default_path ?? "~/.pi/agent/models.json"}
                    className="text-xs font-mono h-8"
                  />
                </div>
              </CardContent>
            </Card>

            {/* ---- Actions ---- */}
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={handlePreview} disabled={loading} variant="outline" size="sm" className="h-8 text-xs">
                    {loading ? "..." : "⟳ Refresh"}
                  </Button>
                  <Button onClick={handleDownload} disabled={!preview?.content} variant="outline" size="sm" className="h-8 text-xs">
                    ↓ Download
                  </Button>
                  <Button
                    onClick={() => { handleLoadCurrent(); setShowDiff(false); }}
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs col-span-2"
                  >
                    ⊞ Load Current File
                  </Button>
                </div>

                <div className="pt-1">
                  <Button
                    onClick={handleWrite}
                    disabled={writing || !preview?.content}
                    size="sm"
                    className={`w-full ${writeMode === "full" ? "bg-orange-600 hover:bg-orange-700" : ""}`}
                  >
                    {writing
                      ? "Writing..."
                      : writeMode === "patch"
                      ? `✎ Patch "${providerKey}" in models.json`
                      : "⚠ Full Replace models.json"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* ---- Stats ---- */}
            {preview && (
              <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardContent className="pt-5 pb-5">
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-primary">
                        {writeMode === "patch" ? preview.model_count : preview.provider_count}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {writeMode === "patch" ? "Routes exported" : "Providers"}
                      </p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-primary">
                        {writeMode === "patch" ? preview.provider_count : preview.model_count}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {writeMode === "patch" ? "Total providers (merged)" : "Total models"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ==================== Right panel ==================== */}
          <div className="space-y-5">

            {/* ---- Preview: merged result ---- */}
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  {writeMode === "patch" ? "Merged Result" : "Generated Config"}
                  {preview && (
                    <Badge variant="secondary" className="text-[10px]">
                      {selectedFormat.toUpperCase()}
                    </Badge>
                  )}
                  {writeMode === "patch" && (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      full file after patch
                    </Badge>
                  )}
                </CardTitle>
                <div className="flex gap-2">
                  {writeMode === "patch" && preview?.patch_entry && (
                    <Button
                      variant={showPatchEntry ? "default" : "ghost"}
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setShowPatchEntry((v) => !v)}
                    >
                      {showPatchEntry ? "⊟ Hide Entry" : "⊞ Show Entry Only"}
                    </Button>
                  )}
                  {currentFile?.exists && (
                    <Button
                      variant={showDiff ? "default" : "ghost"}
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setShowDiff((v) => !v)}
                    >
                      {showDiff ? "⊟ Hide Diff" : "⊟ Diff"}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="flex items-center justify-center py-16">
                    <p className="text-sm text-muted-foreground animate-pulse">Generating…</p>
                  </div>
                ) : preview?.content ? (
                  <CodeBlock content={preview.content} maxH="65vh" />
                ) : (
                  <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
                    No enabled routes found. Configure routes in the{" "}
                    <a href="/routes" className="ml-1 text-primary underline">Routes</a> page.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ---- Patch entry only (collapsible) ---- */}
            {writeMode === "patch" && showPatchEntry && preview?.patch_entry && (
              <Card className="border-primary/30 bg-primary/5 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base text-primary">
                    New <code className="text-sm">providers[&quot;{providerKey}&quot;]</code> Entry
                  </CardTitle>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Only this block will be written into the existing models.json.
                  </p>
                </CardHeader>
                <CardContent>
                  <CodeBlock content={preview.patch_entry} maxH="50vh" />
                </CardContent>
              </Card>
            )}

            {/* ---- Diff view ---- */}
            {showDiff && currentFile?.exists && (newForDiff || oldEntry) && (
              <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    {writeMode === "patch"
                      ? `Diff — providers["${providerKey}"]`
                      : "Diff — full file"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <CodeBlock
                      content={oldEntry}
                      maxH="55vh"
                      label={diffLeftLabel}
                      labelColor="text-muted-foreground"
                    />
                    <CodeBlock
                      content={newForDiff}
                      maxH="55vh"
                      label={diffRightLabel}
                      labelColor="text-green-400"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ---- Current file on disk ---- */}
            {showCurrent && (
              <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    Current File on Disk
                    {currentFile && (
                      <Badge
                        variant={currentFile.exists ? "secondary" : "destructive"}
                        className="text-[10px]"
                      >
                        {currentFile.exists ? "EXISTS" : "NOT FOUND"}
                      </Badge>
                    )}
                  </CardTitle>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowCurrent(false)}>
                    ✕
                  </Button>
                </CardHeader>
                <CardContent>
                  {currentFile?.exists ? (
                    <>
                      <p className="text-[10px] text-muted-foreground font-mono mb-2">{currentFile.path}</p>
                      <CodeBlock content={currentFile.content} maxH="40vh" />
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No file at{" "}
                      <code className="bg-muted px-1 rounded text-xs">{currentFile?.path}</code>.
                      Click the write button to create it.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* ---- Guide ---- */}
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">📖 How it works</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs text-muted-foreground">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
                    <p className="font-semibold text-foreground mb-1.5">✎ Patch Section (recommended)</p>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Reads existing <code className="bg-muted px-0.5 rounded">models.json</code></li>
                      <li>Replaces only <code className="bg-muted px-0.5 rounded">providers[&quot;{providerKey}&quot;]</code></li>
                      <li>All other providers (GitHub Copilot, OpenRouter…) stay untouched</li>
                      <li>Models = all enabled Routes (<code className="bg-muted px-0.5 rounded">match_value</code> as ID)</li>
                    </ul>
                  </div>
                  <div className="rounded-md border border-orange-500/20 bg-orange-500/5 p-3">
                    <p className="font-semibold text-foreground mb-1.5">⚠ Full Replace</p>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Generates a clean minimal config</li>
                      <li><code className="bg-muted px-0.5 rounded">llm-router</code> entry = all Routes</li>
                      <li><code className="bg-muted px-0.5 rounded">local-*</code> entries = local_process providers</li>
                      <li><strong>Removes</strong> any other existing providers</li>
                    </ul>
                  </div>
                </div>
                <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
                  <p className="font-semibold text-blue-400 mb-1">💡 After writing</p>
                  <p>Use <code className="bg-muted px-1 rounded">/model</code> in pi — it reloads <code className="bg-muted px-1 rounded">models.json</code> automatically, no restart needed.</p>
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </main>
    </div>
  );
}
