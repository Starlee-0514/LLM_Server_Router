"use client";

import { useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteMeshWorker,
  getMeshWorkers,
  getProviders,
  upsertMeshWorkerHeartbeat,
  type MeshWorker,
  type MeshWorkerHeartbeatPayload,
  type ProviderEndpoint,
} from "@/lib/api";

const emptyForm: MeshWorkerHeartbeatPayload = {
  node_name: "",
  base_url: "",
  api_token: "",
  provider_id: null,
  models: [],
  metadata: {},
  status: "online",
};

export default function MeshPage() {
  const [workers, setWorkers] = useState<MeshWorker[]>([]);
  const [providers, setProviders] = useState<ProviderEndpoint[]>([]);
  const [form, setForm] = useState<MeshWorkerHeartbeatPayload>(emptyForm);
  const [modelsText, setModelsText] = useState("");
  const [metadataText, setMetadataText] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [workerData, providerData] = await Promise.all([getMeshWorkers(), getProviders()]);
      setWorkers(workerData);
      setProviders(providerData);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load mesh workers");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const prettyWorkers = useMemo(
    () =>
      workers.map((w) => {
        let modelCount = 0;
        try {
          const list = JSON.parse(w.models_json || "[]");
          if (Array.isArray(list)) modelCount = list.length;
        } catch {}
        return { ...w, modelCount };
      }),
    [workers],
  );

  const handleSubmitHeartbeat = async () => {
    try {
      const parsedModels = modelsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      let parsedMetadata: Record<string, unknown> = {};
      if (metadataText.trim()) {
        parsedMetadata = JSON.parse(metadataText);
      }

      await upsertMeshWorkerHeartbeat({
        ...form,
        models: parsedModels,
        metadata: parsedMetadata,
      });

      setForm(emptyForm);
      setModelsText("");
      setMetadataText("{}");
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Heartbeat failed");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this mesh worker?")) return;
    try {
      await deleteMeshWorker(id);
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Delete failed");
    }
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Mesh Workers</h1>
          <p className="text-sm text-muted-foreground mt-1">檢視 Tailscale worker 節點，並手動送 heartbeat 測試同步</p>
        </div>

        {error && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Send Worker Heartbeat</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">Node Name</Label>
                <Input value={form.node_name} onChange={(e) => setForm({ ...form, node_name: e.target.value })} className="text-xs" placeholder="worker-a" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Base URL</Label>
                <Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className="text-xs font-mono" placeholder="http://worker-a.tailnet.ts.net:8000" />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">API Token</Label>
                <Input value={form.api_token} onChange={(e) => setForm({ ...form, api_token: e.target.value })} type="password" className="text-xs font-mono" placeholder="optional" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Provider Link</Label>
                <select
                  value={form.provider_id ?? ""}
                  onChange={(e) => setForm({ ...form, provider_id: e.target.value ? Number(e.target.value) : null })}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs"
                >
                  <option value="">(none)</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">Status</Label>
                <Input value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="text-xs" placeholder="online" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Models (one per line)</Label>
                <Textarea value={modelsText} onChange={(e) => setModelsText(e.target.value)} className="text-xs font-mono min-h-24" placeholder={"Qwen3.5-9B-Instruct\nLlama-3.1-8B"} />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Metadata (JSON)</Label>
              <Textarea value={metadataText} onChange={(e) => setMetadataText(e.target.value)} className="text-xs font-mono min-h-24" />
            </div>

            <Button size="sm" onClick={handleSubmitHeartbeat}>Send Heartbeat</Button>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Worker List {loading ? "(Loading...)" : ""}</CardTitle>
          </CardHeader>
          <CardContent>
            {prettyWorkers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No mesh workers registered.</p>
            ) : (
              <div className="space-y-3">
                {prettyWorkers.map((worker) => (
                  <div key={worker.id} className="rounded-md border border-border/40 bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{worker.node_name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {worker.base_url} · status={worker.status} · models={worker.modelCount}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          last_seen={worker.last_seen_at ? new Date(worker.last_seen_at).toLocaleString() : "-"}
                        </p>
                      </div>
                      <Button variant="destructive" size="sm" onClick={() => handleDelete(worker.id)}>Delete</Button>
                    </div>
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
