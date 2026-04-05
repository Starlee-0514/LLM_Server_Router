"use client";

import { useEffect, useMemo, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createModelRoute,
  deleteModelRoute,
  getModelRoutes,
  getProviders,
  updateModelRoute,
  type ModelRouteItem,
  type ModelRoutePayload,
  type ProviderEndpoint,
} from "@/lib/api";

const emptyForm: ModelRoutePayload = {
  route_name: "",
  match_type: "exact",
  match_value: "",
  target_model: "",
  provider_id: 0,
  priority: 100,
  enabled: true,
};

type SuggestedProviderKind = "github-copilot" | "google-gemini-cli";

interface SuggestedRouteTemplate {
  exposedModel: string;
  providerKind: SuggestedProviderKind;
}

const suggestedRouteTemplates: SuggestedRouteTemplate[] = [
  { exposedModel: "github-copilot/claude-haiku-4.5", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/claude-opus-4.5", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/claude-opus-4.6", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/claude-sonnet-4.5", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/claude-sonnet-4.6", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-4.1", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-4o", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-5", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-5.4", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-5.3-codex", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-5.2-codex", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-5.1", providerKind: "github-copilot" },
  { exposedModel: "github-copilot/gpt-5-mini", providerKind: "github-copilot" },
  { exposedModel: "google-gemini-cli/gemini-2.5-pro", providerKind: "google-gemini-cli" },
  { exposedModel: "google-gemini-cli/gemini-3-flash-preview", providerKind: "google-gemini-cli" },
  { exposedModel: "google-gemini-cli/gemini-3-pro-preview", providerKind: "google-gemini-cli" },
  { exposedModel: "google-gemini-cli/gemini-3.1-pro-preview", providerKind: "google-gemini-cli" },
];

const suggestedProviderLabels: Record<SuggestedProviderKind, string> = {
  "github-copilot": "GitHub Copilot Catalog",
  "google-gemini-cli": "Google Gemini CLI Catalog",
};

const detectSuggestedProviderKind = (provider: ProviderEndpoint): SuggestedProviderKind | null => {
  const name = provider.name.toLowerCase();
  const baseUrl = (provider.base_url || "").toLowerCase();

  if (
    baseUrl.includes("models.inference.ai.azure.com") ||
    baseUrl.includes("api.individual.githubcopilot.com") ||
    name.includes("github") ||
    name.includes("copilot")
  ) {
    return "github-copilot";
  }

  if (
    baseUrl.includes("generativelanguage.googleapis.com") ||
    baseUrl.includes("cloudcode-pa.googleapis.com") ||
    name.includes("gemini") ||
    name.includes("google")
  ) {
    return "google-gemini-cli";
  }

  return null;
};

const buildSuggestedTargetModel = (exposedModel: string) => exposedModel.split("/").slice(1).join("/");

const buildSuggestedRouteName = (exposedModel: string) =>
  `route-${exposedModel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

const buildSuggestedRoutePayload = (template: SuggestedRouteTemplate, providerId: number): ModelRoutePayload => ({
  route_name: buildSuggestedRouteName(template.exposedModel),
  match_type: "exact",
  match_value: template.exposedModel,
  target_model: buildSuggestedTargetModel(template.exposedModel),
  provider_id: providerId,
  priority: 80,
  enabled: true,
});

export default function RoutesPage() {
  const [routes, setRoutes] = useState<ModelRouteItem[]>([]);
  const [providers, setProviders] = useState<ProviderEndpoint[]>([]);
  const [form, setForm] = useState<ModelRoutePayload>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"priority" | "name" | "provider">("priority");
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [addingSuggestionKey, setAddingSuggestionKey] = useState<string | null>(null);
  const [addingSuggestionGroup, setAddingSuggestionGroup] = useState<SuggestedProviderKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerMap = useMemo(() => {
    const map = new Map<number, ProviderEndpoint>();
    for (const p of providers) map.set(p.id, p);
    return map;
  }, [providers]);

  const filteredRoutes = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = routes.filter((item) => {
      const providerName = providerMap.get(item.provider_id)?.name ?? "";
      if (!q) return true;
      return (
        item.route_name.toLowerCase().includes(q) ||
        item.match_value.toLowerCase().includes(q) ||
        (item.target_model || "").toLowerCase().includes(q) ||
        providerName.toLowerCase().includes(q)
      );
    });

    filtered.sort((a, b) => {
      if (sortBy === "name") return a.route_name.localeCompare(b.route_name);
      if (sortBy === "provider") {
        const aName = providerMap.get(a.provider_id)?.name ?? "";
        const bName = providerMap.get(b.provider_id)?.name ?? "";
        return aName.localeCompare(bName);
      }
      return a.priority - b.priority;
    });

    return filtered;
  }, [routes, search, sortBy, providerMap]);

  const suggestedProviders = useMemo(() => {
    const matches = new Map<SuggestedProviderKind, ProviderEndpoint>();
    for (const provider of providers) {
      if (!provider.enabled) continue;
      const kind = detectSuggestedProviderKind(provider);
      if (kind && !matches.has(kind)) {
        matches.set(kind, provider);
      }
    }
    return matches;
  }, [providers]);

  const suggestedRouteGroups = useMemo(() => {
    return (["github-copilot", "google-gemini-cli"] as SuggestedProviderKind[]).map((kind) => {
      const provider = suggestedProviders.get(kind) ?? null;
      const items = suggestedRouteTemplates
        .filter((template) => template.providerKind === kind)
        .map((template) => ({
          ...template,
          targetModel: buildSuggestedTargetModel(template.exposedModel),
          added: provider
            ? routes.some(
                (route) => route.provider_id === provider.id && route.match_value === template.exposedModel,
              )
            : false,
        }));

      return {
        kind,
        label: suggestedProviderLabels[kind],
        provider,
        items,
      };
    });
  }, [routes, suggestedProviders]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [routeData, providerData] = await Promise.all([getModelRoutes(), getProviders()]);
      setRoutes(routeData);
      setProviders(providerData);
      if (providerData.length > 0 && form.provider_id === 0) {
        setForm((prev) => ({ ...prev, provider_id: providerData[0].id }));
      }
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load routes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const resetForm = () => {
    setForm({ ...emptyForm, provider_id: providers[0]?.id ?? 0 });
    setEditingId(null);
  };

  const handleSubmit = async () => {
    try {
      if (!form.route_name.trim() || !form.match_value.trim() || !form.provider_id) return;
      if (editingId !== null) {
        await updateModelRoute(editingId, form);
      } else {
        await createModelRoute(form);
      }
      resetForm();
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    }
  };

  const handleEdit = (item: ModelRouteItem) => {
    setEditingId(item.id);
    setForm({
      route_name: item.route_name,
      match_type: item.match_type,
      match_value: item.match_value,
      target_model: item.target_model || "",
      provider_id: item.provider_id,
      priority: item.priority,
      enabled: item.enabled,
    });
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteModelRoute(id);
      if (pendingDeleteId === id) setPendingDeleteId(null);
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Delete failed");
    }
  };

  const handleAddSuggestedRoute = async (template: SuggestedRouteTemplate, providerId: number) => {
    setAddingSuggestionKey(template.exposedModel);
    try {
      await createModelRoute(buildSuggestedRoutePayload(template, providerId));
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Suggested route creation failed");
    } finally {
      setAddingSuggestionKey(null);
    }
  };

  const handleAddSuggestedGroup = async (kind: SuggestedProviderKind) => {
    const group = suggestedRouteGroups.find((entry) => entry.kind === kind);
    if (!group?.provider) return;

    const pending = group.items.filter((item) => !item.added);
    if (pending.length === 0) return;

    setAddingSuggestionGroup(kind);
    try {
      for (const item of pending) {
        await createModelRoute(buildSuggestedRoutePayload(item, group.provider.id));
      }
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Suggested route import failed");
    } finally {
      setAddingSuggestionGroup(null);
    }
  };

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Model Routes</h1>
          <p className="text-sm text-muted-foreground mt-1">設定模型名稱匹配規則，將請求路由到不同 provider</p>
        </div>

        {error && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Suggested Provider Routes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              One-click exact routes for the requested GitHub Copilot and Gemini CLI models. Each route keeps the exposed prefixed name and forwards the stripped upstream model id to the selected provider.
            </p>

            <div className="grid gap-4 xl:grid-cols-2">
              {suggestedRouteGroups.map((group) => {
                const completed = group.items.filter((item) => item.added).length;
                const pending = group.items.length - completed;

                return (
                  <div key={group.kind} className="rounded-md border border-border/40 bg-muted/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{group.label}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {group.provider
                            ? `Using provider ${group.provider.name}`
                            : "Add a matching provider in Providers before importing these routes."}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className="bg-white/10">{completed}/{group.items.length}</Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!group.provider || pending === 0 || addingSuggestionGroup === group.kind}
                          onClick={() => handleAddSuggestedGroup(group.kind)}
                        >
                          {addingSuggestionGroup === group.kind ? "Adding..." : pending === 0 ? "Imported" : `Add ${pending}`}
                        </Button>
                      </div>
                    </div>

                    <div className="mt-4 max-h-[320px] space-y-2 overflow-y-auto pr-1">
                      {group.items.map((item) => (
                        <div key={item.exposedModel} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/40 bg-background/60 p-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold font-mono">{item.exposedModel}</p>
                            <p className="mt-1 text-[11px] font-mono text-muted-foreground">
                              upstream {"->"} {item.targetModel}
                            </p>
                          </div>
                          {item.added ? (
                            <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-400/30">Added</Badge>
                          ) : !group.provider ? (
                            <Badge className="bg-amber-500/15 text-amber-300 border-amber-400/30">Provider missing</Badge>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={addingSuggestionKey === item.exposedModel || addingSuggestionGroup === group.kind}
                              onClick={() => handleAddSuggestedRoute(item, group.provider!.id)}
                            >
                              {addingSuggestionKey === item.exposedModel ? "Adding..." : "Add"}
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">{editingId !== null ? "Edit Route" : "Create Route"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">Route Name</Label>
                <Input value={form.route_name} onChange={(e) => setForm({ ...form, route_name: e.target.value })} className="text-xs" placeholder="qwen-route" />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Provider</Label>
                <select
                  value={form.provider_id}
                  onChange={(e) => setForm({ ...form, provider_id: Number(e.target.value) })}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.provider_type})</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">Match Type</Label>
                <select
                  value={form.match_type}
                  onChange={(e) => setForm({ ...form, match_type: e.target.value as "exact" | "prefix" })}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs"
                >
                  <option value="exact">exact</option>
                  <option value="prefix">prefix</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Priority</Label>
                <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 100 })} className="text-xs" />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Match Value</Label>
              <Input value={form.match_value} onChange={(e) => setForm({ ...form, match_value: e.target.value })} className="text-xs" placeholder="qwen" />
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Target Model (optional)</Label>
              <Input value={form.target_model} onChange={(e) => setForm({ ...form, target_model: e.target.value })} className="text-xs" placeholder="Qwen3.5-9B-Instruct" />
            </div>

            <div className="flex items-center gap-2">
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              <span className="text-xs text-muted-foreground">Enabled</span>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSubmit} size="sm">{editingId !== null ? "Update" : "Create"}</Button>
              {editingId !== null && <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Route List {loading ? "(Loading...)" : ""}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by route, match, target, provider"
                className="h-8 w-72 text-xs"
              />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "priority" | "name" | "provider")}
                className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="priority">Sort: Priority</option>
                <option value="name">Sort: Route Name</option>
                <option value="provider">Sort: Provider</option>
              </select>
              <span className="text-xs text-muted-foreground">{filteredRoutes.length} result(s)</span>
            </div>

            {filteredRoutes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No model routes configured.</p>
            ) : (
              <div className="space-y-3">
                {filteredRoutes.map((item) => (
                  <div key={item.id} className="rounded-md border border-border/40 bg-muted/20 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{item.route_name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {item.match_type}({item.match_value}) {"->"} {item.target_model || "(same model)"} · provider={providerMap.get(item.provider_id)?.name || `#${item.provider_id}`} · p={item.priority}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleEdit(item)}>Edit</Button>
                        {pendingDeleteId === item.id ? (
                          <>
                            <Button variant="destructive" size="sm" onClick={() => handleDelete(item.id)}>Confirm Delete</Button>
                            <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button variant="destructive" size="sm" onClick={() => setPendingDeleteId(item.id)}>Delete</Button>
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
