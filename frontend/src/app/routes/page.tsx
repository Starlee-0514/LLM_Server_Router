"use client";

import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  createModelRoute,
  deleteModelRoute,
  getModelRoutes,
  getProviderModels,
  getProviders,
  updateModelRoute,
  type ModelRouteItem,
  type ModelRoutePayload,
  type ProviderEndpoint,
} from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Searchable Dropdown                                                 */
/* ------------------------------------------------------------------ */
function SearchableDropdown({
  value,
  options,
  onChange,
  placeholder,
  loading,
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
  placeholder?: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    if (!q) return options;
    const lower = q.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(lower) || o.value.toLowerCase().includes(lower),
    );
  }, [options, q]);

  const displayLabel =
    options.find((o) => o.value === value)?.label ?? (value || placeholder || "Select…");

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setQ("");
        }}
        className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2 text-xs truncate"
      >
        <span className="truncate">{loading ? "Scanning…" : displayLabel}</span>
        <span className="ml-1 text-muted-foreground/60 shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-full min-w-[200px] rounded-md border border-border bg-popover shadow-md">
          <div className="p-1.5">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="h-7 w-full rounded border border-input bg-background px-2 text-xs outline-none focus:border-ring"
            />
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`flex w-full items-center px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors text-left ${
                    o.value === value ? "bg-muted/40 font-semibold" : ""
                  }`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RoutesPage                                                          */
