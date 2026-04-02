"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getSettings, updateSettings, type SettingItem } from "@/lib/api";

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [scanDirs, setScanDirs] = useState<string[]>([]);
  const [newDir, setNewDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = async () => {
    try {
      const data = await getSettings();
      setSettings(data);
      const dirs = data.find((s) => s.key === "model_scan_dirs");
      if (dirs) {
        try {
          setScanDirs(JSON.parse(dirs.value));
        } catch {
          setScanDirs([]);
        }
      }
    } catch {}
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAddDir = () => {
    const trimmed = newDir.trim();
    if (trimmed && !scanDirs.includes(trimmed)) {
      setScanDirs([...scanDirs, trimmed]);
      setNewDir("");
    }
  };

  const handleRemoveDir = (dir: string) => {
    setScanDirs(scanDirs.filter((d) => d !== dir));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings([
        { key: "model_scan_dirs", value: JSON.stringify(scanDirs) },
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await refresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  const getSettingValue = (key: string) =>
    settings.find((s) => s.key === key)?.value || "";

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-56 flex-1 p-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">系統配置管理</p>
        </div>

        <div className="max-w-2xl space-y-6">
          {/* Scan Directories */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Model Scan Directories</CardTitle>
              <p className="text-xs text-muted-foreground">
                設定要掃描 GGUF 模型的資料夾路徑
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {scanDirs.length > 0 && (
                <div className="space-y-2">
                  {scanDirs.map((dir) => (
                    <div key={dir} className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                      <span className="font-mono text-xs truncate flex-1">{dir}</span>
                      <Button variant="ghost" size="sm" onClick={() => handleRemoveDir(dir)} className="text-destructive hover:text-destructive ml-2 h-6 w-6 p-0">
                        ✕
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={newDir}
                  onChange={(e) => setNewDir(e.target.value)}
                  placeholder="/home/starlee/models"
                  className="font-mono text-xs"
                  onKeyDown={(e) => e.key === "Enter" && handleAddDir()}
                />
                <Button variant="outline" onClick={handleAddDir} disabled={!newDir.trim()}>
                  Add
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Environment Info */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">Environment Info</CardTitle>
              <p className="text-xs text-muted-foreground">
                從 .env 和資料庫讀取的設定值（唯讀）
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {settings.filter(s => s.key !== "model_scan_dirs").map((s) => (
                  <div key={s.key} className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">{s.key}</span>
                    <Badge variant="secondary" className="font-mono text-[10px] max-w-xs truncate">{s.value}</Badge>
                  </div>
                ))}
                {settings.filter(s => s.key !== "model_scan_dirs").length === 0 && (
                  <p className="text-xs text-muted-foreground">No additional settings configured.</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* API Endpoint Info */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-base">API Endpoints</CardTitle>
              <p className="text-xs text-muted-foreground">
                OpenAI 兼容 API 端點，供 IDE 或遠端裝置連線
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Chat Completions</span>
                  <code className="font-mono text-xs">http://&lt;IP&gt;:8000/v1/chat/completions</code>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Models</span>
                  <code className="font-mono text-xs">http://&lt;IP&gt;:8000/v1/models</code>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <span className="text-xs text-muted-foreground">API Docs</span>
                  <code className="font-mono text-xs">http://localhost:8000/docs</code>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Save Button */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-gradient-to-r from-red-500 to-orange-500 text-white shadow-lg shadow-red-500/20 hover:shadow-red-500/40 transition-shadow"
            >
              {saving ? "Saving..." : "💾 Save Changes"}
            </Button>
            {saved && <span className="text-xs text-emerald-400 animate-pulse">✓ Saved successfully</span>}
          </div>
        </div>
      </main>
    </div>
  );
}
