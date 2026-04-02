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
import {
  scanModels,
  getModelGroups,
  createModelGroup,
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
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newEngine, setNewEngine] = useState("rocm");
  const [newNgl, setNewNgl] = useState(999);
  const [newBatch, setNewBatch] = useState(2048);
  const [newUbatch, setNewUbatch] = useState(512);
  const [newCtx, setNewCtx] = useState(8192);
  const [dialogOpen, setDialogOpen] = useState(false);

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

  const handleCreateGroup = async () => {
    setCreating(true);
    try {
      await createModelGroup({
        name: newName,
        description: newDesc,
        model_path: newPath,
        engine_type: newEngine,
        n_gpu_layers: newNgl,
        batch_size: newBatch,
        ubatch_size: newUbatch,
        ctx_size: newCtx,
        extra_args: "",
      });
      setDialogOpen(false);
      setNewName(""); setNewDesc(""); setNewPath("");
      await refreshAll();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleLaunch = async (id: number) => {
    try {
      await launchModelGroup(id);
      await refreshAll();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleStop = async (identifier: string) => {
    try {
      await stopProcess(identifier);
      await refreshAll();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("確定要刪除此群組？")) return;
    try {
      await deleteModelGroup(id);
      await refreshAll();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const isRunning = (name: string) =>
    processes.processes.some((p) => p.identifier === name && p.is_running);

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
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Model Manager</h1>
            <p className="text-sm text-muted-foreground mt-1">管理 GGUF 模型與預設群組</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleScan} disabled={scanning}>
              {scanning ? "Scanning..." : "⟳ Scan Models"}
            </Button>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40 transition-shadow">
                  + New Group
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>建立模型群組</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label>Name</Label>
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
                      <select value={newEngine} onChange={(e) => setNewEngine(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                        <option value="rocm">ROCm</option>
                        <option value="vulkan">Vulkan</option>
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
                <Button onClick={handleCreateGroup} disabled={creating || !newName || !newPath} className="w-full">
                  {creating ? "Creating..." : "Create Group"}
                </Button>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Model Groups */}
        <h2 className="text-lg font-semibold mb-3">Model Groups</h2>
        {groups.length > 0 ? (
          <div className="grid gap-3 mb-8">
            {groups.map((g) => {
              const running = isRunning(g.name);
              return (
                <Card key={g.id} className="border-border/40 bg-card/60 backdrop-blur-sm">
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold">{g.name}</p>
                        <Badge variant="outline" className="uppercase text-[10px]">{g.engine_type}</Badge>
                        {running && <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px]">Running</Badge>}
                      </div>
                      {g.description && <p className="text-xs text-muted-foreground mt-0.5">{g.description}</p>}
                      <p className="text-xs text-muted-foreground font-mono mt-1 truncate max-w-xl">{g.model_path}</p>
                      <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
                        <span>NGL: {g.n_gpu_layers}</span>
                        <span>Batch: {g.batch_size}</span>
                        <span>UBatch: {g.ubatch_size}</span>
                        <span>Ctx: {g.ctx_size}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {running ? (
                        <Button variant="destructive" size="sm" onClick={() => handleStop(g.name)}>Stop</Button>
                      ) : (
                        <Button size="sm" onClick={() => handleLaunch(g.id)} className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white">Launch</Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(g.id)} className="text-destructive hover:text-destructive">✕</Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="border-dashed border-border/40 bg-card/30 mb-8">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-muted-foreground text-sm">No model groups yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Click &quot;+ New Group&quot; to create one.</p>
            </CardContent>
          </Card>
        )}

        {/* Scanned Files */}
        <h2 className="text-lg font-semibold mb-3">Discovered GGUF Files</h2>
        {errors.length > 0 && (
          <div className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-400">
            {errors.map((e, i) => <p key={i}>⚠ {e}</p>)}
          </div>
        )}
        {models.length > 0 ? (
          <div className="rounded-lg border border-border/40 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Filename</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Size</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Directory</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {models.map((m) => (
                  <tr key={m.filepath} className="hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{m.filename}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{m.size_human}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-xs">{m.parent_dir}</td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                          setNewPath(m.filepath);
                          setNewName(m.filename.replace(".gguf", ""));
                          setDialogOpen(true);
                        }}
                      >
                        + Add to Group
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
              <p className="text-muted-foreground text-sm">No GGUF files found.</p>
              <p className="text-xs text-muted-foreground mt-1">Configure scan directories in Settings first.</p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
