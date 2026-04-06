"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  scanModels,
  getModelGroups,
  getRuntimes,
  getSettings,
  updateSettings,
  createModelGroup,
  updateModelGroup,
  deleteModelGroup,
  launchModelGroup,
  stopProcess,
  getAllProcessStatus,
  getModelOverrides,
  upsertModelOverride,
  deleteModelOverride,
  type GGUFFileInfo,
  type ModelGroup,
  type AllProcessesStatus,
  type ModelPropertyOverride,
  type Runtime,
} from "@/lib/api";
import {
  PRESET_RECIPES,
  PRESET_FAMILY_OPTIONS,
  PRESET_RECIPE_GROUPS,
  MODEL_CLASSIFICATION_OPTIONS,
  MODEL_MODALITY_OPTIONS,
  applyPresetRecipe,
  buildExtraArgs,
  buildLaunchPreview,
  createDefaultLaunchOptions,
  getPresetRecipe,
  groupRecipesForFamily,
  inferPresetFamily,
  inferPresetRecipeKey,
  inferModelClassification,
  inferModality,
  inferThinkingCapable,
  parseExtraArgs,
  type LaunchOptionDraft,
  type PresetFamily,
  type PresetRecipe,
} from "@/lib/model-preset-recipes";

type ModelSortKey = "filename" | "param_size" | "quantize" | "size_bytes" | "arch";

