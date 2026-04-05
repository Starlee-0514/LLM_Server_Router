"use client";

import { useEffect, useState, useRef } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  getBenchmarkHistory,
  getModelGroups,
  runBenchmarkStream,
  deleteBenchmark,
  importBenchmarks,
  getSettings,
  type BenchmarkRecord,
  type ModelGroup,
} from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { PRESET_RECIPES, type PresetRecipe } from "@/lib/model-preset-recipes";

type CompareMode = "all" | "same_model" | "same_preset" | "same_engine" | "same_recipe" | "same_ctx";

export default function BenchmarksPage() {
  const [records, setRecords] = useState<BenchmarkRecord[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // Model and preset selection (separated)
  const [selectedModel, setSelectedModel] = useState<string>("all");
  const [modelSearchInput, setModelSearchInput] = useState("");
  const [selectedPresetIds, setSelectedPresetIds] = useState<string[]>([]);
  const [presetSearchInput, setPresetSearchInput] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);

  const [recipeFilter, setRecipeFilter] = useState<string>("all");
  // Recipe override for benchmark runs
  const [benchRecipeOverride, setBenchRecipeOverride] = useState<string>("preset");
  const [customRecipes, setCustomRecipes] = useState<PresetRecipe[]>([]);

  const [batchSizesStr, setBatchSizesStr] = useState("");
  const [n_gpu_layersStr, setN_gpu_layersStr] = useState("");
  const [nPrompt, setNPrompt] = useState(512);
  const [nGen, setNGen] = useState(128);
  const [flashAttn, setFlashAttn] = useState(0);
  const [noKvOffload, setNoKvOffload] = useState(0);
  const [kvCacheType, setKvCacheType] = useState("f16");
  const [filterModel, setFilterModel] = useState<string>("all");
  const [filterEngine, setFilterEngine] = useState<string>("all");
  const [debugLog, setDebugLog] = useState<string>("");
  const logEndRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Comparison view - expanded with more grouping options
  const [compareMode, setCompareMode] = useState<CompareMode>("all");
  const [compareModel, setCompareModel] = useState<string>("all");
  const [comparePreset, setComparePreset] = useState<string>("all");
  const [compareEngine, setCompareEngine] = useState<string>("all");
  const [compareRecipe, setCompareRecipe] = useState<string>("all");
  const [compareCtx, setCompareCtx] = useState<string>("all");

  // Sorting for performance comparison
  type SortField = "tg" | "pp" | "model" | "recipe" | "ctx" | "date";
  const [sortField, setSortField] = useState<SortField>("tg");
  const [sortAsc, setSortAsc] = useState(false);

  // Collapsible sections
  const [runOpen, setRunOpen] = useState(true);
  const [comparisonOpen, setComparisonOpen] = useState(true);
  const [tableOpen, setTableOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);

  const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown error";

  // Restore debug log from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("benchmark_debug_log");
    if (saved) setDebugLog(saved);
  }, []);

  // Persist debug log to localStorage on every change
  useEffect(() => {
    localStorage.setItem("benchmark_debug_log", debugLog);
  }, [debugLog]);

  const scrollLogToBottom = () => {
    const container = logContainerRef.current;
    if (!container) return;
    // Only auto-scroll if user is near the bottom (within 80px)
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    if (isNearBottom) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };

  useEffect(() => {
    scrollLogToBottom();
  }, [debugLog]);

  const clearLog = () => {
    setDebugLog("");
    localStorage.removeItem("benchmark_debug_log");
  };

  // Separate model selection and preset selection logic
  const togglePresetSelection = (idStr: string) => {
    setSelectedPresetIds((prev) =>
      prev.includes(idStr) ? prev.filter((id) => id !== idStr) : [...prev, idStr]
    );
  };

  // Combined recipe list (built-in + custom)
  const allRecipes = [...PRESET_RECIPES, ...customRecipes];

  const selectAllPresets = () => {
    const filtered = recipeFilteredPresets
      .filter((g) => g.name.toLowerCase().includes(presetSearchInput.toLowerCase()) || g.group_name.toLowerCase().includes(presetSearchInput.toLowerCase()))
      .map((g) => String(g.id));
    setSelectedPresetIds(filtered);
  };

  const clearPresetSelection = () => {
    setSelectedPresetIds([]);
  };

  // Get filtered presets based on model selection
  const filteredPresets = selectedModel === "all"
    ? groups
    : groups.filter((g) => g.name === selectedModel);

  // Recipe filter options: recipes assigned to groups + all known recipe keys
  const assignedRecipeKeys = Array.from(new Set(filteredPresets.map((g) => g.preset_recipe).filter(Boolean)));
  const allRecipeKeys = Array.from(new Set([...assignedRecipeKeys, ...allRecipes.map((r) => r.key)])).sort();
  const availableRecipes = allRecipeKeys;

  // Apply recipe filter
  const recipeFilteredPresets = recipeFilter === "all"
    ? filteredPresets
    : filteredPresets.filter((g) => g.preset_recipe === recipeFilter);

  // Get filtered presets by search
  const searchedPresets = recipeFilteredPresets.filter((g) =>
    g.name.toLowerCase().includes(presetSearchInput.toLowerCase()) ||
    g.group_name.toLowerCase().includes(presetSearchInput.toLowerCase())
  );

  // Get model names (unique model paths)
  const modelNames = Array.from(new Set(groups.map((g) => g.name))).sort();
  const filteredModels = modelNames.filter((m) =>
    m.toLowerCase().includes(modelSearchInput.toLowerCase())
  );

  // Pre-fill batch/ngl from first selected preset
  useEffect(() => {
    if (selectedPresetIds.length === 1) {
      const preset = groups.find((g) => g.id === parseInt(selectedPresetIds[0]));
      if (preset && !batchSizesStr) {
        setBatchSizesStr(String(preset.batch_size));
        setN_gpu_layersStr(String(preset.n_gpu_layers));
      }
    }
  }, [selectedPresetIds, groups, batchSizesStr]);

  const refresh = async () => {
    setLoading(true);
    try {
      const [data, groupsData, settingsItems] = await Promise.all([
        getBenchmarkHistory(),
        getModelGroups(),
        getSettings(),
      ]);
      setRecords(data);
      setGroups(groupsData);
      const customRecipesRaw = settingsItems.find((item) => item.key === "custom_preset_recipes")?.value ?? "[]";
      try { setCustomRecipes(JSON.parse(customRecipesRaw)); } catch { setCustomRecipes([]); }
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRun = async () => {
    if (selectedPresetIds.length === 0) return;
    const selectedGroups = groups.filter((g) => selectedPresetIds.includes(String(g.id)));
    if (selectedGroups.length === 0) return;

    const batches = batchSizesStr.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    const ngls = n_gpu_layersStr.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));

    setRunning(true);
    let total = selectedGroups.length * Math.max(batches.length, 1) * Math.max(ngls.length, 1);
    let completed = 0;
    try {
      for (const group of selectedGroups) {
        const groupBatches = batches.length > 0 ? batches : [group.batch_size];
        const groupNgls = ngls.length > 0 ? ngls : [group.n_gpu_layers];
        total = selectedGroups.reduce((acc, g) => {
          const gb = batches.length > 0 ? batches : [g.batch_size];
          const gn = ngls.length > 0 ? ngls : [g.n_gpu_layers];
          return acc + gb.length * gn.length;
        }, 0);

        for (const batch of groupBatches) {
          for (const ngl of groupNgls) {
            completed++;
            // Resolve recipe: override > group's assigned recipe > manual UI controls
            const recipeKey = benchRecipeOverride !== "preset" ? benchRecipeOverride : group.preset_recipe;
            const recipe = recipeKey ? allRecipes.find((r) => r.key === recipeKey) ?? null : null;
            const effectiveRecipeLabel = recipe ? recipe.key : "manual";
            const recipeFlashAttn = recipe ? (recipe.options.flashAttn ? 1 : 0) : flashAttn;
            const recipeNoKvOffload = recipe ? (recipe.options.noKvOffload ? 1 : 0) : noKvOffload;
            const recipeCacheTypeK = recipe?.options.cacheTypeK || (recipeFlashAttn === 1 ? kvCacheType : "f16");
            const recipeCacheTypeV = recipe?.options.cacheTypeV || (recipeFlashAttn === 1 ? kvCacheType : "f16");
            setDebugLog((prev) => prev + `\n━━━ Test ${completed}/${total}: ${group.name} (Recipe: ${effectiveRecipeLabel}, NGL: ${ngl}, Batch: ${batch}, pp: ${nPrompt}, tg: ${nGen}) ━━━\n`);
          await runBenchmarkStream(
            {
              model_name: group.name,
              model_path: group.model_path,
              engine_type: group.engine_type,
              n_gpu_layers: ngl,
              batch_size: batch,
              ubatch_size: group.ubatch_size,
              ctx_size: group.ctx_size,
              preset_recipe: effectiveRecipeLabel,
              n_prompt: nPrompt,
              n_gen: nGen,
              flash_attn: recipeFlashAttn,
              no_kv_offload: recipeNoKvOffload,
              cache_type_k: recipeCacheTypeK,
              cache_type_v: recipeCacheTypeV,
            },
            (line) => {
              // Real-time log line callback
              setDebugLog((prev) => prev + line + "\n");
            },
          );
          setDebugLog((prev) => prev + `✓ Test ${completed}/${total} completed\n`);
          await refresh();
        }
      }
      }
      setDebugLog((prev) => prev + `\n══════ All ${total} benchmark(s) finished ══════\n`);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      setDebugLog((prev) => prev + `\n[ERROR] ${message}\n`);
      alert("Error: " + message);
    } finally {
      setRunning(false);
    }
  };

  const handleDeleteRecord = async (id: number) => {
    if (!confirm("Delete this record?")) return;
    try { await deleteBenchmark(id); await refresh(); } catch (error: unknown) { alert(getErrorMessage(error)); }
  };

  const handleExport = () => {
    const dataStr = JSON.stringify(records, null, 2);
    const dataUri = "data:application/json;charset=utf-8," + encodeURIComponent(dataStr);
    const a = document.createElement("a");
    a.setAttribute("href", dataUri);
    a.setAttribute("download", `benchmarks_${new Date().toISOString().split("T")[0]}.json`);
    a.click();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        await importBenchmarks(Array.isArray(json) ? json : [json]);
        alert("Import successful!");
        await refresh();
      } catch (error: unknown) {
        alert("Import failed: " + getErrorMessage(error));
      }
    };
    reader.readAsText(file);
  };

  const bestPp = Math.max(...records.filter((r) => r.pp_tokens_per_second).map((r) => r.pp_tokens_per_second!), 0);
  const bestTg = Math.max(...records.filter((r) => r.tg_tokens_per_second).map((r) => r.tg_tokens_per_second!), 0);
  const modelOptions = Array.from(new Set(records.map((r) => r.model_name))).sort();
  const engineOptions = Array.from(new Set(records.map((r) => r.engine_type))).sort();
  const recipeOptions = Array.from(new Set(records.map((r) => r.preset_recipe).filter(Boolean))).sort();
  const ctxOptions = Array.from(new Set(records.map((r) => r.ctx_size))).sort((a, b) => a - b);

  // Derive unique "preset signatures" from benchmark records for comparison
  const presetOptions = Array.from(
    new Set(records.map((r) => `ngl:${r.n_gpu_layers} b:${r.batch_size} ctx:${r.ctx_size}`))
  ).sort();

  const filteredRecords = records.filter((r) => {
    if (filterModel !== "all" && r.model_name !== filterModel) return false;
    if (filterEngine !== "all" && r.engine_type !== filterEngine) return false;
    return true;
  });

  // Group records for comparison views
  const groupedByModel: Record<string, BenchmarkRecord[]> = {};
  const groupedByPreset: Record<string, BenchmarkRecord[]> = {};
  const groupedByEngine: Record<string, BenchmarkRecord[]> = {};
  const groupedByRecipe: Record<string, BenchmarkRecord[]> = {};
  const groupedByCtx: Record<string, BenchmarkRecord[]> = {};

  for (const r of records) {
    if (!groupedByModel[r.model_name]) groupedByModel[r.model_name] = [];
    groupedByModel[r.model_name].push(r);

    const presetKey = `ngl:${r.n_gpu_layers} b:${r.batch_size} ctx:${r.ctx_size}`;
    if (!groupedByPreset[presetKey]) groupedByPreset[presetKey] = [];
    groupedByPreset[presetKey].push(r);

    if (!groupedByEngine[r.engine_type]) groupedByEngine[r.engine_type] = [];
    groupedByEngine[r.engine_type].push(r);

    const recipeKey = r.preset_recipe || "(none)";
    if (!groupedByRecipe[recipeKey]) groupedByRecipe[recipeKey] = [];
    groupedByRecipe[recipeKey].push(r);

    const ctxKey = String(r.ctx_size);
    if (!groupedByCtx[ctxKey]) groupedByCtx[ctxKey] = [];
    groupedByCtx[ctxKey].push(r);
  }

  const sortRecords = (arr: BenchmarkRecord[]) => {
    const sorted = [...arr].sort((a, b) => {
      let diff = 0;
      switch (sortField) {
        case "tg": diff = (a.tg_tokens_per_second ?? 0) - (b.tg_tokens_per_second ?? 0); break;
        case "pp": diff = (a.pp_tokens_per_second ?? 0) - (b.pp_tokens_per_second ?? 0); break;
        case "model": diff = a.model_name.localeCompare(b.model_name); break;
        case "recipe": diff = (a.preset_recipe ?? "").localeCompare(b.preset_recipe ?? ""); break;
        case "ctx": diff = a.ctx_size - b.ctx_size; break;
        case "date": diff = (a.created_at ? new Date(a.created_at).getTime() : 0) - (b.created_at ? new Date(b.created_at).getTime() : 0); break;
      }
      return sortAsc ? diff : -diff;
    });
    return sorted;
  };

  const chartPoints = sortRecords(filteredRecords).slice(0, 20);

  const maxChartValue = Math.max(
    1,
    ...chartPoints.map((item) => Math.max(item.pp_tokens_per_second ?? 0, item.tg_tokens_per_second ?? 0)),
  );

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Benchmark Studio</h1>
            <p className="text-sm text-muted-foreground mt-1">Multi-model / multi-preset comparative benchmarking</p>
          </div>
          <div className="flex gap-2">
            <input type="file" id="import-bench" className="hidden" accept=".json" onChange={handleImport} />
            <Button variant="outline" size="sm" onClick={() => document.getElementById("import-bench")?.click()}>Import JSON</Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={records.length === 0}>Export JSON</Button>
            <Button variant="outline" size="sm" onClick={refresh}>⟳ Refresh</Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Tests</CardTitle></CardHeader>
            <CardContent><span className="text-3xl font-bold">{records.length}</span></CardContent>
          </Card>
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Models Tested</CardTitle></CardHeader>
            <CardContent><span className="text-3xl font-bold">{modelOptions.length}</span></CardContent>
          </Card>
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Best PP t/s</CardTitle></CardHeader>
            <CardContent><span className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">{bestPp > 0 ? bestPp.toFixed(1) : "—"}</span></CardContent>
          </Card>
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Best TG t/s</CardTitle></CardHeader>
            <CardContent><span className="text-3xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">{bestTg > 0 ? bestTg.toFixed(1) : "—"}</span></CardContent>
          </Card>
        </div>

        {/* Grid: Run + Comparison side by side */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
          {/* Run Benchmark Card - Collapsible */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="cursor-pointer select-none flex flex-row items-center justify-between py-3" onClick={() => setRunOpen(!runOpen)}>
              <CardTitle className="text-sm">Run Benchmarks (Multi-Select)</CardTitle>
              <span className="text-xs text-muted-foreground">{runOpen ? "▼" : "▶"}</span>
            </CardHeader>
            {runOpen && (
              <CardContent className="flex flex-col gap-4 pt-0">
                {/* Model Selection Dropdown */}
                <div>
                  <Label className="text-xs mb-2">Select Model</Label>
                  <div className="relative">
                    <button
                      onClick={() => setShowModelDropdown(!showModelDropdown)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-xs text-left flex justify-between items-center hover:bg-accent/20"
                    >
                      <span>{selectedModel === "all" ? "All Models" : selectedModel}</span>
                      <span className="text-xs text-muted-foreground">{showModelDropdown ? "▼" : "▶"}</span>
                    </button>
                    {showModelDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 border border-input bg-background rounded-md shadow-md z-10 max-h-48 overflow-y-auto">
                        <div className="sticky top-0 p-2 border-b border-border/40 bg-background">
                          <Input
                            type="text"
                            placeholder="Search models..."
                            value={modelSearchInput}
                            onChange={(e) => setModelSearchInput(e.target.value)}
                            className="h-7 text-xs"
                          />
                        </div>
                        <div className="p-2 space-y-1">
                          <button
                            onClick={() => {
                              setSelectedModel("all");
                              setShowModelDropdown(false);
                            }}
                            className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-accent/30 ${selectedModel === "all" ? "bg-purple-500/20 text-purple-300" : ""}`}
                          >
                            All Models
                          </button>
                          {filteredModels.map((model) => (
                            <button
                              key={model}
                              onClick={() => {
                                setSelectedModel(model);
                                setShowModelDropdown(false);
                              }}
                              className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-accent/30 ${selectedModel === model ? "bg-purple-500/20 text-purple-300" : ""}`}
                            >
                              {model}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Preset/Configuration Selection Dropdown */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-xs">Select Presets for Benchmarking</Label>
                    <div className="flex gap-1.5">
                      <Button variant="ghost" size="sm" className="text-[10px] h-6 px-2" onClick={selectAllPresets}>Select All</Button>
                      <Button variant="ghost" size="sm" className="text-[10px] h-6 px-2" onClick={clearPresetSelection}>Clear</Button>
                    </div>
                  </div>
                  {/* Recipe filter */}
                  {availableRecipes.length > 0 && (
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">Filter by recipe:</span>
                      <select
                        value={recipeFilter}
                        onChange={(e) => setRecipeFilter(e.target.value)}
                        className="flex-1 h-7 rounded-md border border-input bg-background px-2 py-0 text-xs"
                      >
                        <option value="all" className="bg-background text-foreground">All Recipes</option>
                        {availableRecipes.map((r) => (
                          <option key={r} value={r} className="bg-background text-foreground">{r}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="relative">
                    <button
                      onClick={() => setShowPresetDropdown(!showPresetDropdown)}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-xs text-left hover:bg-accent/20"
                    >
                      <span className="text-muted-foreground">
                        {selectedPresetIds.length === 0 ? "No presets selected" : `${selectedPresetIds.length} preset(s) selected`}
                      </span>
                    </button>
                    {showPresetDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 border border-input bg-background rounded-md shadow-md z-10 max-h-48 overflow-y-auto">
                        <div className="sticky top-0 p-2 border-b border-border/40 bg-background">
                          <Input
                            type="text"
                            placeholder="Search presets..."
                            value={presetSearchInput}
                            onChange={(e) => setPresetSearchInput(e.target.value)}
                            className="h-7 text-xs"
                          />
                        </div>
                        <div className="p-2 space-y-1">
                          {searchedPresets.map((preset) => (
                            <button
                              key={preset.id}
                              onClick={() => togglePresetSelection(String(preset.id))}
                              className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent/30 transition-colors flex items-start gap-2 ${
                                selectedPresetIds.includes(String(preset.id)) ? "bg-purple-500/20 text-purple-300" : ""
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedPresetIds.includes(String(preset.id))}
                                onChange={() => {}}
                                className="mt-0.5"
                              />
                              <div className="flex-1 text-left">
                                <div className="font-medium">{preset.name}</div>
                                <div className="text-[9px] text-muted-foreground">
                                  {preset.engine_type} · NGL:{preset.n_gpu_layers} · B:{preset.batch_size} · Ctx:{preset.ctx_size}
                                  {preset.preset_recipe ? <span className="ml-1 text-purple-400">[{preset.preset_recipe}]</span> : null}
                                </div>
                              </div>
                            </button>
                          ))}
                          {searchedPresets.length === 0 && (
                            <p className="text-xs text-muted-foreground p-2">No matching presets</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {selectedPresetIds.length > 0 && (
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      Selected: {selectedPresetIds.map((id) => groups.find((g) => g.id === parseInt(id))?.name).filter(Boolean).join(", ")}
                    </p>
                  )}
                </div>

                {/* Benchmark parameters */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Recipe Override */}
                  <div className="grid gap-2 col-span-2">
                    <Label className="text-xs">Recipe Override</Label>
                    <select
                      value={benchRecipeOverride}
                      onChange={(e) => setBenchRecipeOverride(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs"
                    >
                      <option value="preset" className="bg-background text-foreground">Use Preset&apos;s Recipe</option>
                      <option value="" className="bg-background text-foreground">Manual (use controls below)</option>
                      {PRESET_RECIPES.map((r) => (
                        <option key={r.key} value={r.key} className="bg-background text-foreground">📋 {r.label}</option>
                      ))}
                      {customRecipes.length > 0 && (
                        <option disabled className="bg-background text-muted-foreground">── Custom ──</option>
                      )}
                      {customRecipes.map((r) => (
                        <option key={r.key} value={r.key} className="bg-background text-foreground">⭐ {r.label}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-muted-foreground">
                      {benchRecipeOverride === "preset" ? "Each model group uses its own assigned recipe." : benchRecipeOverride === "" ? "Using manual Flash Attn / KV controls below." : `Overriding all runs with: ${allRecipes.find((r) => r.key === benchRecipeOverride)?.label ?? benchRecipeOverride}`}
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Batch Sizes (comma-sep)</Label>
                    <Input value={batchSizesStr} onChange={(e) => setBatchSizesStr(e.target.value)} placeholder="use preset default" className="text-xs" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">GPU Layers (comma-sep)</Label>
                    <Input value={n_gpu_layersStr} onChange={(e) => setN_gpu_layersStr(e.target.value)} placeholder="use preset default" className="text-xs" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">PP Tokens</Label>
                    <Input type="number" value={nPrompt} onChange={(e) => setNPrompt(+e.target.value)} className="text-xs" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">TG Tokens</Label>
                    <Input type="number" value={nGen} onChange={(e) => setNGen(+e.target.value)} className="text-xs" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Flash Attn</Label>
                    <select value={flashAttn} onChange={(e) => setFlashAttn(+e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
                      <option value={0} className="bg-background text-foreground">Off</option>
                      <option value={1} className="bg-background text-foreground">On</option>
                    </select>
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">KV Offload</Label>
                    <select value={noKvOffload} onChange={(e) => setNoKvOffload(+e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
                      <option value={0} className="bg-background text-foreground">Yes</option>
                      <option value={1} className="bg-background text-foreground">No</option>
                    </select>
                  </div>
                  {flashAttn === 1 && (
                    <div className="grid gap-2 col-span-2">
                      <Label className="text-xs">KV Cache Quantization</Label>
                      <select value={kvCacheType} onChange={(e) => setKvCacheType(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
                        <option value="f16" className="bg-background text-foreground">f16</option>
                        <option value="bf16" className="bg-background text-foreground">bf16</option>
                        <option value="q8_0" className="bg-background text-foreground">q8_0</option>
                        <option value="q6_k" className="bg-background text-foreground">q6_k</option>
                        <option value="q5_0" className="bg-background text-foreground">q5_0</option>
                        <option value="q5_1" className="bg-background text-foreground">q5_1</option>
                        <option value="q4_0" className="bg-background text-foreground">q4_0</option>
                        <option value="q4_1" className="bg-background text-foreground">q4_1</option>
                        <option value="iq4_nl" className="bg-background text-foreground">iq4_nl</option>
                      </select>
                      <p className="text-[10px] text-muted-foreground">Applied to both K and V cache types while Flash Attention is enabled.</p>
                    </div>
                  )}
                </div>
                <Button onClick={handleRun} disabled={running || selectedPresetIds.length === 0} className="w-full bg-gradient-to-r from-purple-500 to-indigo-500 text-white shadow-md">
                  {running ? "Running..." : `▶ Run ${selectedPresetIds.length > 1 ? `(${selectedPresetIds.length} presets)` : ""}`}
                </Button>
              </CardContent>
            )}
          </Card>

          {/* Comparison Views - Collapsible */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="cursor-pointer select-none flex flex-row items-center justify-between py-3" onClick={() => setComparisonOpen(!comparisonOpen)}>
              <CardTitle className="text-sm">Performance Comparison</CardTitle>
              <span className="text-xs text-muted-foreground">{comparisonOpen ? "▼" : "▶"}</span>
            </CardHeader>
            {comparisonOpen && (
              <CardContent className="pt-0">
                {/* Sort controls */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Sort by</span>
                  <select
                    value={sortField}
                    onChange={(e) => setSortField(e.target.value as SortField)}
                    className="flex h-7 rounded-md border border-input bg-background px-2 py-0.5 text-xs"
                  >
                    <option value="tg" className="bg-background text-foreground">TG t/s</option>
                    <option value="pp" className="bg-background text-foreground">PP t/s</option>
                    <option value="model" className="bg-background text-foreground">Model Name</option>
                    <option value="recipe" className="bg-background text-foreground">Recipe</option>
                    <option value="ctx" className="bg-background text-foreground">Context Size</option>
                    <option value="date" className="bg-background text-foreground">Date</option>
                  </select>
                  <button
                    onClick={() => setSortAsc(!sortAsc)}
                    className="h-7 px-2 rounded-md border border-input bg-background text-xs hover:bg-accent/20 transition-colors"
                    title={sortAsc ? "Ascending" : "Descending"}
                  >
                    {sortAsc ? "↑ Asc" : "↓ Desc"}
                  </button>
                </div>
                <Tabs value={compareMode} onValueChange={(v) => setCompareMode(v as CompareMode)}>
                  <TabsList className="mb-4 bg-muted/40 grid grid-cols-6 w-full">
                    <TabsTrigger value="all" className="text-xs">All Results</TabsTrigger>
                    <TabsTrigger value="same_model" className="text-xs">Same Model</TabsTrigger>
                    <TabsTrigger value="same_preset" className="text-xs">Same Preset</TabsTrigger>
                    <TabsTrigger value="same_engine" className="text-xs">Same Engine</TabsTrigger>
                    <TabsTrigger value="same_recipe" className="text-xs">Same Recipe</TabsTrigger>
                    <TabsTrigger value="same_ctx" className="text-xs">Same Ctx</TabsTrigger>
                  </TabsList>

                  {/* Tab: All results bar chart */}
                  <TabsContent value="all">
                    {chartPoints.length > 0 ? (
                      <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                        {chartPoints.map((row) => (
                          <div key={row.id} className="space-y-1">
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span className="truncate pr-2">{row.model_name} · {row.engine_type} · n{row.n_gpu_layers} · b{row.batch_size}{row.preset_recipe ? ` · ${row.preset_recipe}` : ""}</span>
                              <span>{row.created_at ? new Date(row.created_at).toLocaleTimeString() : "—"}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-10 text-[10px] text-blue-300">PP</span>
                              <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                                <div className="h-full bg-blue-400" style={{ width: `${((row.pp_tokens_per_second ?? 0) / maxChartValue) * 100}%` }} />
                              </div>
                              <span className="w-14 text-right text-[10px] font-mono">{row.pp_tokens_per_second?.toFixed(1) ?? "—"}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-10 text-[10px] text-purple-300">TG</span>
                              <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                                <div className="h-full bg-purple-400" style={{ width: `${((row.tg_tokens_per_second ?? 0) / maxChartValue) * 100}%` }} />
                              </div>
                              <span className="w-14 text-right text-[10px] font-mono">{row.tg_tokens_per_second?.toFixed(1) ?? "—"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No benchmark records to compare.</p>
                    )}
                  </TabsContent>

                  {/* Tab: Same model, different presets */}
                  <TabsContent value="same_model">
                    <div className="mb-3">
                      <select
                        value={compareModel}
                        onChange={(e) => setCompareModel(e.target.value)}
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="all" className="bg-background text-foreground">-- Select Model --</option>
                        {modelOptions.map((name) => (
                          <option key={name} value={name} className="bg-background text-foreground">{name}</option>
                        ))}
                      </select>
                    </div>
                    {compareModel !== "all" && groupedByModel[compareModel] ? (
                      <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                        <p className="text-xs text-muted-foreground mb-2">
                          Comparing {groupedByModel[compareModel].length} run(s) of <span className="font-semibold text-foreground">{compareModel}</span>:
                        </p>
                        {sortRecords(groupedByModel[compareModel])
                          .map((row) => {
                            const localMax = Math.max(
                              1,
                              ...groupedByModel[compareModel].map((r) => Math.max(r.pp_tokens_per_second ?? 0, r.tg_tokens_per_second ?? 0))
                            );
                            return (
                              <div key={row.id} className="space-y-1 p-2 rounded-md bg-muted/10 border border-border/20">
                                <div className="flex items-center justify-between text-[11px]">
                                  <div className="flex gap-2 items-center">
                                    <Badge variant="outline" className="text-[9px]">{row.engine_type}</Badge>
                                    <span className="text-muted-foreground">NGL:{row.n_gpu_layers} · B:{row.batch_size} · Ctx:{row.ctx_size}</span>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground">{row.created_at ? new Date(row.created_at).toLocaleDateString() : ""}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="w-10 text-[10px] text-blue-300">PP</span>
                                  <div className="h-2.5 flex-1 rounded bg-muted/40 overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${((row.pp_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                  </div>
                                  <span className="w-16 text-right text-[10px] font-mono font-semibold">{row.pp_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="w-10 text-[10px] text-purple-300">TG</span>
                                  <div className="h-2.5 flex-1 rounded bg-muted/40 overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-purple-500 to-pink-400" style={{ width: `${((row.tg_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                  </div>
                                  <span className="w-16 text-right text-[10px] font-mono font-semibold">{row.tg_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a model to compare across configs.</p>
                    )}
                  </TabsContent>

                  {/* Tab: Same preset, different models */}
                  <TabsContent value="same_preset">
                    <div className="mb-3">
                      <select
                        value={comparePreset}
                        onChange={(e) => setComparePreset(e.target.value)}
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="all" className="bg-background text-foreground">-- Select Preset Config --</option>
                        {presetOptions.map((sig) => (
                          <option key={sig} value={sig} className="bg-background text-foreground">{sig}</option>
                        ))}
                      </select>
                    </div>
                    {comparePreset !== "all" && groupedByPreset[comparePreset] ? (
                      <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                        <p className="text-xs text-muted-foreground mb-2">
                          Comparing {groupedByPreset[comparePreset].length} model(s) with <span className="font-semibold text-foreground">{comparePreset}</span>:
                        </p>
                        {sortRecords(groupedByPreset[comparePreset])
                          .map((row) => {
                            const localMax = Math.max(
                              1,
                              ...groupedByPreset[comparePreset].map((r) => Math.max(r.pp_tokens_per_second ?? 0, r.tg_tokens_per_second ?? 0))
                            );
                            return (
                              <div key={row.id} className="space-y-1 p-2 rounded-md bg-muted/10 border border-border/20">
                                <div className="flex items-center justify-between text-[11px]">
                                  <div className="flex gap-2 items-center">
                                    <span className="font-semibold text-foreground">{row.model_name}</span>
                                    <Badge variant="outline" className="text-[9px]">{row.engine_type}</Badge>
                                  </div>
                                  <span className="text-[10px] text-muted-foreground">{row.created_at ? new Date(row.created_at).toLocaleDateString() : ""}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="w-10 text-[10px] text-blue-300">PP</span>
                                  <div className="h-2.5 flex-1 rounded bg-muted/40 overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${((row.pp_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                  </div>
                                  <span className="w-16 text-right text-[10px] font-mono font-semibold">{row.pp_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="w-10 text-[10px] text-purple-300">TG</span>
                                  <div className="h-2.5 flex-1 rounded bg-muted/40 overflow-hidden">
                                    <div className="h-full bg-gradient-to-r from-purple-500 to-pink-400" style={{ width: `${((row.tg_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                  </div>
                                  <span className="w-16 text-right text-[10px] font-mono font-semibold">{row.tg_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a preset to compare models.</p>
                    )}
                  </TabsContent>

                  {/* Tab: Same engine, different models/configs */}
                  <TabsContent value="same_engine">
                    <div className="mb-3">
                      <select
                        value={compareEngine}
                        onChange={(e) => setCompareEngine(e.target.value)}
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="all" className="bg-background text-foreground">-- Select Engine --</option>
                        {engineOptions.map((engine) => (
                          <option key={engine} value={engine} className="bg-background text-foreground">{engine}</option>
                        ))}
                      </select>
                    </div>
                    {compareEngine !== "all" && groupedByEngine[compareEngine] ? (
                      <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1 text-xs">
                        <p className="text-muted-foreground mb-2">
                          {groupedByEngine[compareEngine].length} result(s) with <span className="font-semibold">{compareEngine}</span> engine
                        </p>
                        {sortRecords(groupedByEngine[compareEngine]).slice(0, 10).map((row) => (
                          <div key={row.id} className="p-2 rounded bg-muted/10 border border-border/20">
                            <div className="text-[11px]">{row.model_name} · B:{row.batch_size} · NGL:{row.n_gpu_layers} · PP:{row.pp_tokens_per_second?.toFixed(1) ?? "—"} · TG:{row.tg_tokens_per_second?.toFixed(1) ?? "—"}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select an engine to compare.</p>
                    )}
                  </TabsContent>

                  {/* Tab: Same batch size, different models/engines */}
                  <TabsContent value="same_recipe">
                    <div className="mb-3">
                      <select
                        value={compareRecipe}
                        onChange={(e) => setCompareRecipe(e.target.value)}
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="all" className="bg-background text-foreground">-- Select Recipe --</option>
                        {recipeOptions.map((recipe) => (
                          <option key={recipe} value={recipe} className="bg-background text-foreground">{recipe}</option>
                        ))}
                      </select>
                    </div>
                    {compareRecipe !== "all" && groupedByRecipe[compareRecipe] ? (
                      <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                        <p className="text-xs text-muted-foreground mb-2">
                          {groupedByRecipe[compareRecipe].length} result(s) with recipe <span className="font-semibold text-foreground">{compareRecipe}</span>
                        </p>
                        {sortRecords(groupedByRecipe[compareRecipe]).slice(0, 10).map((row) => {
                          const localMax = Math.max(1, ...groupedByRecipe[compareRecipe].map((r) => Math.max(r.pp_tokens_per_second ?? 0, r.tg_tokens_per_second ?? 0)));
                          return (
                            <div key={row.id} className="space-y-1 p-2 rounded-md bg-muted/10 border border-border/20">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-semibold">{row.model_name}</span>
                                <div className="flex gap-2 items-center">
                                  <Badge variant="outline" className="text-[9px]">{row.engine_type}</Badge>
                                  <span className="text-muted-foreground">NGL:{row.n_gpu_layers} · B:{row.batch_size} · Ctx:{row.ctx_size}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-10 text-[10px] text-blue-300">PP</span>
                                <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                                  <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${((row.pp_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                </div>
                                <span className="w-16 text-right text-[10px] font-mono">{row.pp_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-10 text-[10px] text-purple-300">TG</span>
                                <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                                  <div className="h-full bg-gradient-to-r from-purple-500 to-pink-400" style={{ width: `${((row.tg_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                </div>
                                <span className="w-16 text-right text-[10px] font-mono">{row.tg_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a recipe to compare models across it.</p>
                    )}
                  </TabsContent>

                  {/* Tab: Same context window size */}
                  <TabsContent value="same_ctx">
                    <div className="mb-3">
                      <select
                        value={compareCtx}
                        onChange={(e) => setCompareCtx(e.target.value)}
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                      >
                        <option value="all" className="bg-background text-foreground">-- Select Context Size --</option>
                        {ctxOptions.map((ctx) => (
                          <option key={ctx} value={ctx} className="bg-background text-foreground">{ctx.toLocaleString()} tokens</option>
                        ))}
                      </select>
                    </div>
                    {compareCtx !== "all" && groupedByCtx[compareCtx] ? (
                      <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
                        <p className="text-xs text-muted-foreground mb-2">
                          {groupedByCtx[compareCtx].length} result(s) with ctx <span className="font-semibold text-foreground">{Number(compareCtx).toLocaleString()}</span>
                        </p>
                        {sortRecords(groupedByCtx[compareCtx]).slice(0, 10).map((row) => {
                          const localMax = Math.max(1, ...groupedByCtx[compareCtx].map((r) => Math.max(r.pp_tokens_per_second ?? 0, r.tg_tokens_per_second ?? 0)));
                          return (
                            <div key={row.id} className="space-y-1 p-2 rounded-md bg-muted/10 border border-border/20">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-semibold">{row.model_name}</span>
                                <div className="flex gap-2 items-center">
                                  <Badge variant="outline" className="text-[9px]">{row.engine_type}</Badge>
                                  {row.preset_recipe && <span className="text-muted-foreground text-[9px]">{row.preset_recipe}</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-10 text-[10px] text-blue-300">PP</span>
                                <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                                  <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${((row.pp_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                </div>
                                <span className="w-16 text-right text-[10px] font-mono">{row.pp_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="w-10 text-[10px] text-purple-300">TG</span>
                                <div className="h-2 flex-1 rounded bg-muted/40 overflow-hidden">
                                  <div className="h-full bg-gradient-to-r from-purple-500 to-pink-400" style={{ width: `${((row.tg_tokens_per_second ?? 0) / localMax) * 100}%` }} />
                                </div>
                                <span className="w-16 text-right text-[10px] font-mono">{row.tg_tokens_per_second?.toFixed(1) ?? "—"} t/s</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a context window size to compare.</p>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            )}
          </Card>
        </div>

        {/* Results Table - Collapsible */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader className="cursor-pointer select-none flex flex-row items-center justify-between py-3" onClick={() => setTableOpen(!tableOpen)}>
            <CardTitle className="text-sm">Results Table <Badge variant="secondary" className="ml-2 text-[10px]">{filteredRecords.length}/{records.length}</Badge></CardTitle>
            <span className="text-xs text-muted-foreground">{tableOpen ? "▼" : "▶"}</span>
          </CardHeader>
          {tableOpen && (
            <CardContent className="pt-0">
              {records.length > 0 ? (
                <>
                  <div className="mb-3 flex gap-2 items-center">
                    <select
                      value={filterModel}
                      onChange={(e) => setFilterModel(e.target.value)}
                      className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
                    >
                      <option value="all" className="bg-background text-foreground">All Models</option>
                      {modelOptions.map((name) => (
                        <option key={name} value={name} className="bg-background text-foreground">{name}</option>
                      ))}
                    </select>
                    <select
                      value={filterEngine}
                      onChange={(e) => setFilterEngine(e.target.value)}
                      className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
                    >
                      <option value="all" className="bg-background text-foreground">All Engines</option>
                      {engineOptions.map((engine) => (
                        <option key={engine} value={engine} className="bg-background text-foreground">{engine}</option>
                      ))}
                    </select>
                  </div>
                  <div className="rounded-lg border border-border/40 overflow-hidden max-h-[50vh] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/30 sticky top-0 z-10">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Model</th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Engine</th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Recipe</th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">NGL</th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Batch</th>
                          <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Ctx</th>
                          <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">PP t/s</th>
                          <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">TG t/s</th>
                          <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                          <th className="px-4 py-2.5 w-8"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/20">
                        {filteredRecords.map((r) => (
                          <tr key={r.id} className="hover:bg-accent/30 transition-colors group">
                            <td className="px-4 py-3 font-medium text-xs">{r.model_name}</td>
                            <td className="px-4 py-3 text-center"><Badge variant="outline" className="uppercase text-[10px]">{r.engine_type}</Badge></td>
                            <td className="px-4 py-3 text-center text-xs text-purple-400">{r.preset_recipe || <span className="text-muted-foreground">—</span>}</td>
                            <td className="px-4 py-3 text-center text-xs font-mono">{r.n_gpu_layers}</td>
                            <td className="px-4 py-3 text-center text-xs font-mono">{r.batch_size}</td>
                            <td className="px-4 py-3 text-center text-xs font-mono">{r.ctx_size}</td>
                            <td className="px-4 py-3 text-right font-mono text-xs">
                              <span className={r.pp_tokens_per_second === bestPp && bestPp > 0 ? "text-blue-400 font-bold" : ""}>{r.pp_tokens_per_second?.toFixed(1) ?? "—"}</span>
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-xs">
                              <span className={r.tg_tokens_per_second === bestTg && bestTg > 0 ? "text-purple-400 font-bold" : ""}>{r.tg_tokens_per_second?.toFixed(1) ?? "—"}</span>
                            </td>
                            <td className="px-4 py-3 text-right text-xs text-muted-foreground">{r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
                            <td className="px-4 py-3 text-right">
                              <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteRecord(r.id)}>✕</Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <p className="text-muted-foreground text-sm">No benchmark results yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">Select presets above and run benchmarks.</p>
                </div>
              )}
            </CardContent>
          )}
        </Card>

        {/* Debug Log - Collapsible */}
        {debugLog && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="cursor-pointer select-none flex flex-row items-center justify-between py-2" onClick={() => setLogOpen(!logOpen)}>
              <CardTitle className="text-sm">Testing Debug Log</CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="xs" onClick={(e) => { e.stopPropagation(); clearLog(); }} className="h-7 text-xs px-2">Clear Log</Button>
                <span className="text-xs text-muted-foreground">{logOpen ? "▼" : "▶"}</span>
              </div>
            </CardHeader>
            {logOpen && (
              <CardContent className="pt-0">
                <div ref={logContainerRef} className="bg-black/50 p-4 rounded-md overflow-x-auto max-h-[300px] overflow-y-auto">
                  <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap">{debugLog}</pre>
                  <div ref={logEndRef} />
                </div>
              </CardContent>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
