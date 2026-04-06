"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  createVirtualModel,
  deleteVirtualModel,
  getRoutePolicies,
  getVirtualModels,
  updateVirtualModel,
  type RoutePolicyOption,
  type RoutingHints,
  type VirtualModelItem,
  type VirtualModelPayload,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLICY_BADGE_CLASS: Record<string, string> = {
  local_first: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  cheapest: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  fastest: "bg-violet-500/15 text-violet-300 border-violet-400/30",
  highest_quality: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  local_only: "bg-blue-500/15 text-blue-300 border-blue-400/30",
  remote_only: "bg-rose-500/15 text-rose-300 border-rose-400/30",
};

const POLICY_ICON: Record<string, string> = {
  local_first: "⇩",
  cheapest: "$",
  fastest: "⚡",
  highest_quality: "★",
  local_only: "⊙",
  remote_only: "☁",
};

const PRESET_ALIASES = [
  { model_id: "coding", display_name: "Coding", description: "Best model for code generation & review", preferred_policy: "fastest", requires_tools: true },
  { model_id: "chat", display_name: "Chat", description: "Conversational assistant", preferred_policy: "local_first", requires_tools: false },
  { model_id: "fast", display_name: "Fast", description: "Lowest-latency option", preferred_policy: "fastest", requires_tools: false },
  { model_id: "quality", display_name: "Quality", description: "Highest-quality output regardless of cost", preferred_policy: "highest_quality", requires_tools: false },
  { model_id: "cheap", display_name: "Cheap", description: "Minimum token cost", preferred_policy: "cheapest", requires_tools: false },
  { model_id: "vision", display_name: "Vision", description: "Image + text understanding", preferred_policy: "local_first", requires_tools: false, requires_vision: true },
];

