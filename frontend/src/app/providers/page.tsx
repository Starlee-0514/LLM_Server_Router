"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  checkProviderHealth,
  createProvider,
  deleteProvider,
  getCommonProviderTemplates,
  getProviderModels,
  getProviders,
  pollDeviceCodeFlow,
  registerCommonProvider,
  registerVertexProvider,
  refreshVertexToken,
  startCommonProviderOAuth,
  startDeviceCodeFlow,
  syncLocalProviders,
  updateProvider,
  type CommonProviderTemplate,
  type ProviderCreatePayload,
  type ProviderEndpoint,
  type ProviderHealthResponse,
  type ProviderModelItem,
} from "@/lib/api";

const emptyForm: ProviderCreatePayload = {
  name: "",
  provider_type: "openai_compatible",
  base_url: "",
  api_key: "",
  extra_headers: "",
  enabled: true,
};

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderEndpoint[]>([]);
  const [commonTemplates, setCommonTemplates] = useState<CommonProviderTemplate[]>([]);
  const [commonApiKey, setCommonApiKey] = useState("");
  const [commonNameOverride, setCommonNameOverride] = useState("");
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  // Vertex AI state
  const [vertexJsonText, setVertexJsonText] = useState("");
  const [vertexJsonError, setVertexJsonError] = useState<string | null>(null);
  const vertexFileRef = useRef<HTMLInputElement>(null);
  // Form state
  const [form, setForm] = useState<ProviderCreatePayload>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [healthMap, setHealthMap] = useState<Record<number, ProviderHealthResponse>>({});
  const [modelMap, setModelMap] = useState<Record<number, ProviderModelItem[]>>({});
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "type" | "recent">("recent");
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedModels, setExpandedModels] = useState<Record<number, boolean>>({});
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string; verificationUri: string; sessionId: string;
  } | null>(null);
  const [deviceCodePolling, setDeviceCodePolling] = useState(false);
  const [syncingLocal, setSyncingLocal] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedTemplate = commonTemplates.find((t) => t.provider_key === selectedTemplateKey);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = providers.filter((p) =>
      !q || p.name.toLowerCase().includes(q) ||
      p.provider_type.toLowerCase().includes(q) ||
      (p.base_url || "").toLowerCase().includes(q)
    );
    filtered.sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "type") return a.provider_type.localeCompare(b.provider_type);
      return (b.updated_at ? new Date(b.updated_at).getTime() : 0) -
             (a.updated_at ? new Date(a.updated_at).getTime() : 0);
    });
    return filtered;
  }, [providers, search, sortBy]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [providerData, templateData] = await Promise.all([
        getProviders(), getCommonProviderTemplates(),
      ]);
      setProviders(providerData);
      setCommonTemplates(templateData);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load providers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const resetForm = () => { setForm(emptyForm); setEditingId(null); };

  const handleSubmit = async () => {
    if (!form.name.trim()) return;
    try {
      if (editingId !== null) await updateProvider(editingId, form);
      else await createProvider(form);
      resetForm();
      await refresh();
    } catch (e: any) { setError(e.message ?? "Save failed"); }
  };

  const handleEdit = (provider: ProviderEndpoint) => {
    setEditingId(provider.id);
    setForm({
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url || "",
      api_key: provider.api_key || "",
      extra_headers: provider.extra_headers || "",
      enabled: provider.enabled,
    });
    setShowManualForm(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteProvider(id);
      if (pendingDeleteId === id) setPendingDeleteId(null);
      await refresh();
    } catch (e: any) { setError(e.message ?? "Delete failed"); }
  };

  const handleHealth = async (id: number) => {
    try {
      const result = await checkProviderHealth(id);
      setHealthMap((prev) => ({ ...prev, [id]: result }));
    } catch (e: any) {
      setHealthMap((prev) => ({ ...prev, [id]: { ok: false, error: e.message ?? "Health check failed" } }));
    }
  };

  // Parse & validate the Vertex JSON text
  const parseVertexJson = (): object | null => {
    try {
      const parsed = JSON.parse(vertexJsonText.trim());
      if (parsed.type !== "service_account") {
        setVertexJsonError('JSON must have "type": "service_account"');
        return null;
      }
      for (const field of ["project_id", "client_email", "private_key"]) {
        if (!parsed[field]) { setVertexJsonError(`Missing field: ${field}`); return null; }
      }
      setVertexJsonError(null);
      return parsed;
    } catch {
      setVertexJsonError("Invalid JSON — paste the entire contents of the key file");
      return null;
    }
  };

  const handleAddProvider = async () => {
    if (!selectedTemplateKey) return;
    setWorking(true);
    setError(null);
    try {
      const tpl = commonTemplates.find((t) => t.provider_key === selectedTemplateKey);

      // ── Vertex AI (service account) ──────────────────────────────────────
      if (tpl?.oauth_method === "service_account") {
        const saJson = parseVertexJson();
        if (!saJson) { setWorking(false); return; }
        await registerVertexProvider({
          service_account_json: saJson,
          name_override: commonNameOverride,
        });
        setVertexJsonText("");
        setCommonNameOverride("");
        setSelectedTemplateKey("");
        await refresh();
        return;
      }

      // ── GitHub Device Code Flow ──────────────────────────────────────────
      if (tpl?.oauth_method === "device_code") {
        const result = await startDeviceCodeFlow(selectedTemplateKey, commonNameOverride);
        setDeviceCode({ userCode: result.user_code, verificationUri: result.verification_uri, sessionId: result.session_id });
        setDeviceCodePolling(true);
        window.open(result.verification_uri, "_blank");
        const poll = async (interval: number) => {
          try {
            const pr = await pollDeviceCodeFlow(result.session_id);
            if (pr.status === "complete") { setDeviceCode(null); setDeviceCodePolling(false); await refresh(); return; }
            if (pr.status === "expired" || pr.status === "error") {
              setDeviceCode(null); setDeviceCodePolling(false);
              setError(pr.error || "Device code flow expired or failed"); return;
            }
            const next = pr.status === "slow_down" ? (pr.interval || interval + 5) * 1000 : interval * 1000;
            pollTimerRef.current = setTimeout(() => poll(next / 1000), next);
          } catch (e: any) { setDeviceCode(null); setDeviceCodePolling(false); setError(e.message ?? "Polling failed"); }
        };
        poll(result.interval);
        return;
      }

      // ── Google OAuth PKCE ────────────────────────────────────────────────
      if (tpl?.oauth_method === "pkce") {
        const started = await startCommonProviderOAuth(selectedTemplateKey, commonNameOverride);
        const popup = window.open(started.auth_url, "provider-oauth", "width=640,height=800");
        if (!popup) { setError("Popup blocked. Please allow popups and try again."); return; }
        const onMessage = (event: MessageEvent) => {
          if (event?.data?.type === "provider-oauth-success") {
            window.removeEventListener("message", onMessage); refresh();
          }
        };
        window.addEventListener("message", onMessage);
        return;
      }

      // ── API Key / No Auth ────────────────────────────────────────────────
      await registerCommonProvider({ provider_key: selectedTemplateKey, api_key: commonApiKey, enabled: true, name_override: commonNameOverride });
      setCommonNameOverride(""); setCommonApiKey(""); setSelectedTemplateKey("");
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Provider registration failed");
    } finally {
      setWorking(false);
    }
  };

  const handleFetchModels = async (id: number) => {
    try {
      const models = await getProviderModels(id);
      setModelMap((prev) => ({ ...prev, [id]: models }));
    } catch (e: any) { setError(e.message ?? "Fetch provider models failed"); }
  };

  const handleVertexFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setVertexJsonText((ev.target?.result as string) ?? "");
      setVertexJsonError(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Group templates by auth category
  const templateCategories = useMemo(() => {
    const cats: Record<string, CommonProviderTemplate[]> = {
      "🏠 Local": [],
      "🔑 API Key": [],
      "🔐 OAuth — GitHub": [],
      "🌐 OAuth — Google": [],
      "🗝️ Service Account": [],
    };
    for (const tpl of commonTemplates) {
      if (tpl.oauth_method === "none")             cats["🏠 Local"].push(tpl);
      else if (tpl.oauth_method === "api_key")      cats["🔑 API Key"].push(tpl);
      else if (tpl.oauth_method === "device_code")  cats["🔐 OAuth — GitHub"].push(tpl);
      else if (tpl.oauth_method === "pkce")         cats["🌐 OAuth — Google"].push(tpl);
      else if (tpl.oauth_method === "service_account") cats["🗝️ Service Account"].push(tpl);
    }
    return cats;
  }, [commonTemplates]);

  // Helper: is this provider a Vertex AI one?
  const isVertexProvider = (p: ProviderEndpoint) =>
    p.provider_type === "google_vertex" || (p.base_url || "").includes("aiplatform.googleapis.com");

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Providers</h1>
            <p className="text-sm text-muted-foreground mt-1">
              管理 OpenAI-compatible / Anthropic / Google Vertex / Local provider endpoints
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={syncingLocal} onClick={async () => {
            setSyncingLocal(true);
            try {
              const created = await syncLocalProviders();
              if (created.length > 0) await refresh();
              else setError("No new local processes found.");
            } catch (e: any) { setError(e.message ?? "Sync local failed"); }
            finally { setSyncingLocal(false); }
          }}>
            {syncingLocal ? "Scanning..." : "⚡ Sync Local Models"}
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.2fr] gap-6">
          {/* ── Left column ──────────────────────────────────────── */}
          <div className="space-y-6">

            {/* ===== Add Provider Card ===== */}
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="text-base">Add Provider</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">

                {/* Provider Type Dropdown */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Provider Type</Label>
                  <Select
                    value={selectedTemplateKey}
                    onValueChange={(v) => {
                      setSelectedTemplateKey(v);
                      setVertexJsonText("");
                      setVertexJsonError(null);
                      setCommonApiKey("");
                    }}
                  >
                    <SelectTrigger className="text-xs">
                      <SelectValue placeholder="Select a provider type..." />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(templateCategories).map(([cat, tpls]) =>
                        tpls.length > 0 && (
                          <div key={cat}>
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{cat}</div>
                            {tpls.map((tpl) => (
                              <SelectItem key={tpl.provider_key} value={tpl.provider_key}>
                                {tpl.label}
                              </SelectItem>
                            ))}
                          </div>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {/* Template info banner */}
                {selectedTemplate && (
                  <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 space-y-1">
                    <p className="text-xs text-muted-foreground">{selectedTemplate.auth_hint}</p>
                    {selectedTemplate.base_url && (
                      <p className="text-xs font-mono text-muted-foreground/60">{selectedTemplate.base_url}</p>
                    )}
                    {selectedTemplate.oauth_method === "pkce" && (
                      <p className="text-xs text-blue-400">🔐 Will open Google OAuth login in a popup</p>
                    )}
                    {selectedTemplate.oauth_method === "device_code" && (
                      <p className="text-xs text-blue-400">🔐 Will start GitHub Device Code Flow</p>
                    )}
                    {selectedTemplate.oauth_method === "service_account" && (
                      <p className="text-xs text-amber-400">🗝️ Paste your Service Account JSON key below</p>
                    )}
                  </div>
                )}

                {/* ── Vertex AI: JSON key input ─────────────────────── */}
                {selectedTemplate?.oauth_method === "service_account" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Service Account JSON Key</Label>
                      <Button
                        variant="outline" size="sm"
                        className="h-6 text-xs px-2"
                        onClick={() => vertexFileRef.current?.click()}
                      >
                        📂 Upload .json
                      </Button>
                      <input
                        ref={vertexFileRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={handleVertexFileUpload}
                      />
                    </div>
                    <Textarea
                      value={vertexJsonText}
                      onChange={(e) => { setVertexJsonText(e.target.value); setVertexJsonError(null); }}
                      placeholder={'{\n  "type": "service_account",\n  "project_id": "my-project",\n  "private_key": "-----BEGIN RSA PRIVATE KEY-----\\n...",\n  "client_email": "sa@my-project.iam.gserviceaccount.com",\n  ...\n}'}
                      className="text-xs font-mono min-h-36 resize-y"
                      spellCheck={false}
                    />
                    {vertexJsonError && (
                      <p className="text-xs text-destructive">{vertexJsonError}</p>
                    )}
                    {vertexJsonText && !vertexJsonError && (() => {
                      try {
                        const p = JSON.parse(vertexJsonText);
                        return (
                          <p className="text-xs text-emerald-400">
                            ✓ Project: <span className="font-mono">{p.project_id}</span>
                            {" · "}Account: <span className="font-mono">{p.client_email?.split("@")[0]}</span>
                          </p>
                        );
                      } catch { return null; }
                    })()}
                  </div>
                )}

                {/* Custom Name */}
                <div className="space-y-1">
                  <Label className="text-xs">Custom Name (optional)</Label>
                  <Input
                    value={commonNameOverride}
                    onChange={(e) => setCommonNameOverride(e.target.value)}
                    className="text-xs"
                    placeholder="e.g. vertex-prod, my-openrouter"
                  />
                  <p className="text-xs text-muted-foreground">
                    Auto-named from project/email if blank.
                  </p>
                </div>

                {/* API Key — only for api_key providers */}
                {selectedTemplate?.oauth_method === "api_key" && (
                  <div className="space-y-2">
                    <Label className="text-xs">API Key</Label>
                    <Input
                      value={commonApiKey}
                      onChange={(e) => setCommonApiKey(e.target.value)}
                      type="password"
                      className="text-xs font-mono"
                      placeholder="Enter API key"
                    />
                  </div>
                )}

                {/* Device Code UI */}
                {deviceCode && (
                  <div className="rounded-md border border-blue-400/40 bg-blue-500/10 px-4 py-3">
                    <p className="text-sm font-medium mb-1">GitHub Device Code Flow</p>
                    <p className="text-xs text-muted-foreground mb-2">
                      Go to{" "}
                      <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer" className="underline text-blue-400">
                        {deviceCode.verificationUri}
                      </a>{" "}
                      and enter:
                    </p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <code className="text-lg font-bold tracking-widest bg-background/50 px-3 py-1 rounded border">
                        {deviceCode.userCode}
                      </code>
                      <Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(deviceCode.userCode)}>
                        Copy
                      </Button>
                      {deviceCodePolling && (
                        <span className="text-xs text-muted-foreground animate-pulse">Waiting for authorization...</span>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => {
                        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
                        setDeviceCode(null); setDeviceCodePolling(false);
                      }}>Cancel</Button>
                    </div>
                  </div>
                )}

                {/* Add button */}
                <Button
                  onClick={handleAddProvider}
                  size="sm"
                  disabled={!selectedTemplateKey || deviceCodePolling || working}
                  className="w-full"
                >
                  {working ? "Connecting..." :
                   selectedTemplate?.oauth_method === "service_account"
                     ? "🗝️ Connect Vertex AI"
                   : selectedTemplate?.oauth_method === "pkce"
                     ? `🔐 Connect ${selectedTemplate.label} Account`
                   : selectedTemplate?.oauth_method === "device_code"
                     ? `🔐 Connect ${selectedTemplate.label} Account`
                   : `➕ Add ${selectedTemplate?.label ?? "Provider"}`}
                </Button>

                {/* Manual form toggle */}
                <div className="border-t border-border/40 pt-3">
                  <Button
                    variant="ghost" size="sm"
                    className="text-xs text-muted-foreground w-full"
                    onClick={() => { setShowManualForm(!showManualForm); if (!showManualForm) resetForm(); }}
                  >
                    {showManualForm ? "▾ Hide Manual Configuration" : "▸ Manual Configuration (Custom endpoint)"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* ===== Manual Create / Edit Card ===== */}
            {showManualForm && (
              <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                <CardHeader>
                  <CardTitle className="text-base">
                    {editingId !== null ? "Edit Provider" : "Manual Provider"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label className="text-xs">Name</Label>
                      <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="worker-a" className="text-xs" />
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Provider Type</Label>
                      <select
                        value={form.provider_type}
                        onChange={(e) => setForm({ ...form, provider_type: e.target.value as ProviderCreatePayload["provider_type"] })}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs"
                      >
                        <option value="openai_compatible">openai_compatible</option>
                        <option value="anthropic">anthropic</option>
                        <option value="google_antigravity">google_antigravity</option>
                        <option value="google_vertex">google_vertex</option>
                        <option value="local_process">local_process</option>
                      </select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Base URL</Label>
                    <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://..." className="text-xs font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">API Key</Label>
                    <Input value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} type="password" placeholder="optional" className="text-xs font-mono" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Extra Headers (JSON)</Label>
                    <Textarea
                      value={form.extra_headers}
                      onChange={(e) => setForm({ ...form, extra_headers: e.target.value })}
                      placeholder='{"x-header": "value"}'
                      className="text-xs font-mono min-h-20"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                    <span className="text-xs text-muted-foreground">Enabled</span>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={handleSubmit} size="sm">{editingId !== null ? "Update" : "Create"}</Button>
                    {editingId !== null && (
                      <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ── Right column: Provider List ──────────────────────── */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm h-fit">
            <CardHeader>
              <CardTitle className="text-base">
                Provider List {loading ? "(Loading...)" : ""}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, type, base URL"
                  className="h-8 w-72 text-xs"
                />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as "name" | "type" | "recent")}
                  className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
                >
                  <option value="recent">Sort: Recently Updated</option>
                  <option value="name">Sort: Name</option>
                  <option value="type">Sort: Provider Type</option>
                </select>
                <span className="text-xs text-muted-foreground">{filteredProviders.length} result(s)</span>
              </div>

              {filteredProviders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No providers configured.</p>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {filteredProviders.map((provider) => (
                    <div key={provider.id} className="rounded-md border border-border/40 bg-muted/20 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold">{provider.name}</p>
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {provider.provider_type} · {provider.base_url || "(no base url)"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {/* Vertex: extra refresh button */}
                          {isVertexProvider(provider) && (
                            <Button
                              variant="outline" size="sm"
                              className="text-xs h-7 px-2 text-amber-400 border-amber-400/40"
                              title="Force-refresh Vertex AI access token"
                              onClick={async () => {
                                try {
                                  await refreshVertexToken(provider.id);
                                  await refresh();
                                } catch (e: any) { setError(e.message ?? "Token refresh failed"); }
                              }}
                            >
                              🗝️ Refresh Token
                            </Button>
                          )}
                          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => handleHealth(provider.id)}>Health</Button>
                          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => handleFetchModels(provider.id)}>Models</Button>
                          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => handleEdit(provider)}>Edit</Button>
                          {pendingDeleteId === provider.id ? (
                            <>
                              <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => handleDelete(provider.id)}>Confirm</Button>
                              <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setPendingDeleteId(null)}>Cancel</Button>
                            </>
                          ) : (
                            <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => setPendingDeleteId(provider.id)}>Delete</Button>
                          )}
                        </div>
                      </div>

                      {healthMap[provider.id] && (
                        <p className="mt-2 text-xs font-mono text-muted-foreground">
                          health: {healthMap[provider.id].ok ? "✅ ok" : "❌ fail"}
                          {healthMap[provider.id].status_code ? ` · status=${healthMap[provider.id].status_code}` : ""}
                          {healthMap[provider.id].error ? ` · ${healthMap[provider.id].error}` : ""}
                        </p>
                      )}

                      {modelMap[provider.id] && (
                        <div className="mt-2 rounded border border-border/40 bg-background/40 p-2">
                          <Button
                            variant="ghost" size="sm"
                            className="text-xs text-muted-foreground w-full justify-start p-0 h-auto"
                            onClick={() => setExpandedModels((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                          >
                            {expandedModels[provider.id]
                              ? `▾ models: ${modelMap[provider.id].length}`
                              : `▸ models: ${modelMap[provider.id].length}`}
                          </Button>
                          {expandedModels[provider.id] && (
                            <div className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                              {modelMap[provider.id].slice(0, 30).map((m) => (
                                <p key={m.id} className="text-xs font-mono text-muted-foreground">{m.id}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