export default function ModelsPage() {
  const [models, setModels] = useState<GGUFFileInfo[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [processes, setProcesses] = useState<AllProcessesStatus>({ active_count: 0, processes: [] });
  const [errors, setErrors] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);

  // New group form
  const [newGroupName, setNewGroupName] = useState("Default");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newEngine, setNewEngine] = useState("");
  const [newNgl, setNewNgl] = useState(999);
  const [newBatch, setNewBatch] = useState(2048);
  const [newUbatch, setNewUbatch] = useState(512);
  const [newCtx, setNewCtx] = useState(8192);
  const [newModelFamily, setNewModelFamily] = useState<PresetFamily>("universal");
  const [selectedRecipeKey, setSelectedRecipeKey] = useState("universal-balanced");
  const [launchOptions, setLaunchOptions] = useState<LaunchOptionDraft>(createDefaultLaunchOptions());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [defaultRuntimeName, setDefaultRuntimeName] = useState("");

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterQuant, setFilterQuant] = useState("");
  const [filterParamSize, setFilterParamSize] = useState("");
  const [filterArch, setFilterArch] = useState("");
  const [filterPublisher, setFilterPublisher] = useState("");
  const [filterModelType, setFilterModelType] = useState("");
  const [activeGroupTab, setActiveGroupTab] = useState<string | null>(null);

  // Model property override state
  const [overrides, setOverrides] = useState<ModelPropertyOverride[]>([]);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<GGUFFileInfo | null>(null);
  const [ovDisplayName, setOvDisplayName] = useState("");
  const [ovPublisher, setOvPublisher] = useState("");
  const [ovQuantize, setOvQuantize] = useState("");
  const [ovParamSize, setOvParamSize] = useState("");
  const [ovArch, setOvArch] = useState("");
  const [ovModelFamily, setOvModelFamily] = useState("");
  const [ovTags, setOvTags] = useState("");
  const [ovNotes, setOvNotes] = useState("");
  const [savingPresetMetaId, setSavingPresetMetaId] = useState<number | null>(null);
  const [groupColumnWidth, setGroupColumnWidth] = useState(1.1);
  const [fileColumnWidth, setFileColumnWidth] = useState(1.2);
  const [recipeColumnWidth, setRecipeColumnWidth] = useState(0.9);
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<number | null>(null);
  const [workbenchFamily, setWorkbenchFamily] = useState<PresetFamily>("universal");
  const [workbenchRecipeKey, setWorkbenchRecipeKey] = useState("universal-balanced");
  const [workbenchNgl, setWorkbenchNgl] = useState(999);
  const [workbenchBatch, setWorkbenchBatch] = useState(1024);
  const [workbenchUbatch, setWorkbenchUbatch] = useState(512);
  const [workbenchCtx, setWorkbenchCtx] = useState(8192);
  const [workbenchOptions, setWorkbenchOptions] = useState<LaunchOptionDraft>(createDefaultLaunchOptions());
  const [savingWorkbench, setSavingWorkbench] = useState(false);

  // Custom recipes (user-defined, persisted in backend settings)
  const [customRecipes, setCustomRecipes] = useState<PresetRecipe[]>([]);
  const [recipeManagerOpen, setRecipeManagerOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<PresetRecipe | null>(null);
  const [recipeForm, setRecipeForm] = useState<PresetRecipe>({
    key: "", label: "", family: "universal", description: "", tags: [],
    ngl: 999, batch: 1024, ubatch: 512, ctx: 8192,
    options: { flashAttn: true, contBatching: false, parallelSlots: 1 },
  });
  const [savingRecipes, setSavingRecipes] = useState(false);

  const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown error";
  const compiledExtraArgs = buildExtraArgs(launchOptions);
  const allRecipes = [...PRESET_RECIPES, ...customRecipes];
  const selectedRecipe = getPresetRecipe(selectedRecipeKey, allRecipes);
  const selectedWorkbenchGroup = groups.find((group) => group.id === selectedWorkbenchId) ?? null;
  const workbenchExtraArgs = buildExtraArgs(workbenchOptions);
  const workbenchRecipe = getPresetRecipe(workbenchRecipeKey, allRecipes);
  const modelsLayoutStyle = {
    "--models-groups-col": `minmax(0, ${groupColumnWidth}fr)`,
    "--models-files-col": `minmax(0, ${fileColumnWidth}fr)`,
    "--models-recipes-col": `minmax(0, ${recipeColumnWidth}fr)`,
  } as CSSProperties;
  const launchPreview = buildLaunchPreview({
    runtimeName: newEngine,
    modelPath: newPath,
    ngl: newNgl,
    batch: newBatch,
    ubatch: newUbatch,
    ctx: newCtx,
    extraArgs: compiledExtraArgs,
  });
  const workbenchPreview = buildLaunchPreview({
    runtimeName: selectedWorkbenchGroup?.engine_type ?? "",
    modelPath: selectedWorkbenchGroup?.model_path ?? "",
    ngl: workbenchNgl,
    batch: workbenchBatch,
    ubatch: workbenchUbatch,
    ctx: workbenchCtx,
    extraArgs: workbenchExtraArgs,
  });

  const applyRecipe = (recipeKey: string, baseOptions?: LaunchOptionDraft) => {
    const { recipe, options } = applyPresetRecipe(recipeKey, baseOptions ?? launchOptions, allRecipes);
    setSelectedRecipeKey(recipe.key);
    setNewNgl(recipe.ngl);
    setNewBatch(recipe.batch);
    setNewUbatch(recipe.ubatch);
    setNewCtx(recipe.ctx);
    setLaunchOptions(options);
  };

  const applyWorkbenchRecipe = (recipeKey: string, baseOptions?: LaunchOptionDraft) => {
    const { recipe, options } = applyPresetRecipe(recipeKey, baseOptions ?? workbenchOptions, allRecipes);
    setWorkbenchRecipeKey(recipe.key);
    setWorkbenchNgl(recipe.ngl);
    setWorkbenchBatch(recipe.batch);
    setWorkbenchUbatch(recipe.ubatch);
    setWorkbenchCtx(recipe.ctx);
    setWorkbenchOptions(options);
  };

  const updateLaunchOption = <K extends keyof LaunchOptionDraft>(key: K, value: LaunchOptionDraft[K]) => {
    setLaunchOptions((prev) => ({ ...prev, [key]: value }));
  };

  const resetForm = () => {
    setNewGroupName("Default");
    setNewName("");
    setNewDesc("");
    setNewPath("");
    setNewEngine(defaultRuntimeName || runtimes[0]?.name || "");
    const defaultOptions = createDefaultLaunchOptions();
    setNewModelFamily("universal");
    setSelectedRecipeKey("universal-balanced");
    setLaunchOptions(defaultOptions);
    setNewNgl(999);
    setNewBatch(1024);
    setNewUbatch(512);
    setNewCtx(8192);
    setEditingGroupId(null);
  };

  // Sorting state
  const [sortKey, setSortKey] = useState<ModelSortKey>("filename");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  const handleSort = (key: ModelSortKey) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  // Get unique filter options (exclude mmproj files from filter option sources)
  const filterableModels = models.filter(m => m.model_type !== "multimodal_projector");
  const allQuants = [...new Set(filterableModels.map(m => m.quantize).filter(Boolean))].sort();
  const allParamSizes = [...new Set(filterableModels.map(m => m.param_size).filter(Boolean))].sort((a, b) => {
    const na = parseFloat(a); const nb = parseFloat(b);
    return na - nb;
  });
  const allArchs = [...new Set(filterableModels.map(m => m.arch).filter(Boolean))].sort();
  const allPublishers = [...new Set(filterableModels.map(m => m.publisher).filter(Boolean))].sort();
  const allModelTypes = [...new Set(filterableModels.map(m => m.model_type).filter(Boolean))].sort();

  const selectedGroupPaths = new Set(
    groups
      .filter((g) => (g.group_name || "Default") === activeGroupTab)
      .map((g) => g.model_path)
  );

  const sortedModels = [...models]
    .filter((m) => {
      // Always hide mmproj files — they are not independently usable
      if (m.model_type === "multimodal_projector") return false;
      // Hide models only if they belong to the SELECTED group tab
      if (
        activeGroupTab &&
        (
          selectedGroupPaths.has(m.filepath) ||
          (!!m.related_base_model_path && selectedGroupPaths.has(m.related_base_model_path)) ||
          (!!m.related_mmproj_path && selectedGroupPaths.has(m.related_mmproj_path))
        )
      ) {
        return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const ov = overrides.find((o) => o.filepath === m.filepath);
        const displayName = ov?.display_name || "";
        if (!m.filename.toLowerCase().includes(q) && !m.parent_dir.toLowerCase().includes(q) && !m.arch.toLowerCase().includes(q) && !m.publisher.toLowerCase().includes(q) && !displayName.toLowerCase().includes(q)) return false;
      }
      if (filterQuant && m.quantize !== filterQuant) return false;
      if (filterParamSize && m.param_size !== filterParamSize) return false;
      if (filterArch && m.arch !== filterArch) return false;
      if (filterPublisher && m.publisher !== filterPublisher) return false;
      if (filterModelType && m.model_type !== filterModelType) return false;
      return true;
    })
    .sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (typeof valA === "number" && typeof valB === "number") {
        if (valA < valB) return sortOrder === "asc" ? -1 : 1;
        if (valA > valB) return sortOrder === "asc" ? 1 : -1;
        return 0;
      }
      const sA = String(valA || "").toLowerCase();
      const sB = String(valB || "").toLowerCase();
      if (sA < sB) return sortOrder === "asc" ? -1 : 1;
      if (sA > sB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

  // Group models by group_name
  const groupedModels = groups.reduce((acc, g) => {
    const key = g.group_name || "Default";
    if (!acc[key]) acc[key] = [];
    acc[key].push(g);
    return acc;
  }, {} as Record<string, ModelGroup[]>);
  const groupNames = Object.keys(groupedModels).sort((a, b) => a.localeCompare(b));
  const runtimeNames = runtimes.map((runtime) => runtime.name);

  const hydratePresetFromModel = (model: GGUFFileInfo) => {
    const recipeKey = inferPresetRecipeKey(model);
    const seededOptions = createDefaultLaunchOptions();

    if (model.model_type === "multimodal_base" && model.related_mmproj_path) {
      seededOptions.mmprojPath = model.related_mmproj_path;
    }

    const { recipe, options } = applyPresetRecipe(recipeKey, seededOptions, allRecipes);

    setNewModelFamily(inferPresetFamily(model));
    setSelectedRecipeKey(recipe.key);
    setLaunchOptions(options);
    setNewNgl(recipe.ngl);
    setNewBatch(recipe.batch);
    setNewUbatch(recipe.ubatch);
    setNewCtx(recipe.ctx);
  };

  const loadWorkbenchFromGroup = (group: ModelGroup) => {
    const parsedOptions = parseExtraArgs(group.extra_args || "");
    const inferredRecipe = group.preset_recipe || inferPresetRecipeKey({
      model_family: group.model_family,
      filename: group.name,
      arch: group.description,
      model_type: group.extra_args.includes("--mmproj") ? "multimodal_base" : "text",
    });
    const hydrated = applyPresetRecipe(inferredRecipe, parsedOptions, allRecipes);

    setSelectedWorkbenchId(group.id);
    setWorkbenchFamily((group.model_family || hydrated.recipe.family) as PresetFamily);
    setWorkbenchRecipeKey(hydrated.recipe.key);
    setWorkbenchNgl(group.n_gpu_layers);
    setWorkbenchBatch(group.batch_size);
    setWorkbenchUbatch(group.ubatch_size);
    setWorkbenchCtx(group.ctx_size);
    setWorkbenchOptions(hydrated.options);
  };

  const refreshAll = useCallback(async () => {
    try {
      const [g, p, runtimeItems, settingsItems] = await Promise.all([
        getModelGroups(),
        getAllProcessStatus(),
        getRuntimes(),
        getSettings(),
      ]);
      setGroups(g);
      setProcesses(p);
      setRuntimes(runtimeItems);

      const savedDefaultRuntime = settingsItems.find((item) => item.key === "default_engine")?.value ?? "";
      setDefaultRuntimeName(savedDefaultRuntime || runtimeItems[0]?.name || "");

      const customRecipesRaw = settingsItems.find((item) => item.key === "custom_preset_recipes")?.value ?? "[]";
      try { setCustomRecipes(JSON.parse(customRecipesRaw)); } catch { setCustomRecipes([]); }
    } catch {}
  }, []);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await scanModels();
      setModels(res.models);
      setErrors(res.errors);
    } catch (error: unknown) {
      setErrors([getErrorMessage(error)]);
    } finally {
      setScanning(false);
    }
  }, []);

  const openOverrideDialog = (m: GGUFFileInfo) => {
    setOverrideTarget(m);
    const existing = overrides.find((o) => o.filepath === m.filepath);
    setOvDisplayName(existing?.display_name || "");
    setOvPublisher(existing?.publisher || m.publisher || "");
    setOvQuantize(existing?.quantize || m.quantize || "");
    setOvParamSize(existing?.param_size || m.param_size || "");
    setOvArch(existing?.arch || m.arch || "");
    setOvModelFamily(existing?.model_family || m.model_family || inferPresetFamily(m));
    setOvTags(existing?.tags || "");
    setOvNotes(existing?.notes || "");
    setOverrideDialogOpen(true);
  };

  // --- Recipe CRUD helpers ---
  const saveCustomRecipesList = async (next: PresetRecipe[]) => {
    setSavingRecipes(true);
    try {
      await updateSettings([{ key: "custom_preset_recipes", value: JSON.stringify(next) }]);
      setCustomRecipes(next);
    } finally {
      setSavingRecipes(false);
    }
  };

  const openNewRecipeForm = () => {
    setEditingRecipe(null);
    setRecipeForm({ key: "", label: "", family: "universal", description: "", tags: [], ngl: 999, batch: 1024, ubatch: 512, ctx: 8192, options: { flashAttn: true, contBatching: false, parallelSlots: 1 } });
  };

  const openEditRecipeForm = (r: PresetRecipe) => {
    setEditingRecipe(r);
    setRecipeForm({ ...r });
  };

  const handleSaveRecipeForm = async () => {
    const key = recipeForm.key.trim();
    if (!key || !recipeForm.label.trim()) return;
    const isBuiltIn = PRESET_RECIPES.some((r) => r.key === key);
    if (isBuiltIn) return; // cannot overwrite built-ins
    const next = editingRecipe
      ? customRecipes.map((r) => (r.key === editingRecipe.key ? { ...recipeForm, key } : r))
      : [...customRecipes.filter((r) => r.key !== key), { ...recipeForm, key }];
    await saveCustomRecipesList(next);
    setEditingRecipe(null);
  };

  const handleDeleteCustomRecipe = async (recipeKey: string) => {
    await saveCustomRecipesList(customRecipes.filter((r) => r.key !== recipeKey));
  };

  const handleSaveOverride = async () => {
    if (!overrideTarget) return;
    try {
      await upsertModelOverride({
        filepath: overrideTarget.filepath,
        display_name: ovDisplayName,
        publisher: ovPublisher,
        quantize: ovQuantize,
        param_size: ovParamSize,
        arch: ovArch,
        model_family: ovModelFamily,
        tags: ovTags,
        notes: ovNotes,
      });
      setOverrideDialogOpen(false);
      // Refresh overrides and rescan to apply
      const [ovs] = await Promise.all([getModelOverrides()]);
      setOverrides(ovs);
      await handleScan();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    }
  };

  const handleClearOverride = async () => {
    if (!overrideTarget) return;
    const existing = overrides.find((o) => o.filepath === overrideTarget.filepath);
    if (!existing) return;
    try {
      await deleteModelOverride(existing.id);
      setOverrideDialogOpen(false);
      const ovs = await getModelOverrides();
      setOverrides(ovs);
      await handleScan();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    }
  };

  const hasOverride = (filepath: string) => overrides.some((o) => o.filepath === filepath);

  const handleCreateOrUpdateGroup = async () => {
    setCreating(true);
    try {
      const payload = {
        group_name: newGroupName, name: newName, description: newDesc,
        model_path: newPath, engine_type: newEngine, n_gpu_layers: newNgl,
        batch_size: newBatch, ubatch_size: newUbatch, ctx_size: newCtx,
        model_family: newModelFamily, preset_recipe: selectedRecipeKey, extra_args: compiledExtraArgs,
      };
      if (editingGroupId) {
        await updateModelGroup(editingGroupId, payload);
      } else {
        await createModelGroup(payload);
      }
      setDialogOpen(false);
      resetForm();
      await refreshAll();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const handleLaunch = async (id: number) => { try { await launchModelGroup(id); await refreshAll(); } catch (error: unknown) { alert(getErrorMessage(error)); } };
  const handleStop = async (identifier: string) => { try { await stopProcess(identifier); await refreshAll(); } catch (error: unknown) { alert(getErrorMessage(error)); } };
  const handleDelete = async (id: number) => { if (!confirm("確定要刪除此群組？")) return; try { await deleteModelGroup(id); await refreshAll(); } catch (error: unknown) { alert(getErrorMessage(error)); } };
  const handleInlinePresetUpdate = async (
    group: ModelGroup,
    patch: Partial<Pick<ModelGroup, "model_family" | "preset_recipe">>,
  ) => {
    setSavingPresetMetaId(group.id);
    try {
      const parsedOptions = parseExtraArgs(group.extra_args || "");
      const nextFamily = (patch.model_family ?? group.model_family ?? inferPresetFamily(group)) as PresetFamily;
      const nextRecipe = patch.preset_recipe ?? group.preset_recipe ?? inferPresetRecipeKey({ ...group, model_family: nextFamily });
      const { recipe, options } = applyPresetRecipe(nextRecipe, parsedOptions, allRecipes);

      await updateModelGroup(group.id, {
        group_name: group.group_name,
        name: group.name,
        description: group.description,
        model_path: group.model_path,
        engine_type: group.engine_type,
        n_gpu_layers: recipe.ngl,
        batch_size: recipe.batch,
        ubatch_size: recipe.ubatch,
        ctx_size: recipe.ctx,
        model_family: nextFamily,
        preset_recipe: recipe.key,
        extra_args: buildExtraArgs(options),
      });
      await refreshAll();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    } finally {
      setSavingPresetMetaId(null);
    }
  };
  const handleSaveWorkbench = async () => {
    if (!selectedWorkbenchGroup) return;

    setSavingWorkbench(true);
    try {
      await updateModelGroup(selectedWorkbenchGroup.id, {
        group_name: selectedWorkbenchGroup.group_name,
        name: selectedWorkbenchGroup.name,
        description: selectedWorkbenchGroup.description,
        model_path: selectedWorkbenchGroup.model_path,
        engine_type: selectedWorkbenchGroup.engine_type,
        n_gpu_layers: workbenchNgl,
        batch_size: workbenchBatch,
        ubatch_size: workbenchUbatch,
        ctx_size: workbenchCtx,
        model_family: workbenchFamily,
        preset_recipe: workbenchRecipeKey,
        extra_args: workbenchExtraArgs,
      });
      await refreshAll();
    } catch (error: unknown) {
      alert(getErrorMessage(error));
    } finally {
      setSavingWorkbench(false);
    }
  };
  const isRunning = (name: string) => processes.processes.some((p) => p.identifier === name && p.is_running);

  useEffect(() => {
    refreshAll();
    handleScan();
    getModelOverrides().then(setOverrides).catch(() => {});
    const interval = setInterval(refreshAll, 5000);
    return () => clearInterval(interval);
  }, [handleScan, refreshAll]);

  // Set initial tab when groups are loaded
  useEffect(() => {
    if (groupNames.length > 0 && (!activeGroupTab || !groupNames.includes(activeGroupTab))) {
      setActiveGroupTab(groupNames[0]);
    }
  }, [groupNames, activeGroupTab]);

  useEffect(() => {
    const activeGroups = activeGroupTab ? groupedModels[activeGroupTab] ?? [] : [];
    if (activeGroups.length === 0) {
      if (selectedWorkbenchId !== null) {
        setSelectedWorkbenchId(null);
      }
      return;
    }

    if (!selectedWorkbenchId || !groups.some((group) => group.id === selectedWorkbenchId)) {
      loadWorkbenchFromGroup(activeGroups[0]);
      return;
    }

    if (activeGroups.every((group) => group.id !== selectedWorkbenchId)) {
      loadWorkbenchFromGroup(activeGroups[0]);
    }
  }, [activeGroupTab, groupedModels, groups, selectedWorkbenchId]);

  useEffect(() => {
    if (editingGroupId) return;

    const nextRuntime = defaultRuntimeName || runtimes[0]?.name || "";
    if (nextRuntime && !runtimeNames.includes(newEngine)) {
      setNewEngine(nextRuntime);
    }
  }, [defaultRuntimeName, editingGroupId, newEngine, runtimeNames, runtimes]);

  const shortName = (path: string) => {
    if (!path) return "";
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  };

  const modelTypeBadge = (modelType: GGUFFileInfo["model_type"]) => {
    if (modelType === "multimodal_base") {
      return <Badge className="bg-cyan-500/20 text-cyan-300 border-cyan-400/30">Multimodal</Badge>;
    }
    if (modelType === "multimodal_projector") {
      return <Badge className="bg-orange-500/20 text-orange-300 border-orange-400/30">mmproj</Badge>;
    }
    return <Badge variant="outline">Text</Badge>;
  };

  return (
    <div className="flex min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(56,189,248,0.14),transparent_42%),radial-gradient(circle_at_20%_20%,rgba(14,165,233,0.12),transparent_38%)]">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200 overflow-x-hidden">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Model Studio</h1>
            <p className="text-sm text-muted-foreground mt-1">LM Studio-style local model management with multimodal pairing</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleScan} disabled={scanning}>
              {scanning ? "Scanning..." : "⟳ Scan Models"}
            </Button>
            <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40 transition-shadow">
                  + New Group
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-4xl max-h-[88vh] overflow-hidden p-0">
                <DialogHeader>
                  <DialogTitle>{editingGroupId ? "編輯模型群組" : "建立模型群組"}</DialogTitle>
                </DialogHeader>
                <div className="grid max-h-[calc(88vh-6rem)] gap-4 overflow-y-auto px-6 py-4 pr-4">
                  <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                    <Tabs defaultValue="identity" className="min-w-0">
                      <TabsList className="grid w-full grid-cols-3 bg-muted/40">
                        <TabsTrigger value="identity" className="text-xs">Identity</TabsTrigger>
                        <TabsTrigger value="tuning" className="text-xs">Tuning</TabsTrigger>
                        <TabsTrigger value="advanced" className="text-xs">Advanced</TabsTrigger>
                      </TabsList>
                      <TabsContent value="identity" className="mt-4 grid gap-4">
                        <div className="grid gap-2">
                          <Label>Group Category</Label>
                          <Input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="Default" />
                        </div>
                        <div className="grid gap-2">
                          <Label>Preset Identifier</Label>
                          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Llama-3.1-8B-Q4" />
                        </div>
                        <div className="grid gap-2">
                          <Label>Description</Label>
                          <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Daily use model" />
                        </div>
                        <div className="grid gap-2">
                          <Label>Model Path (.gguf)</Label>
                          <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/path/to/model.gguf" className="font-mono text-xs" />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="grid gap-2">
                            <Label>Model Classification</Label>
                            <select
                              value={newModelFamily}
                              onChange={(e) => {
                                  setNewModelFamily(e.target.value as PresetFamily);
                              }}
                              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {MODEL_CLASSIFICATION_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="grid gap-2">
                            <Label>Recipe Setup</Label>
                            <select
                              value={selectedRecipeKey}
                              onChange={(e) => applyRecipe(e.target.value)}
                              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {groupRecipesForFamily(newModelFamily, allRecipes).map((group) => (
                                <optgroup key={group.key} label={group.label}>
                                  {group.recipes.map((recipe) => (
                                    <option key={recipe.key} value={recipe.key}>{recipe.label}{recipe.family === "universal" && newModelFamily !== "universal" ? " ✦" : ""}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="grid gap-2">
                          <Label>Engine</Label>
                          <select value={newEngine} onChange={(e) => setNewEngine(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                            {newEngine && !runtimeNames.includes(newEngine) && (
                              <option value={newEngine} className="bg-background text-foreground">{newEngine}</option>
                            )}
                            {runtimes.length > 0 ? (
                              runtimes.map((runtime) => (
                                <option key={runtime.id} value={runtime.name} className="bg-background text-foreground">{runtime.name}</option>
                              ))
                            ) : (
                              <option value="" className="bg-background text-foreground">No runtimes configured</option>
                            )}
                          </select>
                        </div>
                      </TabsContent>
                      <TabsContent value="tuning" className="mt-4 grid gap-4">
                        <div className="grid grid-cols-4 gap-4">
                          <div className="grid gap-2">
                            <Label>GPU Layers</Label>
                            <Input type="number" value={newNgl} onChange={(e) => setNewNgl(+e.target.value)} />
                          </div>
                          <div className="grid gap-2">
                            <Label>Batch</Label>
                            <Input type="number" value={newBatch} onChange={(e) => setNewBatch(+e.target.value)} />
                          </div>
                          <div className="grid gap-2">
                            <Label>UBatch</Label>
                            <Input type="number" value={newUbatch} onChange={(e) => setNewUbatch(+e.target.value)} />
                          </div>
                          <div className="grid gap-2">
                            <Label>Context</Label>
                            <Input type="number" value={newCtx} onChange={(e) => setNewCtx(+e.target.value)} />
                          </div>
                        </div>
                        <div className="rounded-2xl border border-border/50 bg-card/35 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold">{selectedRecipe.label}</p>
                              <p className="mt-1 text-[11px] text-muted-foreground">{selectedRecipe.description}</p>
                            </div>
                            <Badge variant="outline" className="uppercase text-[10px] tracking-[0.18em]">{newModelFamily}</Badge>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {selectedRecipe.tags.map((tag) => (
                              <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
                            ))}
                          </div>
                        </div>
                      </TabsContent>
                      <TabsContent value="advanced" className="mt-4 grid gap-4">
                        <div className="grid gap-4 rounded-2xl border border-border/50 bg-card/35 p-4">
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label>Attention and Cache</Label>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">shared</span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2 text-xs">
                          <span>Flash Attention</span>
                          <input type="checkbox" checked={launchOptions.flashAttn} onChange={(e) => updateLaunchOption("flashAttn", e.target.checked)} />
                        </label>
                        <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2 text-xs">
                          <span>No KV Offload</span>
                          <input type="checkbox" checked={launchOptions.noKvOffload} onChange={(e) => updateLaunchOption("noKvOffload", e.target.checked)} />
                        </label>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">KV Cache Type K</Label>
                            <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">moe hint</span>
                          </div>
                          <Input value={launchOptions.cacheTypeK} onChange={(e) => updateLaunchOption("cacheTypeK", e.target.value)} placeholder="q8_0" className="text-xs" />
                        </div>
                        <div className="grid gap-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">KV Cache Type V</Label>
                            <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">moe hint</span>
                          </div>
                          <Input value={launchOptions.cacheTypeV} onChange={(e) => updateLaunchOption("cacheTypeV", e.target.value)} placeholder="q8_0" className="text-xs" />
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between">
                        <Label>Launch Behavior</Label>
                        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">advanced</span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2 text-xs">
                          <span>Continuous Batching</span>
                          <input type="checkbox" checked={launchOptions.contBatching} onChange={(e) => updateLaunchOption("contBatching", e.target.checked)} />
                        </label>
                        <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2 text-xs">
                          <span>Lock Model in RAM</span>
                          <input type="checkbox" checked={launchOptions.mlock} onChange={(e) => updateLaunchOption("mlock", e.target.checked)} />
                        </label>
                        <label className="flex items-center justify-between rounded-xl border border-border/50 px-3 py-2 text-xs">
                          <span>Disable mmap</span>
                          <input type="checkbox" checked={launchOptions.noMmap} onChange={(e) => updateLaunchOption("noMmap", e.target.checked)} />
                        </label>
                        <div className="grid gap-2 rounded-xl border border-border/50 px-3 py-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Parallel Slots</Label>
                            <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">moe hint</span>
                          </div>
                          <Input type="number" min={1} value={launchOptions.parallelSlots} onChange={(e) => updateLaunchOption("parallelSlots", Math.max(1, Number(e.target.value) || 1))} className="text-xs" />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-2">
                          <Label className="text-xs">Threads</Label>
                          <Input type="number" min={0} value={launchOptions.threads} onChange={(e) => updateLaunchOption("threads", Math.max(0, Number(e.target.value) || 0))} className="text-xs" />
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">Threads Batch</Label>
                          <Input type="number" min={0} value={launchOptions.threadsBatch} onChange={(e) => updateLaunchOption("threadsBatch", Math.max(0, Number(e.target.value) || 0))} className="text-xs" />
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-2">
                        <Label className="text-xs">Tensor Split</Label>
                        <Input value={launchOptions.tensorSplit} onChange={(e) => updateLaunchOption("tensorSplit", e.target.value)} placeholder="4,4" className="text-xs font-mono" />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-xs">mmproj Path</Label>
                        <Input value={launchOptions.mmprojPath} onChange={(e) => updateLaunchOption("mmprojPath", e.target.value)} placeholder="/path/to/mmproj.gguf" className="text-xs font-mono" />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label>Custom Extra Args</Label>
                      <Textarea
                        value={launchOptions.customArgs}
                        onChange={(e) => updateLaunchOption("customArgs", e.target.value)}
                        placeholder="--rope-scaling yarn --temp 0.7"
                        className="min-h-20 font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label>Generated CLI Args</Label>
                      <Textarea value={compiledExtraArgs} readOnly className="min-h-20 font-mono text-xs opacity-90" />
                    </div>
                    <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3">
                      <p className="text-[11px] font-semibold text-cyan-200">Launch Preview</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-cyan-100/80">{launchPreview}</p>
                    </div>
                        </div>
                      </TabsContent>
                    </Tabs>

                    <div className="rounded-3xl border border-cyan-400/20 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.14),transparent_42%),rgba(2,6,23,0.82)] p-5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-cyan-100">Preset Summary</p>
                        <Badge className="bg-cyan-500/15 text-cyan-200">{selectedRecipe.label}</Badge>
                      </div>
                      <div className="mt-4 grid gap-3 text-sm text-slate-200">
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Family</p>
                          <p className="mt-1 font-medium">{newModelFamily}</p>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Core tuning</p>
                          <p className="mt-1">NGL {newNgl} · Batch {newBatch} · UBatch {newUbatch} · Ctx {newCtx}</p>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">CLI</p>
                          <p className="mt-1 break-all font-mono text-[10px] text-slate-300">{compiledExtraArgs || "No extra args"}</p>
                        </div>
                        <p className="text-[11px] text-slate-400">
                          Recipe setup is stored separately from model classification, so changing one no longer forces the other.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="border-t border-border/50 pt-4">
                  <Button onClick={handleCreateOrUpdateGroup} disabled={creating || !newName || !newPath || !newEngine} className="w-full">
                    {creating ? "Saving..." : (editingGroupId ? "Update Group" : "Create Group")}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="mb-6 rounded-3xl border border-border/40 bg-card/55 p-4 backdrop-blur-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold tracking-[0.16em] uppercase text-muted-foreground">Workspace Columns</h2>
              <p className="mt-1 text-xs text-muted-foreground">Recipe setups now live on the root page. Tune the column widths to suit your screen.</p>
            </div>
            <Badge variant="outline" className="text-[10px] uppercase tracking-[0.18em]">3-column studio</Badge>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <label className="grid gap-2 text-xs">
              <span className="flex items-center justify-between text-muted-foreground">
                <span>Groups</span>
                <span>{groupColumnWidth.toFixed(1)}fr</span>
              </span>
              <input type="range" min="0.8" max="1.8" step="0.1" value={groupColumnWidth} onChange={(e) => setGroupColumnWidth(Number(e.target.value))} />
            </label>
            <label className="grid gap-2 text-xs">
              <span className="flex items-center justify-between text-muted-foreground">
                <span>Files</span>
                <span>{fileColumnWidth.toFixed(1)}fr</span>
              </span>
              <input type="range" min="0.9" max="2.1" step="0.1" value={fileColumnWidth} onChange={(e) => setFileColumnWidth(Number(e.target.value))} />
            </label>
            <label className="grid gap-2 text-xs">
              <span className="flex items-center justify-between text-muted-foreground">
                <span>Recipes</span>
                <span>{recipeColumnWidth.toFixed(1)}fr</span>
              </span>
              <input type="range" min="0.8" max="1.6" step="0.1" value={recipeColumnWidth} onChange={(e) => setRecipeColumnWidth(Number(e.target.value))} />
            </label>
          </div>
        </div>

        {/* Three-Column Layout */}
        <div
          className="grid grid-cols-1 gap-6 xl:grid-cols-[var(--models-groups-col)_var(--models-files-col)_var(--models-recipes-col)]"
          style={modelsLayoutStyle}
        >

          {/* LEFT: Model Groups */}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold mb-3">Model Groups</h2>
            {groupNames.length > 0 ? (
              <Tabs value={activeGroupTab || groupNames[0]} onValueChange={setActiveGroupTab} className="w-full">
                <TabsList className="mb-4 flex flex-wrap h-auto bg-muted/40 p-1">
                  {groupNames.map((gn) => (
                    <TabsTrigger key={gn} value={gn} className="px-3 py-1.5 text-xs">
                      {gn} <Badge variant="secondary" className="ml-1.5 bg-background drop-shadow-sm text-[10px]">{groupedModels[gn].length}</Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>

                {groupNames.map((gn) => (
                  <TabsContent key={gn} value={gn}>
                    <div className="grid gap-3 max-h-[60vh] overflow-y-auto pr-1">
                      {groupedModels[gn].map((g) => {
                        const running = isRunning(g.name);
                        return (
                          <Card
                            key={g.id}
                            onClick={() => loadWorkbenchFromGroup(g)}
                            className={`cursor-pointer border-border/40 bg-card/60 backdrop-blur-sm shadow-[0_8px_20px_-12px_rgba(56,189,248,0.4)] transition ${selectedWorkbenchId === g.id ? "ring-1 ring-cyan-400/45 shadow-[0_12px_26px_-16px_rgba(34,211,238,0.65)]" : "hover:border-cyan-400/25"}`}
                          >
                            <CardContent className="flex items-center justify-between py-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="font-semibold text-sm truncate">{g.name}</p>
                                  <Badge variant="outline" className="uppercase text-[10px]">{g.engine_type}</Badge>
                                  <Badge variant="secondary" className="uppercase text-[9px] tracking-[0.18em]">{inferModelClassification({ ...g, filename: g.name, arch: g.description, model_type: g.extra_args.includes("--mmproj") ? "multimodal_base" : "text" })}</Badge>
                                  {inferModality({ ...g, filename: g.name, arch: g.description, model_type: g.extra_args.includes("--mmproj") ? "multimodal_base" : "text" }) === "vision" && (
                                    <Badge className="bg-cyan-500/20 text-cyan-300 border-cyan-400/30 text-[9px]">Vision</Badge>
                                  )}
                                  {inferThinkingCapable({ ...g, filename: g.name, arch: g.description }) && (
                                    <Badge className="bg-violet-500/20 text-violet-300 border-violet-400/30 text-[9px]">Thinking</Badge>
                                  )}
                                  {running && <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px]">Running</Badge>}
                                </div>
                                {g.description && <p className="text-xs text-muted-foreground mt-0.5">{g.description}</p>}
                                <p className="text-[10px] text-muted-foreground font-mono mt-1 truncate">{g.model_path}</p>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                  <div className="grid gap-1">
                                    <Label className="text-[10px] text-muted-foreground">Classification</Label>
                                    <p className="text-xs font-medium px-2 py-1">{inferModelClassification({ ...g, filename: g.name, arch: g.description, model_type: g.extra_args.includes("--mmproj") ? "multimodal_base" : "text" }) === "moe" ? "Mixture of Experts" : "Dense"}</p>
                                  </div>
                                  <div className="grid gap-1">
                                    <Label className="text-[10px] text-muted-foreground">Recipe</Label>
                                    <select
                                      value={g.preset_recipe || inferPresetRecipeKey({ ...g, model_family: g.model_family })}
                                      onChange={(e) => void handleInlinePresetUpdate(g, { preset_recipe: e.target.value })}
                                      disabled={savingPresetMetaId === g.id}
                                      className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
                                    >
                                      {groupRecipesForFamily((g.model_family || inferPresetFamily(g)) as PresetFamily, allRecipes).map((group) => (
                                        <optgroup key={group.key} label={group.label}>
                                          {group.recipes.map((recipe) => (
                                            <option key={recipe.key} value={recipe.key}>{recipe.label}</option>
                                          ))}
                                        </optgroup>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground flex-wrap">
                                  <span>NGL: {g.n_gpu_layers}</span>
                                  <span>Batch: {g.batch_size}</span>
                                  <span>UBatch: {g.ubatch_size}</span>
                                  <span>Ctx: {g.ctx_size}</span>
                                </div>
                                {g.extra_args && <p className="text-[10px] text-cyan-300/80 font-mono mt-1 truncate">Args: {g.extra_args}</p>}
                              </div>
                              <div className="flex gap-1.5 ml-2 shrink-0">
                                {running ? (
                                  <Button variant="destructive" size="sm" onClick={() => handleStop(g.name)}>Stop</Button>
                                ) : (
                                  <Button size="sm" onClick={() => handleLaunch(g.id)} className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-md">Launch</Button>
                                )}
                                <Button variant="outline" size="sm" onClick={() => {
                                  const parsedOptions = parseExtraArgs(g.extra_args || "");
                                  const inferredRecipe = g.preset_recipe || inferPresetRecipeKey({
                                    model_family: g.model_family,
                                    filename: g.name,
                                    arch: g.description,
                                    model_type: g.extra_args.includes("--mmproj") ? "multimodal_base" : "text",
                                  });
                                  const hydrated = applyPresetRecipe(inferredRecipe, parsedOptions, allRecipes);
                                  setEditingGroupId(g.id); setNewGroupName(g.group_name); setNewName(g.name);
                                  setNewDesc(g.description); setNewPath(g.model_path); setNewEngine(g.engine_type);
                                  setNewModelFamily((g.model_family || hydrated.recipe.family) as PresetFamily);
                                  setNewNgl(g.n_gpu_layers); setNewBatch(g.batch_size); setNewUbatch(g.ubatch_size);
                                  setNewCtx(g.ctx_size); setSelectedRecipeKey(hydrated.recipe.key); setLaunchOptions(hydrated.options); setDialogOpen(true);
                                }}>Edit</Button>
                                <Button variant="ghost" size="sm" onClick={() => handleDelete(g.id)} className="text-destructive hover:bg-destructive/10">✕</Button>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <Card className="border-dashed border-border/40 bg-card/30">
                <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                  <p className="text-muted-foreground text-sm">No model groups yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">Click &quot;+ New Group&quot; to create one.</p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* RIGHT: Discovered Files */}
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Discovered GGUF Files <Badge variant="secondary" className="ml-2">{sortedModels.length}</Badge></h2>
              <div className="flex gap-2 text-xs">
                <Button variant="ghost" size="sm" onClick={() => handleSort("filename")}>Name {sortKey === "filename" ? (sortOrder === "asc" ? "↑" : "↓") : ""}</Button>
                <Button variant="ghost" size="sm" onClick={() => handleSort("size_bytes")}>Size {sortKey === "size_bytes" ? (sortOrder === "asc" ? "↑" : "↓") : ""}</Button>
              </div>
            </div>
            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-2xl border border-border/40 bg-card/40 p-3">
              <div className="min-w-[220px] flex-1 relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">🔍</span>
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter discovered files by name, arch, publisher, path..."
                  className="pl-9 h-10 border-border/40 bg-card/40"
                />
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Quantize</Label>
                <select value={filterQuant} onChange={e => setFilterQuant(e.target.value)} className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <option value="" className="bg-background text-foreground">All</option>
                  {allQuants.map(q => <option key={q} value={q} className="bg-background text-foreground">{q}</option>)}
                </select>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Param Size</Label>
                <select value={filterParamSize} onChange={e => setFilterParamSize(e.target.value)} className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <option value="" className="bg-background text-foreground">All</option>
                  {allParamSizes.map(p => <option key={p} value={p} className="bg-background text-foreground">{p}</option>)}
                </select>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Architecture</Label>
                <select value={filterArch} onChange={e => setFilterArch(e.target.value)} className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-w-[150px]">
                  <option value="" className="bg-background text-foreground">All</option>
                  {allArchs.map(a => <option key={a} value={a} className="bg-background text-foreground">{a}</option>)}
                </select>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Publisher</Label>
                <select value={filterPublisher} onChange={e => setFilterPublisher(e.target.value)} className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <option value="" className="bg-background text-foreground">All</option>
                  {allPublishers.map(p => <option key={p} value={p} className="bg-background text-foreground">{p}</option>)}
                </select>
              </div>
              <div className="grid gap-1">
                <Label className="text-[10px] text-muted-foreground">Model Type</Label>
                <select value={filterModelType} onChange={e => setFilterModelType(e.target.value)} className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <option value="" className="bg-background text-foreground">All</option>
                  {allModelTypes.map(t => <option key={t} value={t} className="bg-background text-foreground">{t}</option>)}
                </select>
              </div>
            </div>
            {errors.length > 0 && (
              <div className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-400">
                {errors.map((e, i) => <p key={i}>⚠ {e}</p>)}
              </div>
            )}
            {sortedModels.length > 0 ? (
              <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
                {sortedModels.map((m) => (
                  <Card key={m.filepath} className="border-border/50 bg-card/70 backdrop-blur-sm">
                    <CardHeader className="pb-2 pt-3">
                      <CardTitle className="text-sm flex items-center justify-between gap-2">
                        <span className="truncate">{overrides.find((o) => o.filepath === m.filepath)?.display_name || m.filename.replace(/\.gguf$/i, "")}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {m.arch && <Badge variant="secondary" className="text-[9px] uppercase tracking-[0.18em] bg-slate-700/50">{m.arch}</Badge>}
                          <Badge variant="secondary" className="text-[9px] uppercase tracking-[0.18em]">{inferModelClassification(m)}</Badge>
                          {inferModality(m) === "vision" && <Badge className="bg-cyan-500/20 text-cyan-300 border-cyan-400/30 text-[9px]">Vision</Badge>}
                          {inferThinkingCapable(m) && <Badge className="bg-violet-500/20 text-violet-300 border-violet-400/30 text-[9px]">Thinking</Badge>}
                          {hasOverride(m.filepath) && <Badge className="bg-amber-500/20 text-amber-300 border-amber-400/30 text-[9px]">Custom</Badge>}
                          {m.quantize ? <Badge variant="outline" className="text-[10px]">{m.quantize}</Badge> : null}
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 pb-3">
                      <p className="text-[11px] text-muted-foreground truncate">{m.filename}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                        <Badge variant="secondary">Param: {m.param_size || "unknown"}</Badge>
                        <Badge variant="secondary">File: {m.size_human}</Badge>
                        <Badge variant="secondary">Publisher: {m.publisher || "unknown"}</Badge>
                        <Badge variant="outline">Suggested: {getPresetRecipe(inferPresetRecipeKey(m), allRecipes).label}</Badge>
                      </div>
                      {m.model_type === "multimodal_base" && m.related_mmproj_path && (
                        <p className="mt-2 text-[10px] text-cyan-300/90 font-mono truncate">mmproj linked: {shortName(m.related_mmproj_path)}</p>
                      )}
                      {m.model_type === "multimodal_projector" && m.related_base_model_path && (
                        <p className="mt-2 text-[10px] text-orange-300/90 font-mono truncate">base linked: {shortName(m.related_base_model_path)}</p>
                      )}
                      <p className="mt-1 text-[10px] text-muted-foreground font-mono truncate">{m.parent_dir}</p>
                      {(() => {
                        const ov = overrides.find((o) => o.filepath === m.filepath);
                        if (!ov) return null;
                        return (
                          <>
                            {ov.tags && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {ov.tags.split(",").map((t) => t.trim()).filter(Boolean).map((tag) => (
                                  <Badge key={tag} className="bg-violet-500/15 text-violet-300 border-violet-400/20 text-[9px]">{tag}</Badge>
                                ))}
                              </div>
                            )}
                            {ov.notes && <p className="mt-1 text-[10px] text-amber-300/70 italic truncate">{ov.notes}</p>}
                          </>
                        );
                      })()}
                      <div className="mt-3 flex justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => openOverrideDialog(m)}
                        >
                          {hasOverride(m.filepath) ? "✎ Overridden" : "✎ Edit Props"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => {
                            setNewPath(m.filepath);
                            setNewName(m.filename.replace(".gguf", ""));
                            const dirParts = m.parent_dir.split("/");
                            const lastDir = dirParts[dirParts.length - 1];
                            if (lastDir) setNewGroupName(lastDir);
                            setNewEngine(defaultRuntimeName || runtimes[0]?.name || "");
                            hydratePresetFromModel(m);
                            setDialogOpen(true);
                          }}
                        >
                          + Add Preset
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="border-dashed border-border/40 bg-card/30">
                <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                  <p className="text-muted-foreground text-sm">No unassigned GGUF files found.</p>
                  <p className="text-xs text-muted-foreground mt-1">Configure scan directories in Settings.</p>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="min-w-0 xl:sticky xl:top-8 xl:self-start">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Recipe Setups</h2>
              <Button variant="outline" size="sm" className="text-[11px] h-7 px-2" onClick={openNewRecipeForm}>
                + New Recipe
              </Button>
            </div>
            <Card className="border-cyan-400/20 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.14),transparent_42%),rgba(2,6,23,0.82)] text-slate-100 shadow-[0_18px_50px_-28px_rgba(34,211,238,0.55)]">
              <CardContent className="space-y-4 pt-6">
                {/* Recipe list */}
                <div className="max-h-[30vh] overflow-y-auto space-y-1 pr-1">
                  <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-2">Built-in</p>
                  {PRESET_RECIPE_GROUPS.map((group) => {
                    const builtIns = PRESET_RECIPES.filter((r) => r.family === group.key);
                    if (!builtIns.length) return null;
                    return (
                      <div key={group.key}>
                        <p className="text-[9px] uppercase tracking-widest text-slate-500 mt-2 mb-1 pl-1">{group.label}</p>
                        {builtIns.map((r) => (
                          <button
                            key={r.key}
                            type="button"
                            onClick={() => openEditRecipeForm({ ...r })}
                            className={`w-full text-left rounded-lg px-2 py-1.5 text-xs transition-colors ${editingRecipe?.key === r.key ? "bg-cyan-500/20 text-cyan-100" : "hover:bg-white/5 text-slate-300"}`}
                          >
                            {r.label}
                            <span className="ml-1 text-[9px] opacity-50">built-in</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}

                  <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-2 mt-4">Custom</p>
                  {customRecipes.length === 0 && <p className="text-[11px] text-slate-500 pl-1">None yet.</p>}
                  {customRecipes.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => openEditRecipeForm(r)}
                      className={`w-full text-left rounded-lg px-2 py-1.5 text-xs transition-colors ${editingRecipe?.key === r.key ? "bg-cyan-500/20 text-cyan-100" : "hover:bg-white/5 text-slate-300"}`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>

                {/* Recipe detail / edit form */}
                {editingRecipe && PRESET_RECIPES.some((r) => r.key === editingRecipe.key) ? (
                  <div className="space-y-3 border-t border-white/10 pt-4">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-cyan-500/15 text-cyan-200 text-[10px]">Built-in · read-only</Badge>
                      <Badge variant="outline" className="text-[10px] text-slate-300">{editingRecipe.family}</Badge>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-black/20 p-3 space-y-2 text-sm text-slate-200">
                      <p><span className="text-slate-400 text-xs">Key:</span> <span className="font-mono text-xs">{editingRecipe.key}</span></p>
                      <p><span className="text-slate-400 text-xs">Label:</span> {editingRecipe.label}</p>
                      <p><span className="text-slate-400 text-xs">Description:</span> {editingRecipe.description}</p>
                      <p><span className="text-slate-400 text-xs">NGL / Batch / UBatch / Ctx:</span> {editingRecipe.ngl} / {editingRecipe.batch} / {editingRecipe.ubatch} / {editingRecipe.ctx}</p>
                      <p><span className="text-slate-400 text-xs">Tags:</span> {editingRecipe.tags.join(", ") || "—"}</p>
                    </div>
                    <Button variant="outline" size="sm" className="text-xs border-white/10 text-slate-200 hover:bg-white/10" onClick={() => {
                      openNewRecipeForm();
                      setRecipeForm({ ...editingRecipe, key: editingRecipe.key + "-custom", label: editingRecipe.label + " (Custom)" });
                    }}>Clone as Custom</Button>
                  </div>
                ) : (
                  <div className="space-y-3 border-t border-white/10 pt-4">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-cyan-500/15 text-cyan-200 text-[10px]">{editingRecipe ? "Edit" : "New recipe"}</Badge>
                      {editingRecipe && (
                        <Button variant="ghost" size="sm" className="text-xs h-6 text-red-400 hover:text-red-300 ml-auto" onClick={() => { void handleDeleteCustomRecipe(editingRecipe.key); openNewRecipeForm(); }}>
                          Delete
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1">
                        <Label className="text-xs text-slate-300">Key</Label>
                        <Input value={recipeForm.key} onChange={(e) => setRecipeForm((f) => ({ ...f, key: e.target.value.replace(/\s/g, "-") }))} placeholder="my-dense-heavy" className="text-xs font-mono border-white/10 bg-black/30 text-white" disabled={!!editingRecipe} />
                      </div>
                      <div className="grid gap-1">
                        <Label className="text-xs text-slate-300">Label</Label>
                        <Input value={recipeForm.label} onChange={(e) => setRecipeForm((f) => ({ ...f, label: e.target.value }))} placeholder="My Dense Heavy" className="text-xs border-white/10 bg-black/30 text-white" />
                      </div>
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-slate-300">Family</Label>
                      <select value={recipeForm.family} onChange={(e) => setRecipeForm((f) => ({ ...f, family: e.target.value as PresetFamily }))} className="flex h-9 w-full rounded-md border border-white/10 bg-black/30 px-3 py-1 text-sm text-white shadow-xs">
                        {PRESET_FAMILY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value} className="bg-slate-950 text-white">{opt.label}</option>)}
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-slate-300">Description</Label>
                      <Input value={recipeForm.description} onChange={(e) => setRecipeForm((f) => ({ ...f, description: e.target.value }))} placeholder="Short description" className="text-xs border-white/10 bg-black/30 text-white" />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-slate-300">Tags <span className="text-slate-500">(comma-separated)</span></Label>
                      <Input value={recipeForm.tags.join(", ")} onChange={(e) => setRecipeForm((f) => ({ ...f, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))} placeholder="dense, fast, custom" className="text-xs border-white/10 bg-black/30 text-white" />
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {(["ngl", "batch", "ubatch", "ctx"] as const).map((field) => (
                        <div key={field} className="grid gap-1">
                          <Label className="text-xs uppercase text-slate-300">{field}</Label>
                          <Input type="number" value={recipeForm[field]} onChange={(e) => setRecipeForm((f) => ({ ...f, [field]: +e.target.value }))} className="text-xs border-white/10 bg-black/30 text-white" />
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs text-slate-300">Options</Label>
                      <div className="flex flex-wrap gap-3 text-xs text-slate-200">
                        {(["flashAttn", "contBatching", "mlock", "noMmap", "noKvOffload"] as const).map((opt) => (
                          <label key={opt} className="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox" checked={!!(recipeForm.options as Record<string, unknown>)[opt]} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, [opt]: e.target.checked } }))} />
                            {opt}
                          </label>
                        ))}
                        <label className="flex items-center gap-1 text-xs cursor-pointer">
                          parallelSlots:
                          <Input type="number" className="w-16 h-6 text-xs px-1 border-white/10 bg-black/30 text-white" value={recipeForm.options.parallelSlots ?? 1} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, parallelSlots: +e.target.value } }))} />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <label className="grid gap-1 text-xs">
                          <span className="text-slate-400">KV Cache Type K</span>
                          <Input value={recipeForm.options.cacheTypeK ?? ""} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, cacheTypeK: e.target.value } }))} placeholder="e.g. q8_0" className="h-6 text-xs px-1 border-white/10 bg-black/30 text-white font-mono" />
                        </label>
                        <label className="grid gap-1 text-xs">
                          <span className="text-slate-400">KV Cache Type V</span>
                          <Input value={recipeForm.options.cacheTypeV ?? ""} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, cacheTypeV: e.target.value } }))} placeholder="e.g. q8_0" className="h-6 text-xs px-1 border-white/10 bg-black/30 text-white font-mono" />
                        </label>
                      </div>
                    </div>
                    <Button
                      className="w-full bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/20"
                      onClick={() => void handleSaveRecipeForm()}
                      disabled={savingRecipes || !recipeForm.key.trim() || !recipeForm.label.trim() || PRESET_RECIPES.some((r) => r.key === recipeForm.key.trim())}
                    >
                      {savingRecipes ? "Saving..." : (editingRecipe ? "Update Recipe" : "Create Recipe")}
                    </Button>
                    {PRESET_RECIPES.some((r) => r.key === recipeForm.key.trim()) && (
                      <p className="text-xs text-red-400">Key conflicts with a built-in recipe. Choose a different key.</p>
                    )}
                  </div>
                )}

                <p className="text-[11px] text-slate-400">
                  Recipe setups are independent templates. Apply them to any model group via the group&#39;s Recipe dropdown.
                </p>
              </CardContent>
            </Card>
          </div>

        </div>

        {/* Model Property Override Dialog */}
        <Dialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen}>
          <DialogContent className="sm:max-w-md max-h-[85vh] overflow-hidden">
            <DialogHeader>
              <DialogTitle>Edit Model Properties</DialogTitle>
            </DialogHeader>
            {overrideTarget && (
              <div className="grid max-h-[calc(85vh-5rem)] gap-3 overflow-y-auto py-3 pr-2">
                <p className="text-[11px] text-muted-foreground font-mono truncate">{overrideTarget.filename}</p>
                <div className="grid gap-2">
                  <Label className="text-xs">Display Name</Label>
                  <Input value={ovDisplayName} onChange={(e) => setOvDisplayName(e.target.value)} placeholder={overrideTarget.arch || overrideTarget.filename} className="text-xs" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-xs">Publisher</Label>
                    <Input value={ovPublisher} onChange={(e) => setOvPublisher(e.target.value)} placeholder={overrideTarget.publisher || "auto-detected"} className="text-xs" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Param Size</Label>
                    <Input value={ovParamSize} onChange={(e) => setOvParamSize(e.target.value)} placeholder={overrideTarget.param_size || "e.g. 9B"} className="text-xs" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-xs">Quantize</Label>
                    <Input value={ovQuantize} onChange={(e) => setOvQuantize(e.target.value)} placeholder={overrideTarget.quantize || "e.g. Q4_K_M"} className="text-xs" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">Architecture</Label>
                    <Input value={ovArch} onChange={(e) => setOvArch(e.target.value)} placeholder={overrideTarget.arch || "e.g. Llama"} className="text-xs" />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label className="text-xs">Model Classification</Label>
                  <select value={ovModelFamily} onChange={(e) => setOvModelFamily(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs">
                    {MODEL_CLASSIFICATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label className="text-xs">Tags (comma-separated)</Label>
                  <Input value={ovTags} onChange={(e) => setOvTags(e.target.value)} placeholder="fast, daily-use, coding" className="text-xs" />
                </div>
                <div className="grid gap-2">
                  <Label className="text-xs">Notes</Label>
                  <Textarea value={ovNotes} onChange={(e) => setOvNotes(e.target.value)} placeholder="Personal notes about this model..." className="text-xs min-h-16" />
                </div>
                <div className="flex gap-2 mt-1">
                  <Button onClick={handleSaveOverride} className="flex-1">Save Override</Button>
                  {hasOverride(overrideTarget.filepath) && (
                    <Button variant="outline" onClick={handleClearOverride} className="text-destructive hover:bg-destructive/10">Clear Override</Button>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Recipe Manager Dialog */}
        <Dialog open={recipeManagerOpen} onOpenChange={setRecipeManagerOpen}>
          <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Manage Recipes</DialogTitle>
            </DialogHeader>
            <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
              {/* Left: recipe list */}
              <div className="w-52 shrink-0 overflow-y-auto space-y-1 pr-1">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Built-in</p>
                {PRESET_RECIPE_GROUPS.map((group) => {
                  const builtIns = PRESET_RECIPES.filter((r) => r.family === group.key);
                  if (!builtIns.length) return null;
                  return (
                    <div key={group.key}>
                      <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60 mt-2 mb-1 pl-1">{group.label}</p>
                      {builtIns.map((r) => (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => openEditRecipeForm({ ...r })}
                          className={`w-full text-left rounded-lg px-2 py-1.5 text-xs transition-colors ${editingRecipe?.key === r.key ? "bg-accent text-accent-foreground" : "hover:bg-accent/50 text-muted-foreground"}`}
                        >
                          {r.label}
                          <span className="ml-1 text-[9px] opacity-50">built-in</span>
                        </button>
                      ))}
                    </div>
                  );
                })}

                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2 mt-4">Custom</p>
                {customRecipes.length === 0 && <p className="text-[11px] text-muted-foreground pl-1">None yet.</p>}
                {customRecipes.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => openEditRecipeForm(r)}
                    className={`w-full text-left rounded-lg px-2 py-1.5 text-xs transition-colors ${editingRecipe?.key === r.key ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                  >
                    {r.label}
                  </button>
                ))}
                <Button variant="outline" size="sm" className="w-full mt-3 text-xs h-7" onClick={openNewRecipeForm}>+ New Recipe</Button>
              </div>

              {/* Right: edit/view form */}
              <div className="flex-1 overflow-y-auto space-y-3 pl-2">
                {editingRecipe && PRESET_RECIPES.some((r) => r.key === editingRecipe.key) ? (
                  // Built-in: read-only view
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">Built-in · read-only</Badge>
                      <Badge variant="outline" className="text-[10px]">{editingRecipe.family}</Badge>
                    </div>
                    <div className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2 text-sm">
                      <p><span className="text-muted-foreground text-xs">Key:</span> <span className="font-mono text-xs">{editingRecipe.key}</span></p>
                      <p><span className="text-muted-foreground text-xs">Label:</span> {editingRecipe.label}</p>
                      <p><span className="text-muted-foreground text-xs">Description:</span> {editingRecipe.description}</p>
                      <p><span className="text-muted-foreground text-xs">NGL / Batch / UBatch / Ctx:</span> {editingRecipe.ngl} / {editingRecipe.batch} / {editingRecipe.ubatch} / {editingRecipe.ctx}</p>
                      <p><span className="text-muted-foreground text-xs">Tags:</span> {editingRecipe.tags.join(", ") || "—"}</p>
                      <p className="text-xs text-muted-foreground mt-2">Built-in recipes cannot be modified. Create a custom recipe to override behaviour.</p>
                    </div>
                    <Button variant="outline" size="sm" className="text-xs" onClick={() => {
                      openNewRecipeForm();
                      setRecipeForm({ ...editingRecipe, key: editingRecipe.key + "-custom", label: editingRecipe.label + " (Custom)" });
                    }}>Clone as Custom</Button>
                  </div>
                ) : (
                  // New / custom: full edit form
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">{editingRecipe ? "Edit" : "New recipe"}</Badge>
                      {editingRecipe && (
                        <Button variant="ghost" size="sm" className="text-xs h-6 text-destructive hover:text-destructive ml-auto" onClick={() => { void handleDeleteCustomRecipe(editingRecipe.key); openNewRecipeForm(); }}>
                          Delete
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1">
                        <Label className="text-xs">Key <span className="text-muted-foreground">(unique, no spaces)</span></Label>
                        <Input value={recipeForm.key} onChange={(e) => setRecipeForm((f) => ({ ...f, key: e.target.value.replace(/\s/g, "-") }))} placeholder="my-dense-heavy" className="text-xs font-mono" disabled={!!editingRecipe} />
                      </div>
                      <div className="grid gap-1">
                        <Label className="text-xs">Label</Label>
                        <Input value={recipeForm.label} onChange={(e) => setRecipeForm((f) => ({ ...f, label: e.target.value }))} placeholder="My Dense Heavy" className="text-xs" />
                      </div>
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs">Family</Label>
                      <select value={recipeForm.family} onChange={(e) => setRecipeForm((f) => ({ ...f, family: e.target.value as PresetFamily }))} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                        {PRESET_FAMILY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs">Description</Label>
                      <Input value={recipeForm.description} onChange={(e) => setRecipeForm((f) => ({ ...f, description: e.target.value }))} placeholder="Short description of this recipe" className="text-xs" />
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs">Tags <span className="text-muted-foreground">(comma-separated)</span></Label>
                      <Input value={recipeForm.tags.join(", ")} onChange={(e) => setRecipeForm((f) => ({ ...f, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))} placeholder="dense, fast, custom" className="text-xs" />
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {(["ngl", "batch", "ubatch", "ctx"] as const).map((field) => (
                        <div key={field} className="grid gap-1">
                          <Label className="text-xs uppercase">{field}</Label>
                          <Input type="number" value={recipeForm[field]} onChange={(e) => setRecipeForm((f) => ({ ...f, [field]: +e.target.value }))} className="text-xs" />
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs">Options</Label>
                      <div className="flex flex-wrap gap-3 text-xs">
                        {(["flashAttn", "contBatching", "mlock", "noMmap", "noKvOffload"] as const).map((opt) => (
                          <label key={opt} className="flex items-center gap-1 cursor-pointer">
                            <input type="checkbox" checked={!!(recipeForm.options as Record<string, unknown>)[opt]} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, [opt]: e.target.checked } }))} />
                            {opt}
                          </label>
                        ))}
                        <label className="flex items-center gap-1 text-xs cursor-pointer">
                          parallelSlots:
                          <Input type="number" className="w-16 h-6 text-xs px-1" value={recipeForm.options.parallelSlots ?? 1} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, parallelSlots: +e.target.value } }))} />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <label className="grid gap-1 text-xs">
                          <span className="text-muted-foreground">KV Cache Type K</span>
                          <Input value={recipeForm.options.cacheTypeK ?? ""} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, cacheTypeK: e.target.value } }))} placeholder="e.g. q8_0" className="h-6 text-xs px-1 font-mono" />
                        </label>
                        <label className="grid gap-1 text-xs">
                          <span className="text-muted-foreground">KV Cache Type V</span>
                          <Input value={recipeForm.options.cacheTypeV ?? ""} onChange={(e) => setRecipeForm((f) => ({ ...f, options: { ...f.options, cacheTypeV: e.target.value } }))} placeholder="e.g. q8_0" className="h-6 text-xs px-1 font-mono" />
                        </label>
                      </div>
                    </div>
                    <Button
                      className="w-full"
                      onClick={() => void handleSaveRecipeForm()}
                      disabled={savingRecipes || !recipeForm.key.trim() || !recipeForm.label.trim() || PRESET_RECIPES.some((r) => r.key === recipeForm.key.trim())}
                    >
                      {savingRecipes ? "Saving..." : (editingRecipe ? "Update Recipe" : "Create Recipe")}
                    </Button>
                    {PRESET_RECIPES.some((r) => r.key === recipeForm.key.trim()) && (
                      <p className="text-xs text-destructive">Key conflicts with a built-in recipe. Choose a different key.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  );
}
