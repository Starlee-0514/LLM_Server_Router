"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

interface EndpointRow {
  method: string;
  path: string;
  desc: string;
}

const ENDPOINTS: EndpointRow[] = [
  { method: "GET/HEAD", path: "/",            desc: "Root health check used by Ollama-aware clients" },
  { method: "GET/HEAD", path: "/api/version", desc: "Version check aligned with Ollama v0.20.x" },
  { method: "GET",      path: "/api/status",  desc: "Cloud status payload expected by newer Ollama clients" },
  { method: "GET/HEAD", path: "/api/tags",    desc: "List available models in Ollama format" },
  { method: "GET",      path: "/api/ps",      desc: "List currently loaded models in Ollama process format" },
  { method: "POST",     path: "/api/show",    desc: "Model metadata, capabilities, and details" },
  { method: "POST",     path: "/api/chat",    desc: "Chat completions with Ollama-to-OpenAI translation" },
  { method: "POST",     path: "/api/generate",desc: "Single-prompt text generation in Ollama format" },
];

interface ToolConfig {
  name: string;
  icon: string;
  steps: string[];
  url: string;
}

function getTools(base: string): ToolConfig[] {
  return [
    {
      name: "Open WebUI",
      icon: "🌐",
      url: "https://docs.openwebui.com",
      steps: [
        `Go to Admin Panel → Settings → Connections`,
        `Under "Ollama" section set the URL to:  ${base}`,
        `Click "Save" — your router models will appear immediately`,
      ],
    },
    {
      name: "Continue.dev",
      icon: "⚡",
      url: "https://continue.dev",
      steps: [
        `Open VS Code → Continue extension → config.json`,
        `Add a model entry:`,
        JSON.stringify(
          { title: "Router (Ollama)", provider: "ollama", model: "YOUR_MODEL", apiBase: base },
          null,
          2,
        ),
      ],
    },
    {
      name: "Aider",
      icon: "🤖",
      url: "https://aider.chat",
      steps: [
        `Set environment variable:  OLLAMA_API_BASE=${base}`,
        `Then run:  aider --model ollama/YOUR_MODEL`,
      ],
    },
    {
      name: "LM Studio (connect to remote)",
      icon: "◐",
      url: "https://lmstudio.ai",
      steps: [
        `LM Studio → Developer → Remote Address`,
        `Enter: ${base}`,
        `Switch to "Ollama" API mode in connection settings`,
      ],
    },
    {
      name: "Msty",
      icon: "✦",
      url: "https://msty.app",
      steps: [
        `Settings → AI Providers → Add new`,
        `Type: Ollama    URL: ${base}`,
        `Save and refresh model list`,
      ],
    },
  ];
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={[
        "inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider font-mono",
        method === "GET"
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-blue-500/15 text-blue-300",
      ].join(" ")}
    >
      {method}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OllamaCompatPage() {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000");
  const [available, setAvailable] = useState<boolean | null>(null);

  // Detect actual browser host so the instructions use the right URL
  useEffect(() => {
    if (typeof window !== "undefined") {
      const { protocol, hostname } = window.location;
      setBaseUrl(`${protocol}//${hostname}:8000`);
    }
  }, []);

  // Quick health probe: hit /api/version
  const probe = async () => {
    try {
      const r = await fetch("/api/version");
      setAvailable(r.ok);
    } catch {
      setAvailable(false);
    }
  };

  useEffect(() => {
    probe();
  }, []);

  const tools = getTools(baseUrl);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 p-8 transition-[margin] duration-200">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
              🦙 Ollama Compatibility
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Your router exposes an Ollama-compatible REST API. Point any Ollama client at{" "}
              <code className="bg-muted px-1 rounded text-xs font-mono">{baseUrl}</code>{" "}
              and it will use this router for all completions.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Badge
              variant="outline"
              className={
                available === null
                  ? "border-zinc-500/30 text-zinc-400"
                  : available
                  ? "bg-emerald-500/10 border-emerald-400/30 text-emerald-300"
                  : "bg-red-500/10 border-red-400/30 text-red-300"
              }
            >
              {available === null ? "Checking…" : available ? "Active" : "Not reachable"}
            </Badge>
            <Button variant="outline" size="sm" onClick={probe}>
              Test
            </Button>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          {/* ---- Endpoint table ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Exposed Ollama API Endpoints</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/30 text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium w-14">Method</th>
                    <th className="pb-2 pr-6 font-medium w-44">Path</th>
                    <th className="pb-2 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {ENDPOINTS.map((ep) => (
                    <tr key={ep.path} className="border-b border-border/20 last:border-0">
                      <td className="py-2.5 pr-4">
                        <MethodBadge method={ep.method} />
                      </td>
                      <td className="py-2.5 pr-6 font-mono text-xs text-foreground/80">
                        {ep.path}
                      </td>
                      <td className="py-2.5 text-muted-foreground">{ep.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="mt-4 rounded-md border border-amber-400/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300/80">
                <span className="font-semibold text-amber-300">Streaming note:</span>{" "}
                Tokens are collected internally then delivered rapidly as a valid NDJSON stream.
                This keeps all routing/auth logic centralised. True token-by-token streaming
                is planned in a future update.
              </div>
            </CardContent>
          </Card>

          {/* ---- Tool configs ---- */}
          {tools.map((tool) => (
            <Card key={tool.name} className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <span>{tool.icon}</span>
                  {tool.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {tool.steps.map((step, i) => (
                  <div key={i} className="flex gap-3">
                    <span className="mt-0.5 size-5 shrink-0 rounded-full bg-muted/40 text-center text-[11px] font-semibold text-muted-foreground leading-5">
                      {i + 1}
                    </span>
                    {step.startsWith("{") ? (
                      <pre className="text-[11px] font-mono bg-muted/30 rounded px-3 py-2 overflow-x-auto text-foreground/70 flex-1">
                        {step}
                      </pre>
                    ) : (
                      <p className="text-sm text-muted-foreground leading-relaxed">{step}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}

          {/* ---- Quick test ---- */}
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Quick Test with curl</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">List models:</p>
                <pre className="text-xs font-mono bg-muted/30 rounded px-3 py-2 overflow-x-auto text-foreground/70">
                  {`curl ${baseUrl}/api/tags | jq .`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Chat (streaming):</p>
                <pre className="text-xs font-mono bg-muted/30 rounded px-3 py-2 overflow-x-auto text-foreground/70">
                  {`curl ${baseUrl}/api/chat -d '{"model":"YOUR_MODEL","messages":[{"role":"user","content":"Hello"}]}'`}
                </pre>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Non-streaming generate:</p>
                <pre className="text-xs font-mono bg-muted/30 rounded px-3 py-2 overflow-x-auto text-foreground/70">
                  {`curl ${baseUrl}/api/generate -d '{"model":"YOUR_MODEL","prompt":"Why is the sky blue?","stream":false}'`}
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
