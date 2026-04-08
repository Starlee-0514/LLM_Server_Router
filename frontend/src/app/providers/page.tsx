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
  checkProviderHealth,
  createProvider,
  deleteProvider,
  getCommonProviderTemplates,
  getProviderModels,
  getProviders,
  pollDeviceCodeFlow,
  registerCommonProvider,
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
  const [form, setForm] = useState<ProviderCreatePayload>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [healthMap, setHealthMap] = useState<Record<number, ProviderHealthResponse>>({});
  const [modelMap, setModelMap] = useState<Record<number, ProviderModelItem[]>>({});
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "type" | "recent">("recent");
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedModels, setExpandedModels] = useState<Record<number, boolean>>({});
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string;
    verificationUri: string;
    sessionId: string;
  } | null>(null);
  const [deviceCodePolling, setDeviceCodePolling] = useState(false);
  const [syncingLocal, setSyncingLocal] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = providers.filter((p) => {
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.provider_type.toLowerCase().includes(q) ||
        (p.base_url || "").toLowerCase().includes(q)
      );
    });

    filtered.sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "type") return a.provider_type.localeCompare(b.provider_type);
      const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bTime - aTime;
    });

    return filtered;
  }, [providers, search, sortBy]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [providerData, templateData] = await Promise.all([getProviders(), getCommonProviderTemplates()]);
      setProviders(providerData);
      setCommonTemplates(templateData);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load providers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const handleSubmit = async () => {
    try {
      if (!form.name.trim()) return;
      if (editingId !== null) {
        await updateProvider(editingId, form);
      } else {
        await createProvider(form);
      }
      resetForm();
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    }
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
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteProvider(id);
      if (pendingDeleteId === id) setPendingDeleteId(null);
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Delete failed");
    }
  };

  const handleHealth = async (id: number) => {
    try {
      const result = await checkProviderHealth(id);
      setHealthMap((prev) => ({ ...prev, [id]: result }));
    } catch (e: any) {
      setHealthMap((prev) => ({ ...prev, [id]: { ok: false, error: e.message ?? "Health check failed" } }));
    }
  };

  const handleRegisterCommon = async (providerKey: string) => {
    try {
      const tpl = commonTemplates.find((t) => t.provider_key === providerKey);

      // Device Code Flow (GitHub Models)
      if (tpl?.oauth_method === "device_code") {
        const result = await startDeviceCodeFlow(providerKey, commonNameOverride);
        setDeviceCode({
          userCode: result.user_code,
          verificationUri: result.verification_uri,
          sessionId: result.session_id,
        });
        setDeviceCodePolling(true);

        // Open verification URL
        window.open(result.verification_uri, "_blank");

        // Start polling
        const poll = async (interval: number) => {
          try {
            const pollResult = await pollDeviceCodeFlow(result.session_id);
            if (pollResult.status === "complete") {
              setDeviceCode(null);
              setDeviceCodePolling(false);
              await refresh();
              return;
            }
            if (pollResult.status === "expired" || pollResult.status === "error") {
              setDeviceCode(null);
              setDeviceCodePolling(false);
              setError(pollResult.error || "Device code flow expired or failed");
              return;
            }
            const nextInterval = pollResult.status === "slow_down"
              ? (pollResult.interval || interval + 5) * 1000
              : interval * 1000;
            pollTimerRef.current = setTimeout(() => poll(nextInterval / 1000), nextInterval);
          } catch (e: any) {
            setDeviceCode(null);
            setDeviceCodePolling(false);
            setError(e.message ?? "Polling failed");
          }
        };
        poll(result.interval);
        return;
      }

      // PKCE Flow (Google Gemini)
      if (tpl?.oauth_method === "pkce") {
        const started = await startCommonProviderOAuth(providerKey, commonNameOverride);
        const popup = window.open(started.auth_url, "provider-oauth", "width=640,height=800");
        if (!popup) {
          setError("Popup blocked. Please allow popups and try again.");
          return;
        }

        const onMessage = (event: MessageEvent) => {
          if (event?.data?.type === "provider-oauth-success") {
            window.removeEventListener("message", onMessage);
            refresh();
          }
        };
        window.addEventListener("message", onMessage);
        return;
      }

      // API Key flow (OpenRouter, etc.)
      await registerCommonProvider({
        provider_key: providerKey,
        api_key: commonApiKey,
        enabled: true,
        name_override: commonNameOverride,
      });
      setCommonNameOverride("");
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Common provider registration failed");
    }
  };

  const handleFetchModels = async (id: number) => {
    try {
      const models = await getProviderModels(id);
      setModelMap((prev) => ({ ...prev, [id]: models }));
    } catch (e: any) {
      setError(e.message ?? "Fetch provider models failed");
    }
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Providers</h1>
            <p className="text-sm text-muted-foreground mt-1">管理 OpenAI-compatible / Anthropic / Local provider endpoints</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={syncingLocal}
            onClick={async () => {
              setSyncingLocal(true);
              try {
                const created = await syncLocalProviders();
                if (created.length > 0) {
                  await refresh();
                } else {
                  setError("No new local processes found (all already registered or none running).");
                }
              } catch (e: any) {
                setError(e.message ?? "Sync local failed");
              } finally {
                setSyncingLocal(false);
              }
            }}
          >
            {syncingLocal ? "Scanning..." : "⚡ Sync Local Models"}
          </Button>
        </div>

        {error && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.2fr] gap-6">
          {/* Left column: Quick Setup + Create/Edit form */}
          <div className="space-y-6">

        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Common Providers Quick Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">API Key / Token (OpenRouter only)</Label>
                <Input value={commonApiKey} onChange={(e) => setCommonApiKey(e.target.value)} type="password" className="text-xs font-mono" placeholder="OpenRouter API key" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Name Override (optional)</Label>
                <Input value={commonNameOverride} onChange={(e) => setCommonNameOverride(e.target.value)} className="text-xs" placeholder="custom-provider-name" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              GitHub uses Device Code Flow (enter code in browser). Google uses OAuth with PKCE. OpenRouter uses API key.
            </p>

            {deviceCode && (
              <div className="rounded-md border border-blue-400/40 bg-blue-500/10 px-4 py-3">
                <p className="text-sm font-medium mb-1">GitHub Device Code Flow</p>
                <p className="text-xs text-muted-foreground mb-2">
                  Go to <a href={deviceCode.verificationUri} target="_blank" rel="noopener noreferrer" className="underline text-blue-400">{deviceCode.verificationUri}</a> and enter this code:
                </p>
                <div className="flex items-center gap-3">
                  <code className="text-lg font-bold tracking-widest bg-background/50 px-3 py-1 rounded border">{deviceCode.userCode}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigator.clipboard.writeText(deviceCode.userCode)}
                  >
                    Copy
                  </Button>
                  {deviceCodePolling && <span className="text-xs text-muted-foreground animate-pulse">Waiting for authorization...</span>}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
                      setDeviceCode(null);
                      setDeviceCodePolling(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {commonTemplates.map((tpl) => (
                <Button
                  key={tpl.provider_key}
                  variant="outline"
                  size="sm"
                  disabled={deviceCodePolling}
                  onClick={() => handleRegisterCommon(tpl.provider_key)}
                >
                  {tpl.oauth_method === "device_code" || tpl.oauth_method === "pkce" ? `Add ${tpl.label} Account` : `Add ${tpl.label}`}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">{editingId !== null ? "Edit Provider" : "Create Provider"}</CardTitle>
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
                  <option value="local_process">local_process</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Base URL</Label>
              <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="http://worker-a.tailnet.ts.net:8000" className="text-xs font-mono" />
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
                className="text-xs font-mono min-h-24"
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

          </div>
          {/* Right column: Provider List */}

        <Card className="border-border/40 bg-card/60 backdrop-blur-sm h-fit">
          <CardHeader>
            <CardTitle className="text-base">Provider List {loading ? "(Loading...)" : ""}</CardTitle>
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
                      <div>
                        <p className="text-sm font-semibold">{provider.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{provider.provider_type} · {provider.base_url || "(no base url)"}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleHealth(provider.id)}>Health</Button>
                        <Button variant="outline" size="sm" onClick={() => handleFetchModels(provider.id)}>Models</Button>
                        <Button variant="outline" size="sm" onClick={() => handleEdit(provider)}>Edit</Button>
                        {pendingDeleteId === provider.id ? (
                          <>
                            <Button variant="destructive" size="sm" onClick={() => handleDelete(provider.id)}>Confirm Delete</Button>
                            <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button variant="destructive" size="sm" onClick={() => setPendingDeleteId(provider.id)}>Delete</Button>
                        )}
                      </div>
                    </div>
                    {healthMap[provider.id] && (
                      <p className="mt-2 text-xs font-mono text-muted-foreground">
                        health: {healthMap[provider.id].ok ? "ok" : "fail"}
                        {healthMap[provider.id].status_code ? ` · status=${healthMap[provider.id].status_code}` : ""}
                        {healthMap[provider.id].error ? ` · error=${healthMap[provider.id].error}` : ""}
                      </p>
                    )}
                    {modelMap[provider.id] && (
                      <div className="mt-2 rounded border border-border/40 bg-background/40 p-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground w-full justify-start p-0 h-auto"
                          onClick={() => setExpandedModels((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                        >
                          {expandedModels[provider.id] ? `▾ models: ${modelMap[provider.id].length}` : `▸ models: ${modelMap[provider.id].length}`}
                        </Button>
                        {expandedModels[provider.id] && (
                        <div className="mt-1 max-h-32 overflow-y-auto space-y-1">
                          {modelMap[provider.id].slice(0, 30).map((m) => (
                            <p key={m.id} className="text-xs font-mono">{m.id}</p>
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
