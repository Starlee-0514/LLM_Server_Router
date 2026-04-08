"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { getSettings, updateSettings, getRuntimes, createRuntime, updateRuntime, deleteRuntime, type SettingItem, type Runtime } from "@/lib/api";

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [scanDirs, setScanDirs] = useState<string[]>([]);
  const [newDir, setNewDir] = useState("");
  const [defaultEngine, setDefaultEngine] = useState("");
  const [listenHost, setListenHost] = useState("0.0.0.0");
  const [listenPort, setListenPort] = useState("8000");
  const [corsAllowOrigins, setCorsAllowOrigins] = useState("*");
  const [apiToken, setApiToken] = useState("");
  const [githubClientId, setGithubClientId] = useState("");
  const [githubClientSecret, setGithubClientSecret] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Runtime management state
  const [editingRuntimeId, setEditingRuntimeId] = useState<number | null>(null);
  const [runtimeName, setRuntimeName] = useState("");
  const [runtimePath, setRuntimePath] = useState("");
  const [runtimeDesc, setRuntimeDesc] = useState("");
  const [runtimeEnvJson, setRuntimeEnvJson] = useState("{}");
  const [savingRuntime, setSavingRuntime] = useState(false);

  const resetRuntimeForm = () => {
    setEditingRuntimeId(null);
    setRuntimeName("");
    setRuntimePath("");
    setRuntimeDesc("");
    setRuntimeEnvJson("{}");
  };

  const getEnvVarCount = (environmentVars: string) => {
    try {
      const parsed = JSON.parse(environmentVars || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.keys(parsed).length
        : 0;
    } catch {
      return 0;
    }
  };

  const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown error";

  const refresh = async () => {
    try {
      const [data, runtimesData] = await Promise.all([getSettings(), getRuntimes()]);
      setSettings(data);
      setRuntimes(runtimesData);

      const dirs = data.find((s) => s.key === "model_scan_dirs");
      if (dirs) {
        try {
          setScanDirs(JSON.parse(dirs.value));
        } catch {
          setScanDirs([]);
        }
      }

      setDefaultEngine(data.find((s) => s.key === "default_engine")?.value ?? runtimesData[0]?.name ?? "");
      setListenHost(data.find((s) => s.key === "listen_host")?.value ?? "0.0.0.0");
      setListenPort(data.find((s) => s.key === "listen_port")?.value ?? "8000");
      setCorsAllowOrigins(data.find((s) => s.key === "cors_allow_origins")?.value ?? "*");
      setApiToken(data.find((s) => s.key === "api_token")?.value ?? "");
      setGithubClientId(data.find((s) => s.key === "github_client_id")?.value ?? "");
      setGithubClientSecret(data.find((s) => s.key === "github_client_secret")?.value ?? "");
      setGoogleClientId(data.find((s) => s.key === "google_client_id")?.value ?? "");
      setGoogleClientSecret(data.find((s) => s.key === "google_client_secret")?.value ?? "");
    } catch {}
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (runtimes.length > 0 && !runtimes.some((runtime) => runtime.name === defaultEngine)) {
      setDefaultEngine(runtimes[0].name);
    }
  }, [runtimes, defaultEngine]);

  const handleAddDir = () => {
    const trimmed = newDir.trim();
    if (trimmed && !scanDirs.includes(trimmed)) {
      setScanDirs([...scanDirs, trimmed]);
      setNewDir("");
    }
  };

  const handleRemoveDir = (dir: string) => {
    setScanDirs(scanDirs.filter((d) => d !== dir));
  };

  const handleEditRuntime = (runtime: Runtime) => {
    setEditingRuntimeId(runtime.id);
    setRuntimeName(runtime.name);
    setRuntimePath(runtime.executable_path);
    setRuntimeDesc(runtime.description);
    setRuntimeEnvJson(runtime.environment_vars || "{}");
  };

  const handleSaveRuntime = async () => {
    if (!runtimeName.trim() || !runtimePath.trim()) {
      alert("Please enter both name and path");
      return;
    }

    let parsedEnv: unknown;
    try {
      parsedEnv = JSON.parse(runtimeEnvJson || "{}");
    } catch {
      alert("Environment variables must be valid JSON");
      return;
    }

    if (parsedEnv === null || Array.isArray(parsedEnv) || typeof parsedEnv !== "object") {
      alert("Environment variables must be a JSON object");
      return;
    }

    setSavingRuntime(true);
    try {
      const payload = {
        name: runtimeName.trim(),
        executable_path: runtimePath.trim(),
        description: runtimeDesc.trim(),
        environment_vars: JSON.stringify(parsedEnv),
      };

      if (editingRuntimeId) {
        await updateRuntime(editingRuntimeId, payload);
      } else {
        await createRuntime(payload);
      }

      resetRuntimeForm();
      await refresh();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    } finally {
      setSavingRuntime(false);
    }
  };

  const handleDeleteRuntime = async (id: number, name: string) => {
    if (!confirm(`Delete runtime "${name}"?`)) return;
    try {
      await deleteRuntime(id);
      if (editingRuntimeId === id) {
        resetRuntimeForm();
      }
      await refresh();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings([
        { key: "model_scan_dirs", value: JSON.stringify(scanDirs) },
        { key: "default_engine", value: defaultEngine },
        { key: "listen_host", value: listenHost.trim() },
        { key: "listen_port", value: listenPort.trim() },
        { key: "cors_allow_origins", value: corsAllowOrigins.trim() },
        { key: "api_token", value: apiToken.trim() },
        { key: "github_client_id", value: githubClientId.trim() },
        { key: "github_client_secret", value: githubClientSecret.trim() },
        { key: "google_client_id", value: googleClientId.trim() },
        { key: "google_client_secret", value: googleClientSecret.trim() },
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await refresh();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">系統配置管理</p>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* Scan Directories */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Model Scan Directories</CardTitle>
              <p className="text-xs text-muted-foreground">
                設定要掃描 GGUF 模型的資料夾路徑
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {scanDirs.length > 0 && (
                <div className="space-y-2">
                  {scanDirs.map((dir) => (
                    <div key={dir} className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                      <span className="font-mono text-xs truncate flex-1">{dir}</span>
                      <Button variant="ghost" size="sm" onClick={() => handleRemoveDir(dir)} className="text-destructive hover:text-destructive ml-2 h-6 w-6 p-0">
                        ✕
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={newDir}
                  onChange={(e) => setNewDir(e.target.value)}
                  placeholder="/home/starlee/models"
                  className="font-mono text-xs"
                  onKeyDown={(e) => e.key === "Enter" && handleAddDir()}
                />
                <Button variant="outline" onClick={handleAddDir} disabled={!newDir.trim()}>
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Runtime Management */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Runtime Environments</CardTitle>
              <p className="text-xs text-muted-foreground">
                以名稱、執行路徑與環境變數管理所有運行時，模型預設會直接連結到這些物件
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {runtimes.length > 0 && (
                <div className="space-y-2 mb-4">
                  <p className="text-xs font-semibold text-muted-foreground mb-2">Available Runtimes:</p>
                  {runtimes.map((runtime) => (
                    <div key={runtime.id} className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 font-medium text-xs">
                          <span>{runtime.name}</span>
                          {runtime.name === defaultEngine && <Badge variant="secondary" className="text-[10px]">Default</Badge>}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono truncate">{runtime.executable_path}</div>
                        {runtime.description && <div className="text-[10px] text-muted-foreground">{runtime.description}</div>}
                        <div className="text-[10px] text-muted-foreground">Env: {getEnvVarCount(runtime.environment_vars)} variable(s)</div>
                      </div>
                      <div className="ml-2 flex gap-1.5">
                        <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => handleEditRuntime(runtime)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteRuntime(runtime.id, runtime.name)} className="text-destructive hover:text-destructive h-7 w-7 p-0">
                          ✕
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-border/40 pt-4">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground">{editingRuntimeId ? "Edit Runtime:" : "Add New Runtime:"}</p>
                  {editingRuntimeId && (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={resetRuntimeForm}>
                      Cancel Edit
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  <Input
                    value={runtimeName}
                    onChange={(e) => setRuntimeName(e.target.value)}
                    placeholder="Runtime name (e.g., rocm, vulkan, cpu)"
                    className="text-xs"
                    onKeyDown={(e) => e.key === "Enter" && handleSaveRuntime()}
                  />
                  <Input
                    value={runtimePath}
                    onChange={(e) => setRuntimePath(e.target.value)}
                    placeholder="Executable path (e.g., /usr/bin/llama-server)"
                    className="font-mono text-xs"
                    onKeyDown={(e) => e.key === "Enter" && handleSaveRuntime()}
                  />
                  <Input
                    value={runtimeDesc}
                    onChange={(e) => setRuntimeDesc(e.target.value)}
                    placeholder="Description (optional)"
                    className="text-xs"
                    onKeyDown={(e) => e.key === "Enter" && handleSaveRuntime()}
                  />
                  <div className="space-y-2">
                    <Label className="text-xs">Environment Variables JSON</Label>
                    <Textarea
                      value={runtimeEnvJson}
                      onChange={(e) => setRuntimeEnvJson(e.target.value)}
                      className="min-h-24 font-mono text-xs"
                      placeholder='{"HSA_OVERRIDE_GFX_VERSION":"11.5.0"}'
                    />
                  </div>
                  <Button variant="outline" onClick={handleSaveRuntime} disabled={savingRuntime || !runtimeName.trim() || !runtimePath.trim()}>
                    {savingRuntime ? "Saving..." : editingRuntimeId ? "Update Runtime" : "Add Runtime"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Execution Defaults</CardTitle>
              <p className="text-xs text-muted-foreground">
                選擇新模型預設會優先使用的 runtime
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs">Default Runtime</Label>
                <select value={defaultEngine} onChange={(e) => setDefaultEngine(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs" disabled={runtimes.length === 0}>
                  {runtimes.length > 0 ? (
                    runtimes.map((rt) => (
                      <option key={rt.id} value={rt.name} className="bg-background text-foreground">
                        {rt.name}
                      </option>
                    ))
                  ) : (
                    <option value="" className="bg-background text-foreground">No runtimes configured</option>
                  )}
                </select>
                <p className="text-[10px] text-muted-foreground">
                  Rename operations keep linked model presets aligned automatically.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Network Access</CardTitle>
              <p className="text-xs text-muted-foreground">
                設定監聽位址、CORS 與 API Token 驗證（儲存後生效範圍依後端實作）
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs">Listen Host</Label>
                  <Input value={listenHost} onChange={(e) => setListenHost(e.target.value)} className="font-mono text-xs" placeholder="0.0.0.0" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Listen Port</Label>
                  <Input value={listenPort} onChange={(e) => setListenPort(e.target.value)} className="font-mono text-xs" placeholder="8000" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">CORS Allow Origins</Label>
                <Input value={corsAllowOrigins} onChange={(e) => setCorsAllowOrigins(e.target.value)} className="font-mono text-xs" placeholder="* or comma-separated origins" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">API Token (for /v1 routes)</Label>
                <Input value={apiToken} onChange={(e) => setApiToken(e.target.value)} type="password" className="font-mono text-xs" placeholder="optional bearer token" />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">OAuth Clients</CardTitle>
              <p className="text-xs text-muted-foreground">
                設定 GitHub 與 Google OAuth client。儲存後重新啟動後端可立即套用。
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs">GitHub Client ID</Label>
                  <Input value={githubClientId} onChange={(e) => setGithubClientId(e.target.value)} className="font-mono text-xs" placeholder="Iv1.xxxxx" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">GitHub Client Secret</Label>
                  <Input value={githubClientSecret} onChange={(e) => setGithubClientSecret(e.target.value)} type="password" className="font-mono text-xs" placeholder="optional if device flow only" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs">Google Client ID</Label>
                  <Input value={googleClientId} onChange={(e) => setGoogleClientId(e.target.value)} className="font-mono text-xs" placeholder="xxxx.apps.googleusercontent.com" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Google Client Secret</Label>
                  <Input value={googleClientSecret} onChange={(e) => setGoogleClientSecret(e.target.value)} type="password" className="font-mono text-xs" placeholder="GOCSPX-..." />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Google PKCE login requires both Client ID and Client Secret. If these are blank, the Providers page will now show a clear API error instead of opening a broken Google auth page.
              </p>
            </CardContent>
          </Card>

          {/* Environment Info */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Environment Info</CardTitle>
              <p className="text-xs text-muted-foreground">
                從 .env 和資料庫讀取的設定值（唯讀）
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {settings.filter(s => s.key !== "model_scan_dirs" && s.key !== "runtime_objects_seeded").map((s) => (
                  <div key={s.key} className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">{s.key}</span>
                    <Badge variant="secondary" className="font-mono text-[10px] max-w-xs truncate">{s.value}</Badge>
                  </div>
                ))}
                {settings.filter(s => s.key !== "model_scan_dirs" && s.key !== "runtime_objects_seeded").length === 0 && (
                  <p className="text-xs text-muted-foreground">No additional settings configured.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* API Endpoint Info */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">API Endpoints</CardTitle>
              <p className="text-xs text-muted-foreground">
                OpenAI 兼容 API 端點，供 IDE 或遠端裝置連線
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Chat Completions</span>
                  <code className="font-mono text-xs">http://&lt;IP&gt;:8000/v1/chat/completions</code>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Models</span>
                  <code className="font-mono text-xs">http://&lt;IP&gt;:8000/v1/models</code>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <span className="text-xs text-muted-foreground">API Docs</span>
                  <code className="font-mono text-xs">http://localhost:8000/docs</code>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Save Button */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40 transition-shadow"
            >
              {saving ? "Saving..." : "💾 Save Changes"}
            </Button>
            {saved && <span className="text-xs text-emerald-400 animate-pulse">✓ Saved successfully</span>}
          </div>
        </div>
      </main>
    </div>
  );
}
