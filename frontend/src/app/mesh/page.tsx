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
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "name" | "status">("recent");
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerMap = useMemo(() => {
    const map = new Map<number, ProviderEndpoint>();
    for (const p of providers) map.set(p.id, p);
    return map;
  }, [providers]);

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
    () => {
      const decorated = workers.map((w) => {
        let modelCount = 0;
        try {
          const list = JSON.parse(w.models_json || "[]");
          if (Array.isArray(list)) modelCount = list.length;
        } catch {}
        return {
          ...w,
          modelCount,
          providerName: w.provider_id ? providerMap.get(w.provider_id)?.name ?? `#${w.provider_id}` : "(none)",
        };
      });

      const q = search.trim().toLowerCase();
      const filtered = decorated.filter((w) => {
        if (!q) return true;
        return (
          w.node_name.toLowerCase().includes(q) ||
          w.base_url.toLowerCase().includes(q) ||
          w.status.toLowerCase().includes(q) ||
          (w.providerName || "").toLowerCase().includes(q)
        );
      });

      filtered.sort((a, b) => {
        if (sortBy === "name") return a.node_name.localeCompare(b.node_name);
        if (sortBy === "status") return a.status.localeCompare(b.status);
        const aTime = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
        const bTime = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
        return bTime - aTime;
      });

      return filtered;
    },
    [workers, providerMap, search, sortBy],
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
    try {
      await deleteMeshWorker(id);
      if (pendingDeleteId === id) setPendingDeleteId(null);
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Delete failed");
    }
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Mesh Workers</h1>
          <p className="text-sm text-muted-foreground mt-1">檢視 Tailscale worker 節點，並手動送 heartbeat 測試同步</p>
        </div>

        {/* Usage Guide */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm border-l-4 border-l-sky-400/60">
          <CardContent className="py-4">
            <details>
              <summary className="text-sm font-semibold cursor-pointer select-none text-sky-300/90">📖 使用說明（點擊展開）</summary>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground leading-relaxed">
                <p><strong className="text-foreground/80">用途：</strong>Mesh 頁面讓你把多台電腦上的 LLM Server Router 串接起來。當你在不同電腦（如家裡桌機 + 公司筆電）都安裝了此軟體，透過 Tailscale 或同一個區域網路，它們可以互相發現並共享可用模型，無需在每台電腦重複設定供應商登入等資訊。</p>
                <p><strong className="text-foreground/80">運作原理：</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>每個節點定時向其他節點發送 <strong>Heartbeat</strong>（心跳信號），回報自己的名稱、位址、可用模型等資訊</li>
                  <li>路由器收到請求時，如果本地沒有對應模型，會自動查找其他 Mesh 節點是否有可用模型並轉發請求</li>
                  <li>你可以將節點綁定到一個已註冊的 Provider，這樣 Mesh 節點的模型就會自動出現在路由系統中</li>
                </ul>
                <p><strong className="text-foreground/80">如何使用：</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li>在下方「Send Worker Heartbeat」表單中填入另一台電腦的節點名稱與 Base URL（如 <code className="bg-muted px-1 rounded text-xs">http://my-desktop.tailnet.ts.net:8000</code>）</li>
                  <li>填入該節點上可用的模型名稱（每行一個）</li>
                  <li>點擊「Send Heartbeat」註冊節點</li>
                  <li>節點狀態會顯示在下方的 Worker List 中</li>
                </ul>
                <p className="text-xs text-muted-foreground/60 italic">未來版本將支援自動偵測區域網路 / Tailscale 上的其他節點。</p>
              </div>
            </details>
          </CardContent>
        </Card>

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
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by node, URL, status, provider"
                className="h-8 w-72 text-xs"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "recent" | "name" | "status")}
                className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="recent">Sort: Last Seen</option>
                <option value="name">Sort: Node Name</option>
                <option value="status">Sort: Status</option>
              </select>
              <span className="text-xs text-muted-foreground">{prettyWorkers.length} result(s)</span>
            </div>

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
                        <p className="text-xs text-muted-foreground font-mono">provider={worker.providerName}</p>
                        <p className="text-xs text-muted-foreground">
                          last_seen={worker.last_seen_at ? new Date(worker.last_seen_at).toLocaleString() : "-"}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {pendingDeleteId === worker.id ? (
                          <>
                            <Button variant="destructive" size="sm" onClick={() => handleDelete(worker.id)}>Confirm Delete</Button>
                            <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button variant="destructive" size="sm" onClick={() => setPendingDeleteId(worker.id)}>Delete</Button>
                        )}
                      </div>
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