const emptyForm = (): VirtualModelPayload => ({
  model_id: "",
  display_name: "",
  description: "",
  routing_hints: {
    preferred_policy: "local_first",
    requires_tools: false,
    requires_vision: false,
    preferred_provider_ids: [],
    fallback_provider_id: null,
  },
  enabled: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHints(json: string): RoutingHints {
  try {
    return JSON.parse(json) as RoutingHints;
  } catch {
    return {};
  }
}

function policyLabel(policies: RoutePolicyOption[], value: string): string {
  return policies.find((p) => p.value === value)?.label.split("—")[0].trim() ?? value;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MappingPage() {
  const [items, setItems] = useState<VirtualModelItem[]>([]);
  const [policies, setPolicies] = useState<RoutePolicyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<VirtualModelPayload>(emptyForm());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // ---- data loading ----
  const refresh = async () => {
    setLoading(true);
    try {
      const [vms, ps] = await Promise.all([getVirtualModels(), getRoutePolicies()]);
      setItems(vms);
      setPolicies(ps);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to load aliases");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  // ---- form helpers ----
  const resetForm = () => {
    setForm(emptyForm());
    setEditingId(null);
  };

  const setHints = (patch: Partial<RoutingHints>) =>
    setForm((prev) => ({ ...prev, routing_hints: { ...prev.routing_hints, ...patch } }));

  const handleEdit = (vm: VirtualModelItem) => {
    const hints = parseHints(vm.routing_hints_json);
    setEditingId(vm.id);
    setForm({
      model_id: vm.model_id,
      display_name: vm.display_name,
      description: vm.description,
      routing_hints: {
        preferred_policy: hints.preferred_policy ?? "local_first",
        requires_tools: hints.requires_tools ?? false,
        requires_vision: hints.requires_vision ?? false,
        preferred_provider_ids: hints.preferred_provider_ids ?? [],
        fallback_provider_id: hints.fallback_provider_id ?? null,
      },
      enabled: vm.enabled,
    });
  };

  const handleSubmit = async () => {
    if (!form.model_id.trim()) return;
    setSaving(true);
    try {
      if (editingId !== null) {
        await updateVirtualModel(editingId, form);
      } else {
        await createVirtualModel(form);
      }
      resetForm();
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteVirtualModel(id);
      if (pendingDeleteId === id) setPendingDeleteId(null);
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Delete failed");
    }
  };

  const handleAddPreset = async (preset: (typeof PRESET_ALIASES)[number]) => {
    if (items.some((vm) => vm.model_id === preset.model_id)) return;
    try {
      await createVirtualModel({
        model_id: preset.model_id,
        display_name: preset.display_name,
        description: preset.description,
        routing_hints: {
          preferred_policy: preset.preferred_policy,
          requires_tools: preset.requires_tools,
          requires_vision: (preset as any).requires_vision ?? false,
        },
        enabled: true,
      });
      await refresh();
    } catch (e: any) {
      setError(e.message ?? "Preset add failed");
    }
  };

  // ---- render ----
  const hints = form.routing_hints;

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Model Mapping</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Define stable alias IDs (e.g. <code className="text-xs font-mono bg-muted px-1 rounded">coding</code>,{" "}
            <code className="text-xs font-mono bg-muted px-1 rounded">chat</code>) that forward requests using a{" "}
            <span className="text-foreground/80">route policy</span> enum. Clients use the alias; the router resolves the best backend.
          </p>
        </div>

        {/* Usage Guide */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm border-l-4 border-l-sky-400/60">
          <CardContent className="py-4">
            <details>
              <summary className="text-sm font-semibold cursor-pointer select-none text-sky-300/90">📖 使用說明（點擊展開）</summary>
              <div className="mt-3 space-y-2 text-sm text-muted-foreground leading-relaxed">
                <p><strong className="text-foreground/80">用途：</strong>Model Mapping 讓你建立「虛擬模型別名」，例如 <code className="bg-muted px-1 rounded text-xs">coding</code>、<code className="bg-muted px-1 rounded text-xs">chat</code>、<code className="bg-muted px-1 rounded text-xs">vision</code>。當客戶端（如 VS Code Copilot）發送請求時，只需指定別名，路由器會根據你設定的策略自動選擇最佳的後端模型。</p>
                <p><strong className="text-foreground/80">路由策略：</strong></p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  <li><strong>local_first</strong> — 優先使用本地模型（LM Studio / Ollama），本地不可用時退回遠端</li>
                  <li><strong>cheapest</strong> — 選擇 token 費用最低的供應商</li>
                  <li><strong>fastest</strong> — 選擇延遲最低的供應商</li>
                  <li><strong>highest_quality</strong> — 選擇最高品質的模型，不考慮費用</li>
                  <li><strong>local_only</strong> — 只使用本地模型</li>
                  <li><strong>remote_only</strong> — 只使用遠端 API 供應商</li>
                </ul>
                <p><strong className="text-foreground/80">能力需求：</strong>你可以設定別名需要「工具呼叫」或「視覺能力」，路由器只會選擇支援這些能力的模型。</p>
                <p><strong className="text-foreground/80">快速開始：</strong>點擊下方的預設別名按鈕一鍵建立常用別名，或手動在右側表單中建立自訂別名。</p>
              </div>
            </details>
          </CardContent>
        </Card>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Preset Quick-Add */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Preset Aliases</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              One-click add for standard forwarding aliases. Each preset wires a semantic name to a route policy.
            </p>
            <div className="flex flex-wrap gap-2">
              {PRESET_ALIASES.map((preset) => {
                const exists = items.some((vm) => vm.model_id === preset.model_id);
                return (
                  <button
                    key={preset.model_id}
                    disabled={exists}
                    onClick={() => handleAddPreset(preset)}
                    className={[
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                      exists
                        ? "border-border/25 bg-muted/20 text-muted-foreground cursor-not-allowed"
                        : "border-border/50 bg-card hover:bg-accent cursor-pointer",
                    ].join(" ")}
                  >
                    <span className="font-mono text-xs opacity-60">{POLICY_ICON[preset.preferred_policy] ?? "→"}</span>
                    <span className="font-semibold">{preset.model_id}</span>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${POLICY_BADGE_CLASS[preset.preferred_policy] ?? ""}`}
                    >
                      {preset.preferred_policy}
                    </Badge>
                    {exists && <span className="text-[10px] text-muted-foreground">added</span>}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
          {/* ---- Table ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Active Aliases</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
              ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No aliases yet — add a preset or create one manually.
                </p>
              ) : (
                <div className="space-y-2">
                  {items.map((vm) => {
                    const h = parseHints(vm.routing_hints_json);
                    const policy = h.preferred_policy ?? "local_first";
                    return (
                      <div
                        key={vm.id}
                        className={[
                          "flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 transition-colors",
                          vm.enabled
                            ? "border-border/40 bg-background/60"
                            : "border-border/20 bg-muted/20 opacity-60",
                        ].join(" ")}
                      >
                        {/* Left — alias info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-semibold text-sm">{vm.model_id}</span>
                            {vm.display_name && vm.display_name !== vm.model_id && (
                              <span className="text-xs text-muted-foreground">({vm.display_name})</span>
                            )}
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${POLICY_BADGE_CLASS[policy] ?? ""}`}
                            >
                              {POLICY_ICON[policy]} {policy}
                            </Badge>
                            {h.requires_tools && (
                              <Badge variant="outline" className="text-[10px] bg-orange-500/10 text-orange-300 border-orange-400/30">
                                tools
                              </Badge>
                            )}
                            {h.requires_vision && (
                              <Badge variant="outline" className="text-[10px] bg-purple-500/10 text-purple-300 border-purple-400/30">
                                vision
                              </Badge>
                            )}
                            {!vm.enabled && (
                              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                disabled
                              </Badge>
                            )}
                          </div>
                          {vm.description && (
                            <p className="mt-1 text-xs text-muted-foreground truncate max-w-lg">{vm.description}</p>
                          )}
                        </div>

                        {/* Right — actions */}
                        <div className="flex items-center gap-2 shrink-0">
                          {pendingDeleteId === vm.id ? (
                            <>
                              <span className="text-xs text-destructive">Delete?</span>
                              <Button size="sm" variant="destructive" onClick={() => handleDelete(vm.id)}>
                                Yes
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setPendingDeleteId(null)}>
                                No
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleEdit(vm)}
                              >
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setPendingDeleteId(vm.id)}
                              >
                                ✕
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ---- Form ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm self-start sticky top-8">
            <CardHeader>
              <CardTitle className="text-base">
                {editingId !== null ? "Edit Alias" : "New Alias"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Alias ID */}
              <div className="space-y-1.5">
                <Label htmlFor="model_id">Alias ID</Label>
                <Input
                  id="model_id"
                  placeholder="e.g. coding"
                  value={form.model_id}
                  onChange={(e) => setForm((p) => ({ ...p, model_id: e.target.value.toLowerCase().replace(/\s+/g, "-") }))}
                  className="font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  The model name clients send, e.g.{" "}
                  <code className="bg-muted px-1 rounded">-m coding</code>
                </p>
              </div>

              {/* Display Name */}
              <div className="space-y-1.5">
                <Label htmlFor="display_name">Display Name</Label>
                <Input
                  id="display_name"
                  placeholder="Human-readable label"
                  value={form.display_name}
                  onChange={(e) => setForm((p) => ({ ...p, display_name: e.target.value }))}
                />
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  placeholder="Optional description"
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                />
              </div>

              {/* Route Policy */}
              <div className="space-y-1.5">
                <Label htmlFor="policy">Route Policy</Label>
                <select
                  id="policy"
                  value={hints.preferred_policy ?? "local_first"}
                  onChange={(e) => setHints({ preferred_policy: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {policies.length === 0 ? (
                    <option value="local_first">local_first — Local First</option>
                  ) : (
                    policies.map((p) => (
                      <option key={p.value} value={p.value}>
                        {POLICY_ICON[p.value]} {p.value} — {p.label.split("—").slice(1).join("—").trim()}
                      </option>
                    ))
                  )}
                </select>
                {hints.preferred_policy && (
                  <Badge
                    variant="outline"
                    className={`mt-1 text-[10px] ${POLICY_BADGE_CLASS[hints.preferred_policy] ?? ""}`}
                  >
                    {POLICY_ICON[hints.preferred_policy]} {policyLabel(policies, hints.preferred_policy)}
                  </Badge>
                )}
              </div>

              {/* Capability Flags */}
              <div className="rounded-md border border-border/40 bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Capability Requirements
                </p>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="req_tools" className="text-sm">Requires Tool Calling</Label>
                    <p className="text-[11px] text-muted-foreground">Only route to tool-capable backends</p>
                  </div>
                  <Switch
                    id="req_tools"
                    checked={hints.requires_tools ?? false}
                    onCheckedChange={(v) => setHints({ requires_tools: v })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="req_vision" className="text-sm">Requires Vision</Label>
                    <p className="text-[11px] text-muted-foreground">Only route to vision-capable backends</p>
                  </div>
                  <Switch
                    id="req_vision"
                    checked={hints.requires_vision ?? false}
                    onCheckedChange={(v) => setHints({ requires_vision: v })}
                  />
                </div>
              </div>

              {/* Enabled toggle */}
              <div className="flex items-center justify-between">
                <Label htmlFor="enabled">Enabled</Label>
                <Switch
                  id="enabled"
                  checked={form.enabled}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                />
              </div>

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <Button className="flex-1" onClick={handleSubmit} disabled={saving || !form.model_id.trim()}>
                  {saving ? "Saving…" : editingId !== null ? "Update" : "Add Alias"}
                </Button>
                {editingId !== null && (
                  <Button variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                )}
              </div>

              {/* Routing hints preview */}
              <details className="mt-2">
                <summary className="text-[11px] text-muted-foreground cursor-pointer select-none">
                  Routing hints JSON preview
                </summary>
                <pre className="mt-2 rounded-md bg-muted/40 p-2 text-[11px] font-mono overflow-x-auto">
                  {JSON.stringify(form.routing_hints, null, 2)}
                </pre>
              </details>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