/* ------------------------------------------------------------------ */
export default function RoutesPage() {
  const [routes, setRoutes] = useState<ModelRouteItem[]>([]);
  const [providers, setProviders] = useState<ProviderEndpoint[]>([]);
  const [selectedRouteName, setSelectedRouteName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Per-provider model lists
  const [providerModelsCache, setProviderModelsCache] = useState<Record<number, string[]>>({});
  const [scanningModels, setScanningModels] = useState<Record<number, boolean>>({});

  // Column width
  const [leftColWidth, setLeftColWidth] = useState(260);

  // New route creation (left panel)
  const [newRouteName, setNewRouteName] = useState<string | null>(null);
  const [newRouteMatchValue, setNewRouteMatchValue] = useState("");
  const [newRouteMatchType, setNewRouteMatchType] = useState<"exact" | "prefix">("exact");

  // New pairing creation (right panel)
  const [newPairing, setNewPairing] = useState<{ provider_id: number; target_model: string } | null>(null);

  // Editing route name
  const [editingRouteName, setEditingRouteName] = useState<string | null>(null);
  const [editRouteNameValue, setEditRouteNameValue] = useState("");

  // Editing match value
  const [editingMatchValue, setEditingMatchValue] = useState(false);
  const [editMatchValueText, setEditMatchValueText] = useState("");

  // Delete confirmation
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  // Drag state
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const providerMap = useMemo(() => {
    const map = new Map<number, ProviderEndpoint>();
    for (const p of providers) map.set(p.id, p);
    return map;
  }, [providers]);

  // Group routes by route_name
  const routeNames = useMemo(() => {
    const groups = new Map<string, ModelRouteItem[]>();
    for (const r of routes) {
      const arr = groups.get(r.route_name) ?? [];
      arr.push(r);
      groups.set(r.route_name, arr);
    }
    const entries = Array.from(groups.entries());
    entries.sort((a, b) => {
      const aMin = Math.min(...a[1].map((x) => x.priority));
      const bMin = Math.min(...b[1].map((x) => x.priority));
      return aMin - bMin || a[0].localeCompare(b[0]);
    });
    return entries;
  }, [routes]);

  const filteredRouteNames = useMemo(() => {
    if (!search.trim()) return routeNames;
    const q = search.trim().toLowerCase();
    return routeNames.filter(
      ([name, items]) =>
        name.toLowerCase().includes(q) ||
        items.some(
          (it) =>
            it.match_value.toLowerCase().includes(q) ||
            (it.target_model || "").toLowerCase().includes(q) ||
            (providerMap.get(it.provider_id)?.name ?? "").toLowerCase().includes(q),
        ),
    );
  }, [routeNames, search, providerMap]);

  const selectedRoutes = useMemo(() => {
    if (!selectedRouteName) return [];
    return routes
      .filter((r) => r.route_name === selectedRouteName)
      .sort((a, b) => a.priority - b.priority);
  }, [routes, selectedRouteName]);

  // Selected route group info (from first pairing)
  const selectedGroupInfo = useMemo(() => {
    if (selectedRoutes.length === 0) return null;
    const first = selectedRoutes[0];
    return {
      match_value: first.match_value,
      match_type: first.match_type as "exact" | "prefix",
      supports_tools: first.supports_tools,
      supports_vision: first.supports_vision,
      supports_thinking: first.supports_thinking,
    };
  }, [selectedRoutes]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [routeData, providerData] = await Promise.all([getModelRoutes(), getProviders()]);
      setRoutes(routeData);
      setProviders(providerData);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load routes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-fetch models for local providers on load
  const initialFetchDone = useRef(false);
  useEffect(() => {
    if (initialFetchDone.current || providers.length === 0) return;
    initialFetchDone.current = true;
    const localTypes = new Set(["lmstudio", "ollama"]);
    providers.forEach((p) => {
      if (localTypes.has(p.provider_type)) {
        fetchModelsRaw(p.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const fetchModelsRaw = async (providerId: number) => {
    if (!providerId) return;
    setScanningModels((prev) => ({ ...prev, [providerId]: true }));
    try {
      const models = await getProviderModels(providerId);
      setProviderModelsCache((prev) => ({ ...prev, [providerId]: models.map((m) => m.id) }));
    } catch {
      setProviderModelsCache((prev) => ({ ...prev, [providerId]: [] }));
    } finally {
      setScanningModels((prev) => ({ ...prev, [providerId]: false }));
    }
  };

  const fetchModels = async (providerId: number) => {
    if (!providerId || providerModelsCache[providerId] !== undefined) return;
    await fetchModelsRaw(providerId);
  };

  // Build payload from existing item
  const payloadFromItem = (item: ModelRouteItem): ModelRoutePayload => ({
    route_name: item.route_name,
    match_type: item.match_type,
    match_value: item.match_value,
    target_model: item.target_model || "",
    provider_id: item.provider_id,
    priority: item.priority,
    enabled: item.enabled,
    supports_tools: item.supports_tools,
    supports_vision: item.supports_vision,
    supports_thinking: item.supports_thinking,
  });

  const handleInlineUpdate = async (item: ModelRouteItem, changes: Partial<ModelRoutePayload>) => {
    try {
      await updateModelRoute(item.id, { ...payloadFromItem(item), ...changes });
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Update failed");
    }
  };

  // Batch update without intermediate refreshes
  const batchUpdateRoutes = async (updates: Array<{ id: number; payload: ModelRoutePayload }>) => {
    try {
      await Promise.all(updates.map(({ id, payload }) => updateModelRoute(id, payload)));
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Batch update failed");
    }
  };

  const handleDeleteRoute = async (id: number) => {
    try {
      await deleteModelRoute(id);
      setPendingDeleteId(null);
      const remaining = routes.filter((r) => r.route_name === selectedRouteName && r.id !== id);
      if (remaining.length === 0) setSelectedRouteName(null);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  // Create new route group
  const handleCreateRouteName = async () => {
    if (!newRouteName?.trim()) return;
    const name = newRouteName.trim();
    const matchVal = newRouteMatchValue.trim() || name;
    try {
      await createModelRoute({
        route_name: name,
        match_type: newRouteMatchType,
        match_value: matchVal,
        target_model: "",
        provider_id: providers[0]?.id ?? 0,
        priority: 100,
        enabled: true,
      });
      setNewRouteName(null);
      setNewRouteMatchValue("");
      setNewRouteMatchType("exact");
      await refresh();
      setSelectedRouteName(name);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Create failed");
    }
  };

  // Create new pairing under selected route
  const handleCreatePairing = async () => {
    if (!selectedRouteName || !newPairing) return;
    const existing = routes.find((r) => r.route_name === selectedRouteName);
    const matchType = existing?.match_type ?? "exact";
    const matchValue = existing?.match_value ?? selectedRouteName;
    const count = routes.filter((r) => r.route_name === selectedRouteName).length;
    try {
      await createModelRoute({
        route_name: selectedRouteName,
        match_type: matchType,
        match_value: matchValue,
        target_model: newPairing.target_model,
        provider_id: newPairing.provider_id,
        priority: 100 + count,
        enabled: true,
        supports_tools: selectedGroupInfo?.supports_tools,
        supports_vision: selectedGroupInfo?.supports_vision,
        supports_thinking: selectedGroupInfo?.supports_thinking,
      });
      setNewPairing(null);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Create pairing failed");
    }
  };

  // Rename route (updates all pairings)
  const handleRenameRoute = async (oldName: string, newName: string) => {
    if (!newName.trim() || newName.trim() === oldName) {
      setEditingRouteName(null);
      return;
    }
    const toUpdate = routes.filter((r) => r.route_name === oldName);
    await batchUpdateRoutes(
      toUpdate.map((item) => ({
        id: item.id,
        payload: { ...payloadFromItem(item), route_name: newName.trim() },
      })),
    );
    setEditingRouteName(null);
    setSelectedRouteName(newName.trim());
  };

  // Update match value for all pairings in group
  const handleUpdateMatchValue = async (newVal: string) => {
    if (!selectedRouteName || !newVal.trim()) {
      setEditingMatchValue(false);
      return;
    }
    const toUpdate = routes.filter((r) => r.route_name === selectedRouteName);
    await batchUpdateRoutes(
      toUpdate.map((item) => ({
        id: item.id,
        payload: { ...payloadFromItem(item), match_value: newVal.trim() },
      })),
    );
    setEditingMatchValue(false);
  };

  // Update match type for all pairings in group
  const handleUpdateMatchType = async (newType: "exact" | "prefix") => {
    if (!selectedRouteName) return;
    const toUpdate = routes.filter((r) => r.route_name === selectedRouteName);
    await batchUpdateRoutes(
      toUpdate.map((item) => ({
        id: item.id,
        payload: { ...payloadFromItem(item), match_type: newType },
      })),
    );
  };

  // Toggle capability for all pairings in group
  const handleCapabilityToggle = async (
    field: "supports_tools" | "supports_vision" | "supports_thinking",
    value: boolean,
  ) => {
    if (!selectedRouteName) return;
    const toUpdate = routes.filter((r) => r.route_name === selectedRouteName);
    await batchUpdateRoutes(
      toUpdate.map((item) => ({
        id: item.id,
        payload: { ...payloadFromItem(item), [field]: value },
      })),
    );
  };

  // Drag and drop handlers
  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  };

  const handleDrop = async (dropIndex: number) => {
    const srcIndex = dragIndexRef.current;
    setDragOverIndex(null);
    dragIndexRef.current = null;
    if (srcIndex === null || srcIndex === dropIndex) return;

    const items = [...selectedRoutes];
    const [moved] = items.splice(srcIndex, 1);
    items.splice(dropIndex, 0, moved);

    // Reassign priorities sequentially
    await batchUpdateRoutes(
      items.map((item, i) => ({
        id: item.id,
        payload: { ...payloadFromItem(item), priority: 100 + i },
      })),
    );
  };

  const providerOptions = useMemo(() => {
    const localTypes = new Set(["lmstudio", "ollama"]);
    return providers.map((p) => ({
      label: `${localTypes.has(p.provider_type) ? "🖥 " : ""}${p.name} (${p.provider_type})`,
      value: String(p.id),
    }));
  }, [providers]);

  const modelOptions = useCallback(
    (providerId: number) => {
      const models = providerModelsCache[providerId] ?? [];
      return [
        { label: "(auto — use provider default)", value: "" },
        ...models.map((m) => ({ label: m, value: m })),
      ];
    },
    [providerModelsCache],
  );

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200 overflow-x-hidden">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Model Routes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            設定模型名稱匹配規則，將請求路由到不同 provider。同一路由名稱可綁定多個供應商，依優先順序自動切換。
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
            <button className="ml-2 underline text-xs" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        {/* Column Width Adjustment */}
        <div className="mb-4 rounded-2xl border border-border/40 bg-card/55 p-3 backdrop-blur-sm">
          <label className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="shrink-0">Left Panel Width</span>
            <input
              type="range"
              min="180"
              max="450"
              step="10"
              value={leftColWidth}
              onChange={(e) => setLeftColWidth(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-12 text-right font-mono shrink-0">{leftColWidth}px</span>
          </label>
        </div>

        {/* Routing Edit — master-detail two-panel */}
        <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">
                Routing Edit
                {loading && (
                  <span className="text-xs font-normal text-muted-foreground ml-2">Loading…</span>
                )}
              </CardTitle>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search routes…"
                className="h-8 w-52 text-xs"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* Column headers */}
            <div
              className="grid divide-x divide-border/40 border-b border-border/40 bg-muted/30"
              style={{ gridTemplateColumns: `${leftColWidth}px 1fr` }}
            >
              <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Route Name
              </div>
              <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Model Pairing{" "}
                <span className="font-normal">(provider → model, drag to reorder)</span>
              </div>
            </div>

            {/* Two-panel body */}
            <div
              className="grid divide-x divide-border/40 min-h-[300px]"
              style={{ gridTemplateColumns: `${leftColWidth}px 1fr` }}
            >
              {/* ==================== Left panel ==================== */}
              <div className="flex flex-col">
                <div className="flex-1 overflow-y-auto max-h-[520px]">
                  {filteredRouteNames.length === 0 && newRouteName === null && (
                    <div className="py-8 text-center text-xs text-muted-foreground">
                      No routes yet.
                    </div>
                  )}
                  {filteredRouteNames.map(([name, items]) => {
                    const isSelected = name === selectedRouteName;
                    const pairingCount = items.length;
                    const matchVal = items[0]?.match_value ?? name;
                    const isEditing = editingRouteName === name;

                    if (isEditing) {
                      return (
                        <div key={name} className="px-3 py-2 border-b border-border/20 bg-muted/40">
                          <input
                            autoFocus
                            value={editRouteNameValue}
                            onChange={(e) => setEditRouteNameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRenameRoute(name, editRouteNameValue);
                              if (e.key === "Escape") setEditingRouteName(null);
                            }}
                            onBlur={() => handleRenameRoute(name, editRouteNameValue)}
                            className="h-7 w-full rounded border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                          />
                        </div>
                      );
                    }

                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => {
                          setSelectedRouteName(isSelected ? null : name);
                          setNewPairing(null);
                          setPendingDeleteId(null);
                          setEditingMatchValue(false);
                        }}
                        onDoubleClick={() => {
                          setEditingRouteName(name);
                          setEditRouteNameValue(name);
                        }}
                        className={`group w-full text-left px-4 py-3 border-b border-border/20 transition-colors ${
                          isSelected
                            ? "bg-muted/60 border-l-2 border-l-ring"
                            : "hover:bg-muted/30 border-l-2 border-l-transparent"
                        }`}
                      >
                        <p className="text-sm font-medium truncate">{name}</p>
                        {matchVal !== name && (
                          <p className="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">
                            match: {matchVal}
                          </p>
                        )}
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-muted-foreground">
                            {pairingCount} pairing{pairingCount !== 1 ? "s" : ""}
                          </span>
                          {items[0]?.supports_tools && (
                            <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 bg-orange-500/10 text-orange-300 border-orange-400/30">
                              tools
                            </Badge>
                          )}
                          {items[0]?.supports_vision && (
                            <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 bg-cyan-500/10 text-cyan-300 border-cyan-400/30">
                              vision
                            </Badge>
                          )}
                          {items[0]?.supports_thinking && (
                            <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 bg-violet-500/10 text-violet-300 border-violet-400/30">
                              think
                            </Badge>
                          )}
                        </div>
                      </button>
                    );
                  })}

                  {/* New route form */}
                  {newRouteName !== null && (
                    <div className="px-3 py-2 border-b border-border/20 space-y-1.5">
                      <input
                        autoFocus
                        value={newRouteName}
                        onChange={(e) => setNewRouteName(e.target.value)}
                        placeholder="Route display name…"
                        className="h-7 w-full rounded border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleCreateRouteName();
                          if (e.key === "Escape") {
                            setNewRouteName(null);
                            setNewRouteMatchValue("");
                          }
                        }}
                      />
                      <input
                        value={newRouteMatchValue}
                        onChange={(e) => setNewRouteMatchValue(e.target.value)}
                        placeholder="Match pattern (defaults to name)"
                        className="h-7 w-full rounded border border-input bg-background px-2 text-xs font-mono outline-none focus:border-ring"
                      />
                      <div className="flex items-center gap-1">
                        <select
                          value={newRouteMatchType}
                          onChange={(e) => setNewRouteMatchType(e.target.value as "exact" | "prefix")}
                          className="h-6 rounded border border-input bg-background px-1 text-[10px]"
                        >
                          <option value="exact">exact</option>
                          <option value="prefix">prefix</option>
                        </select>
                        <Button size="sm" className="h-6 text-[10px] px-2" onClick={handleCreateRouteName}>
                          Create
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] px-2"
                          onClick={() => {
                            setNewRouteName(null);
                            setNewRouteMatchValue("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setNewRouteName("")}
                  className="px-4 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-left border-t border-border/40"
                >
                  + Add new route
                </button>
              </div>

              {/* ==================== Right panel ==================== */}
              <div className="flex flex-col">
                {selectedRouteName === null ? (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground py-16">
                    ← Select a route name to see its pairings
                    <br />
                    <span className="text-[11px] block mt-1">Double-click a route name to rename it</span>
                  </div>
                ) : (
                  <>
                    {/* Route group header */}
                    <div className="px-4 py-3 border-b border-border/30 bg-muted/20 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">{selectedRouteName}</span>
                        {selectedGroupInfo && (
                          <>
                            {!editingMatchValue ? (
                              <>
                                <Badge variant="outline" className="text-[10px] font-mono">
                                  {selectedGroupInfo.match_type}: {selectedGroupInfo.match_value}
                                </Badge>
                                <button
                                  className="text-[10px] text-muted-foreground hover:text-foreground underline"
                                  onClick={() => {
                                    setEditingMatchValue(true);
                                    setEditMatchValueText(selectedGroupInfo.match_value);
                                  }}
                                >
                                  edit pattern
                                </button>
                              </>
                            ) : (
                              <div className="flex items-center gap-1">
                                <select
                                  value={selectedGroupInfo.match_type}
                                  onChange={(e) => handleUpdateMatchType(e.target.value as "exact" | "prefix")}
                                  className="h-6 rounded border border-input bg-background px-1 text-[10px]"
                                >
                                  <option value="exact">exact</option>
                                  <option value="prefix">prefix</option>
                                </select>
                                <input
                                  autoFocus
                                  value={editMatchValueText}
                                  onChange={(e) => setEditMatchValueText(e.target.value)}
                                  className="h-6 w-40 rounded border border-input bg-background px-1.5 text-[10px] font-mono outline-none focus:border-ring"
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleUpdateMatchValue(editMatchValueText);
                                    if (e.key === "Escape") setEditingMatchValue(false);
                                  }}
                                />
                                <Button
                                  size="sm"
                                  className="h-5 text-[9px] px-1.5"
                                  onClick={() => handleUpdateMatchValue(editMatchValueText)}
                                >
                                  OK
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 text-[9px] px-1.5"
                                  onClick={() => setEditingMatchValue(false)}
                                >
                                  ✕
                                </Button>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      {/* Capability toggles */}
                      <div className="flex items-center gap-4 flex-wrap">
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={selectedGroupInfo?.supports_tools ?? false}
                            onChange={(e) => handleCapabilityToggle("supports_tools", e.target.checked)}
                            className="rounded"
                          />
                          <span>🔧 Tool Calling</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={selectedGroupInfo?.supports_vision ?? false}
                            onChange={(e) => handleCapabilityToggle("supports_vision", e.target.checked)}
                            className="rounded"
                          />
                          <span>👁 Vision</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={selectedGroupInfo?.supports_thinking ?? false}
                            onChange={(e) => handleCapabilityToggle("supports_thinking", e.target.checked)}
                            className="rounded"
                          />
                          <span>🧠 Thinking</span>
                        </label>
                      </div>
                    </div>

                    {/* Pairings list */}
                    <div className="flex-1 overflow-y-auto max-h-[420px]">
                      {selectedRoutes.length === 0 && !newPairing && (
                        <div className="py-8 text-center text-xs text-muted-foreground">
                          No pairings for &quot;{selectedRouteName}&quot;.
                        </div>
                      )}
                      {selectedRoutes.map((item, idx) => (
                        <div
                          key={item.id}
                          draggable
                          onDragStart={(e) => {
                            dragIndexRef.current = idx;
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", String(idx));
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            setDragOverIndex(idx);
                          }}
                          onDragLeave={() => setDragOverIndex(null)}
                          onDrop={(e) => {
                            e.preventDefault();
                            handleDrop(idx);
                          }}
                          onDragEnd={handleDragEnd}
                          className={`border-b border-border/20 px-4 py-3 transition-colors ${
                            dragOverIndex === idx
                              ? "bg-sky-500/10 border-t-2 border-t-sky-400/60"
                              : ""
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="text-muted-foreground/40 text-base select-none cursor-grab shrink-0 active:cursor-grabbing"
                              title="Drag to reorder"
                            >
                              ⠿
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[9px] shrink-0 font-mono tabular-nums w-7 justify-center"
                            >
                              {idx + 1}
                            </Badge>

                            {/* Provider dropdown */}
                            <SearchableDropdown
                              value={String(item.provider_id)}
                              options={providerOptions}
                              onChange={async (v) => {
                                const pid = Number(v);
                                await fetchModels(pid);
                                await handleInlineUpdate(item, {
                                  provider_id: pid,
                                  target_model: "",
                                });
                              }}
                              placeholder="Select provider…"
                            />

                            {/* Model dropdown */}
                            <SearchableDropdown
                              value={item.target_model || ""}
                              options={modelOptions(item.provider_id)}
                              onChange={async (v) => {
                                await handleInlineUpdate(item, { target_model: v });
                              }}
                              placeholder="(auto)"
                              loading={scanningModels[item.provider_id]}
                            />

                            {pendingDeleteId === item.id ? (
                              <div className="flex gap-1 shrink-0">
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="h-6 text-[10px] px-2"
                                  onClick={() => handleDeleteRoute(item.id)}
                                >
                                  Delete
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-[10px] px-2"
                                  onClick={() => setPendingDeleteId(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setPendingDeleteId(item.id)}
                                className="shrink-0 text-muted-foreground/40 hover:text-destructive transition-colors text-sm px-1"
                                title="Delete pairing"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                      ))}

                      {/* New pairing form */}
                      {newPairing && selectedRouteName && (
                        <div className="border-b border-border/20 px-4 py-3 bg-muted/10">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground/20 text-base select-none shrink-0">
                              ⠿
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[9px] shrink-0 font-mono tabular-nums w-7 justify-center opacity-40"
                            >
                              {selectedRoutes.length + 1}
                            </Badge>
                            <SearchableDropdown
                              value={String(newPairing.provider_id)}
                              options={providerOptions}
                              onChange={(v) => {
                                const pid = Number(v);
                                fetchModels(pid);
                                setNewPairing({
                                  ...newPairing,
                                  provider_id: pid,
                                  target_model: "",
                                });
                              }}
                              placeholder="Select provider…"
                            />
                            <SearchableDropdown
                              value={newPairing.target_model}
                              options={modelOptions(newPairing.provider_id)}
                              onChange={(v) =>
                                setNewPairing({ ...newPairing, target_model: v })
                              }
                              placeholder="(auto)"
                              loading={scanningModels[newPairing.provider_id]}
                            />
                            <Button
                              size="sm"
                              className="h-7 shrink-0 text-xs px-2"
                              onClick={handleCreatePairing}
                            >
                              Save
                            </Button>
                            <button
                              type="button"
                              onClick={() => setNewPairing(null)}
                              className="shrink-0 text-muted-foreground/40 hover:text-foreground text-sm px-1"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <button
                      type="button"
                      onClick={() =>
                        setNewPairing({
                          provider_id: providers[0]?.id ?? 0,
                          target_model: "",
                        })
                      }
                      className="px-4 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-left border-t border-border/40"
                    >
                      + Add pairing
                    </button>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
