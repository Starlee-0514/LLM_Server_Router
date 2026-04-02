"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getBenchmarkHistory, type BenchmarkRecord } from "@/lib/api";

export default function BenchmarksPage() {
  const [records, setRecords] = useState<BenchmarkRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await getBenchmarkHistory();
      setRecords(data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  // Find best pp and tg for highlighting
  const bestPp = Math.max(...records.filter(r => r.pp_tokens_per_second).map(r => r.pp_tokens_per_second!), 0);
  const bestTg = Math.max(...records.filter(r => r.tg_tokens_per_second).map(r => r.tg_tokens_per_second!), 0);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Benchmark Viewer</h1>
            <p className="text-sm text-muted-foreground mt-1">llama-bench 效能測試結果對比</p>
          </div>
          <Button variant="outline" onClick={refresh}>⟳ Refresh</Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Tests</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold">{records.length}</span>
            </CardContent>
          </Card>
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Best PP t/s</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                {bestPp > 0 ? bestPp.toFixed(1) : "—"}
              </span>
            </CardContent>
          </Card>
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Best TG t/s</CardTitle>
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                {bestTg > 0 ? bestTg.toFixed(1) : "—"}
              </span>
            </CardContent>
          </Card>
        </div>

        {/* Results Table */}
        {records.length > 0 ? (
          <div className="rounded-lg border border-border/40 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Model</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Engine</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">NGL</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Batch</th>
                  <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Ctx</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">PP t/s</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">TG t/s</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20">
                {records.map((r) => (
                  <tr key={r.id} className="hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-xs">{r.model_name}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="uppercase text-[10px]">{r.engine_type}</Badge>
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-mono">{r.n_gpu_layers}</td>
                    <td className="px-4 py-3 text-center text-xs font-mono">{r.batch_size}</td>
                    <td className="px-4 py-3 text-center text-xs font-mono">{r.ctx_size}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      <span className={r.pp_tokens_per_second === bestPp && bestPp > 0 ? "text-blue-400 font-bold" : ""}>
                        {r.pp_tokens_per_second?.toFixed(1) ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      <span className={r.tg_tokens_per_second === bestTg && bestTg > 0 ? "text-purple-400 font-bold" : ""}>
                        {r.tg_tokens_per_second?.toFixed(1) ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                      {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Card className="border-dashed border-border/40 bg-card/30">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-muted-foreground text-sm">No benchmark results yet.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Run benchmarks from the Models page or via API.
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
