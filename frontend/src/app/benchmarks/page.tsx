"use client";

import { useEffect, useState, useRef } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  getBenchmarkHistory,
  getModelGroups,
  runBenchmark,
  deleteBenchmark,
  importBenchmarks,
  type BenchmarkRecord,
  type ModelGroup,
} from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export default function BenchmarksPage() {
  const [records, setRecords] = useState<BenchmarkRecord[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [batchSizesStr, setBatchSizesStr] = useState("");
  const [n_gpu_layersStr, setN_gpu_layersStr] = useState("");
  const [nPrompt, setNPrompt] = useState(512);
  const [nGen, setNGen] = useState(128);
  const [flashAttn, setFlashAttn] = useState(0);
  const [noKvOffload, setNoKvOffload] = useState(0);
  const [debugLog, setDebugLog] = useState<string>("");
  const logEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [debugLog]);

  const handleGroupSelect = (idStr: string) => {
    setSelectedGroupId(idStr);
    const group = groups.find((g) => g.id === parseInt(idStr));
    if (group) {
      setBatchSizesStr(String(group.batch_size));
      setN_gpu_layersStr(String(group.n_gpu_layers));
    }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const [data, groupsData] = await Promise.all([
        getBenchmarkHistory(),
        getModelGroups(),
      ]);
      setRecords(data);
      setGroups(groupsData);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRun = async () => {
    if (!selectedGroupId) return;
    const group = groups.find((g) => g.id === parseInt(selectedGroupId));
    if (!group) return;

    const batches = batchSizesStr.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
    const ngls = n_gpu_layersStr.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));

    if (batches.length === 0) batches.push(group.batch_size);
    if (ngls.length === 0) ngls.push(group.n_gpu_layers);

    setRunning(true);
    let total = batches.length * ngls.length;
    try {
      for (const batch of batches) {
        for (const ngl of ngls) {
          setDebugLog((prev) => prev + `Running test for ${group.name} (NGL: ${ngl}, Batch: ${batch}, pp: ${nPrompt}, tg: ${nGen}, FA: ${flashAttn})...\n`);
          const result = await runBenchmark({
            model_name: group.name,
            model_path: group.model_path,
            engine_type: group.engine_type,
            n_gpu_layers: ngl,
            batch_size: batch,
            ubatch_size: group.ubatch_size,
            ctx_size: group.ctx_size,
            n_prompt: nPrompt,
            n_gen: nGen,
            flash_attn: flashAttn,
            no_kv_offload: noKvOffload,
          });
          setDebugLog((prev) => prev + `\n--- Completed (NGL: ${ngl}, Batch: ${batch}) ---\n${result.raw_output || "No output"}\n`);
          await refresh();
        }
      }
      alert(`Completed ${total} benchmark(s)!`);
    } catch (e: any) {
      setDebugLog((prev) => prev + `\n[ERROR] ${e.message}\n`);
      alert("Error: " + e.message);
    } finally {
      setRunning(false);
    }
  };

  const handleDeleteRecord = async (id: number) => {
    if (!confirm("Delete this record?")) return;
    try { await deleteBenchmark(id); await refresh(); } catch (e: any) { alert(e.message); }
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
      } catch (err: any) {
        alert("Import failed: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  const bestPp = Math.max(...records.filter((r) => r.pp_tokens_per_second).map((r) => r.pp_tokens_per_second!), 0);
  const bestTg = Math.max(...records.filter((r) => r.tg_tokens_per_second).map((r) => r.tg_tokens_per_second!), 0);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Benchmark Viewer</h1>
            <p className="text-sm text-muted-foreground mt-1">llama-bench 效能測試結果對比</p>
          </div>
          <div className="flex gap-2">
            <input type="file" id="import-bench" className="hidden" accept=".json" onChange={handleImport} />
            <Button variant="outline" size="sm" onClick={() => document.getElementById("import-bench")?.click()}>Import JSON</Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={records.length === 0}>Export JSON</Button>
            <Button variant="outline" size="sm" onClick={refresh}>⟳ Refresh</Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Tests</CardTitle></CardHeader>
            <CardContent><span className="text-3xl font-bold">{records.length}</span></CardContent>
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

        {/* Run Benchmark Card */}
        <Card className="mb-6 border-border/40 bg-card/60 backdrop-blur-sm">
          <CardHeader><CardTitle className="text-sm">Run New Benchmark</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex gap-3 items-end flex-wrap">
              <div className="grid gap-2 flex-1 min-w-[180px]">
                <Label className="text-xs">Model Preset</Label>
                <select value={selectedGroupId} onChange={(e) => handleGroupSelect(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <option value="" className="bg-background text-foreground">-- Choose --</option>
                  {groups.map((g) => (<option key={g.id} value={g.id} className="bg-background text-foreground">{g.group_name} / {g.name}</option>))}
                </select>
              </div>
              <div className="grid gap-2 w-36">
                <Label className="text-xs">Batch Sizes</Label>
                <Input value={batchSizesStr} onChange={(e) => setBatchSizesStr(e.target.value)} placeholder="512, 1024" className="text-xs" />
              </div>
              <div className="grid gap-2 w-36">
                <Label className="text-xs">GPU Layers</Label>
                <Input value={n_gpu_layersStr} onChange={(e) => setN_gpu_layersStr(e.target.value)} placeholder="99, 50" className="text-xs" />
              </div>
              <div className="grid gap-2 w-24">
                <Label className="text-xs">PP Tokens</Label>
                <Input type="number" value={nPrompt} onChange={(e) => setNPrompt(+e.target.value)} className="text-xs" />
              </div>
              <div className="grid gap-2 w-24">
                <Label className="text-xs">TG Tokens</Label>
                <Input type="number" value={nGen} onChange={(e) => setNGen(+e.target.value)} className="text-xs" />
              </div>
              <div className="grid gap-2 w-24">
                <Label className="text-xs">Flash Attn</Label>
                <select value={flashAttn} onChange={(e) => setFlashAttn(+e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
                  <option value={0} className="bg-background text-foreground">Off</option>
                  <option value={1} className="bg-background text-foreground">On</option>
                </select>
              </div>
              <div className="grid gap-2 w-24">
                <Label className="text-xs">KV Offload</Label>
                <select value={noKvOffload} onChange={(e) => setNoKvOffload(+e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-xs">
                  <option value={0} className="bg-background text-foreground">Yes</option>
                  <option value={1} className="bg-background text-foreground">No</option>
                </select>
              </div>
              <Button onClick={handleRun} disabled={running || !selectedGroupId} className="bg-gradient-to-r from-purple-500 to-indigo-500 text-white shadow-md">
                {running ? "Running..." : "▶ Run"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Results Table FIRST (switched with debug log) */}
        {records.length > 0 ? (
          <div className="rounded-lg border border-border/40 overflow-hidden mb-6 max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Model</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Engine</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">NGL</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Batch</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">PP t/s</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">TG t/s</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                  <th className="px-4 py-2.5 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {records.map((r) => (
                  <tr key={r.id} className="hover:bg-accent/30 transition-colors group">
                    <td className="px-4 py-3 font-medium text-xs">{r.model_name}</td>
                    <td className="px-4 py-3 text-center"><Badge variant="outline" className="uppercase text-[10px]">{r.engine_type}</Badge></td>
                    <td className="px-4 py-3 text-center text-xs font-mono">{r.n_gpu_layers}</td>
                    <td className="px-4 py-3 text-center text-xs font-mono">{r.batch_size}</td>
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
        ) : (
          <Card className="border-dashed border-border/40 bg-card/30 mb-6">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-muted-foreground text-sm">No benchmark results yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Use the form above to run a benchmark.</p>
            </CardContent>
          </Card>
        )}

        {/* Debug Log SECOND (switched) */}
        {debugLog && (
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between py-2">
              <CardTitle className="text-sm">Testing Debug Log</CardTitle>
              <Button variant="ghost" size="xs" onClick={() => setDebugLog("")} className="h-7 text-xs px-2">Clear Log</Button>
            </CardHeader>
            <CardContent>
              <div className="bg-black/50 p-4 rounded-md overflow-x-auto max-h-[300px] overflow-y-auto">
                <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap">{debugLog}</pre>
                <div ref={logEndRef} />
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
