"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  createModelGroup,
  updateModelGroup,
  deleteModelGroup,
  launchModelGroup,
  stopProcess,
  getAllProcessStatus,
  type GGUFFileInfo,
  type ModelGroup,
  type AllProcessesStatus,
} from "@/lib/api";

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
  const [newEngine, setNewEngine] = useState("rocm");
  const [newNgl, setNewNgl] = useState(999);
  const [newBatch, setNewBatch] = useState(2048);
  const [newUbatch, setNewUbatch] = useState(512);
  const [newCtx, setNewCtx] = useState(8192);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterQuant, setFilterQuant] = useState("");
  const [filterParamSize, setFilterParamSize] = useState("");

  const resetForm = () => {
    setNewGroupName("Default");
    setNewName("");
    setNewDesc("");
    setNewPath("");
    setNewEngine("rocm");
    setNewNgl(999);
    setNewBatch(2048);
    setNewUbatch(512);
    setNewCtx(8192);
    setEditingGroupId(null);
  };

  // Sorting state
  const [sortKey, setSortKey] = useState<keyof GGUFFileInfo>("filename");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  const handleSort = (key: keyof GGUFFileInfo) => {
    if (sortKey === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  // Get unique filter options
  const allQuants = [...new Set(models.map(m => m.quantize).filter(Boolean))].sort();
  const allParamSizes = [...new Set(models.map(m => m.param_size).filter(Boolean))].sort((a, b) => {
    const na = parseFloat(a); const nb = parseFloat(b);
    return na - nb;
  });

  const sortedModels = [...models]
    .filter((m) => {
      if (groups.some((g) => g.model_path === m.filepath)) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!m.filename.toLowerCase().includes(q) && !m.parent_dir.toLowerCase().includes(q) && !m.arch.toLowerCase().includes(q)) return false;
      }
      if (filterQuant && m.quantize !== filterQuant) return false;
      if (filterParamSize && m.param_size !== filterParamSize) return false;
      return true;
    })
    .sort((a, b) => {
      let valA = a[sortKey];
      let valB = b[sortKey];
      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

  // Group models by group_name
  const groupedModels = groups.reduce((acc, g) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const match = g.name.toLowerCase().includes(q) ||
                    g.group_name.toLowerCase().includes(q) ||
                    g.description.toLowerCase().includes(q);
      if (!match) return acc;
    }
    const key = g.group_name || "Default";
    if (!acc[key]) acc[key] = [];
    acc[key].push(g);
    return acc;
  }, {} as Record<string, ModelGroup[]>);
  const groupNames = Object.keys(groupedModels);

  const refreshAll = async () => {
    try {
      const [g, p] = await Promise.all([getModelGroups(), getAllProcessStatus()]);
      setGroups(g);
      setProcesses(p);
    } catch {}
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await scanModels();
      setModels(res.models);
      setErrors(res.errors);
    } catch (e: any) {
      setErrors([e.message]);
    } finally {
      setScanning(false);
    }
  };

  const handleCreateOrUpdateGroup = async () => {
    setCreating(true);
    try {
      const payload = {
        group_name: newGroupName, name: newName, description: newDesc,
        model_path: newPath, engine_type: newEngine, n_gpu_layers: newNgl,
        batch_size: newBatch, ubatch_size: newUbatch, ctx_size: newCtx, extra_args: "",
      };
      if (editingGroupId) {
        await updateModelGroup(editingGroupId, payload);
      } else {
        await createModelGroup(payload);
      }
      setDialogOpen(false);
      resetForm();
      await refreshAll();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleLaunch = async (id: number) => { try { await launchModelGroup(id); await refreshAll(); } catch (e: any) { alert(e.message); } };
  const handleStop = async (identifier: string) => { try { await stopProcess(identifier); await refreshAll(); } catch (e: any) { alert(e.message); } };
  const handleDelete = async (id: number) => { if (!confirm("確定要刪除此群組？")) return; try { await deleteModelGroup(id); await refreshAll(); } catch (e: any) { alert(e.message); } };
  const isRunning = (name: string) => processes.processes.some((p) => p.identifier === name && p.is_running);

  useEffect(() => {
    refreshAll();
    handleScan();
    const interval = setInterval(refreshAll, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Model Manager</h1>
            <p className="text-sm text-muted-foreground mt-1">管理 GGUF 模型與預設群組</p>
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
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{editingGroupId ? "編輯模型群組" : "建立模型群組"}</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
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
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label>Engine</Label>
                      <select value={newEngine} onChange={(e) => setNewEngine(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                        <option value="rocm" className="bg-background text-foreground">ROCm</option>
                        <option value="vulkan" className="bg-background text-foreground">Vulkan</option>
                      </select>
                    </div>
                    <div className="grid gap-2">
                      <Label>GPU Layers</Label>
                      <Input type="number" value={newNgl} onChange={(e) => setNewNgl(+e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
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
                </div>
                <Button onClick={handleCreateOrUpdateGroup} disabled={creating || !newName || !newPath} className="w-full">
                  {creating ? "Saving..." : (editingGroupId ? "Update Group" : "Create Group")}
                </Button>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="mb-6 flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[200px] relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">🔍</span>
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by filename, arch, group..."
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
        </div>

        {/* Two-Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* LEFT: Model Groups */}
          <div>
            <h2 className="text-lg font-semibold mb-3">Model Groups</h2>
            {groupNames.length > 0 ? (
              <Tabs defaultValue={groupNames[0]} className="w-full">
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
                          <Card key={g.id} className="border-border/40 bg-card/60 backdrop-blur-sm">
                            <CardContent className="flex items-center justify-between py-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="font-semibold text-sm truncate">{g.name}</p>
                                  <Badge variant="outline" className="uppercase text-[10px]">{g.engine_type}</Badge>
                                  {running && <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px]">Running</Badge>}
                                </div>
                                {g.description && <p className="text-xs text-muted-foreground mt-0.5">{g.description}</p>}
                                <p className="text-[10px] text-muted-foreground font-mono mt-1 truncate">{g.model_path}</p>
                                <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
                                  <span>NGL: {g.n_gpu_layers}</span>
                                  <span>Batch: {g.batch_size}</span>
                                  <span>Ctx: {g.ctx_size}</span>
                                </div>
                              </div>
                              <div className="flex gap-1.5 ml-2 shrink-0">
                                {running ? (
                                  <Button variant="destructive" size="sm" onClick={() => handleStop(g.name)}>Stop</Button>
                                ) : (
                                  <Button size="sm" onClick={() => handleLaunch(g.id)} className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-md">Launch</Button>
                                )}
                                <Button variant="outline" size="sm" onClick={() => {
                                  setEditingGroupId(g.id); setNewGroupName(g.group_name); setNewName(g.name);
                                  setNewDesc(g.description); setNewPath(g.model_path); setNewEngine(g.engine_type);
                                  setNewNgl(g.n_gpu_layers); setNewBatch(g.batch_size); setNewUbatch(g.ubatch_size);
                                  setNewCtx(g.ctx_size); setDialogOpen(true);
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
          <div>
            <h2 className="text-lg font-semibold mb-3">Discovered GGUF Files <Badge variant="secondary" className="ml-2">{sortedModels.length}</Badge></h2>
            {errors.length > 0 && (
              <div className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-400">
                {errors.map((e, i) => <p key={i}>⚠ {e}</p>)}
              </div>
            )}
            {sortedModels.length > 0 ? (
              <div className="rounded-lg border border-border/40 overflow-hidden max-h-[70vh] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 sticky top-0 z-10">
                    <tr>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => handleSort("filename")}>
                        Filename {sortKey === "filename" && (sortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => handleSort("param_size")}>
                        Size {sortKey === "param_size" && (sortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => handleSort("quantize")}>
                        Quant {sortKey === "quantize" && (sortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th className="px-3 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase tracking-wider cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => handleSort("size_bytes")}>
                        File {sortKey === "size_bytes" && (sortOrder === "asc" ? "↑" : "↓")}
                      </th>
                      <th className="px-3 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    {sortedModels.map((m) => (
                      <tr key={m.filepath} className="hover:bg-accent/30 transition-colors">
                        <td className="px-3 py-2.5">
                          <p className="font-mono text-xs truncate max-w-[180px]" title={m.filename}>{m.arch || m.filename}</p>
                          <p className="text-[10px] text-muted-foreground truncate max-w-[180px]">{m.publisher}</p>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">{m.param_size || "—"}</td>
                        <td className="px-3 py-2.5">
                          {m.quantize ? <Badge variant="outline" className="text-[10px]">{m.quantize}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">{m.size_human}</td>
                        <td className="px-3 py-2.5 text-right">
                          <Button variant="ghost" size="sm" className="text-xs" onClick={() => {
                            setNewPath(m.filepath); setNewName(m.filename.replace(".gguf", ""));
                            const dirParts = m.parent_dir.split('/');
                            const lastDir = dirParts[dirParts.length - 1];
                            if (lastDir) setNewGroupName(lastDir);
                            setDialogOpen(true);
                          }}>
                            + Add
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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

        </div>
      </main>
    </div>
  );
}
