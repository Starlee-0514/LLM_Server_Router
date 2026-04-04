"use client";

import { useEffect, useState } from "react";
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
  getProviders,
  updateProvider,
  type ProviderCreatePayload,
  type ProviderEndpoint,
  type ProviderHealthResponse,
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
  const [form, setForm] = useState<ProviderCreatePayload>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [healthMap, setHealthMap] = useState<Record<number, ProviderHealthResponse>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await getProviders();
      setProviders(data);
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
    if (!confirm("Delete this provider?")) return;
    try {
      await deleteProvider(id);
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

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Providers</h1>
          <p className="text-sm text-muted-foreground mt-1">管理 OpenAI-compatible / Anthropic / Local provider endpoints</p>
        </div>

        {error && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
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

        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Provider List {loading ? "(Loading...)" : ""}</CardTitle>
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No providers configured.</p>
            ) : (
              <div className="space-y-3">
                {providers.map((provider) => (
                  <div key={provider.id} className="rounded-md border border-border/40 bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{provider.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{provider.provider_type} · {provider.base_url || "(no base url)"}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleHealth(provider.id)}>Health</Button>
                        <Button variant="outline" size="sm" onClick={() => handleEdit(provider)}>Edit</Button>
                        <Button variant="destructive" size="sm" onClick={() => handleDelete(provider.id)}>Delete</Button>
                      </div>
                    </div>
                    {healthMap[provider.id] && (
                      <p className="mt-2 text-xs font-mono text-muted-foreground">
                        health: {healthMap[provider.id].ok ? "ok" : "fail"}
                        {healthMap[provider.id].status_code ? ` · status=${healthMap[provider.id].status_code}` : ""}
                        {healthMap[provider.id].error ? ` · error=${healthMap[provider.id].error}` : ""}
                      </p>
                    )}
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
