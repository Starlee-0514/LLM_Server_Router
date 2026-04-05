"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  createChatCompletion,
  getAllProcessStatus,
  getModelGroups,
  launchModelGroup,
  listInferenceModels,
  streamChatCompletion,
  type ChatMessage,
  type ModelGroup,
  type OpenAIModelItem,
  type ProcessStatus,
} from "@/lib/api";

const DEFAULT_SYSTEM_PROMPT = "You are a precise local-model assistant. Keep answers direct and useful.";

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : "Unknown error";

const ownerTone = (owner: string) => {
  if (owner.startsWith("local")) return "bg-emerald-500/15 text-emerald-300 border-emerald-400/30";
  if (owner.startsWith("mesh")) return "bg-cyan-500/15 text-cyan-300 border-cyan-400/30";
  if (owner.startsWith("provider-route")) return "bg-amber-500/15 text-amber-300 border-amber-400/30";
  return "bg-violet-500/15 text-violet-300 border-violet-400/30";
};

export default function InferencePage() {
  const [models, setModels] = useState<OpenAIModelItem[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<ProcessStatus[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.95);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [streamReplies, setStreamReplies] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<number | null>(null);
  const [usageSummary, setUsageSummary] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [modelData, groupData, processData] = await Promise.all([
        listInferenceModels(),
        getModelGroups(),
        getAllProcessStatus(),
      ]);
      setModels(modelData.data);
      setGroups(groupData);
      setRunningProcesses(processData.processes);

      if (!selectedModel) {
        const localModel = modelData.data.find((item) => item.owned_by === "local");
        setSelectedModel((current) => current || localModel?.id || modelData.data[0]?.id || "");
      }
      setError(null);
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [selectedModel]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 8000);
    return () => {
      window.clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [refresh]);

  const runningNames = useMemo(
    () => new Set(runningProcesses.filter((process) => process.is_running).map((process) => process.identifier)),
    [runningProcesses],
  );

  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase();
    return [...models]
      .filter((model) => {
        if (!query) return true;
        return model.id.toLowerCase().includes(query) || model.owned_by.toLowerCase().includes(query);
      })
      .sort((left, right) => {
        const leftLocal = left.owned_by === "local" ? 0 : 1;
        const rightLocal = right.owned_by === "local" ? 0 : 1;
        if (leftLocal !== rightLocal) return leftLocal - rightLocal;
        return left.id.localeCompare(right.id);
      });
  }, [modelFilter, models]);

  const selectedModelMeta = models.find((model) => model.id === selectedModel);
  const canStream = !selectedModel.startsWith("claude-");

  const setAssistantContent = (content: string) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { role: "assistant", content };
      return next;
    });
  };

  const handleLaunch = async (group: ModelGroup) => {
    setLaunchingId(group.id);
    try {
      await launchModelGroup(group.id);
      await refresh();
      setSelectedModel(group.name);
      setError(null);
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setLaunchingId(null);
    }
  };

  const handleSend = async () => {
    if (!selectedModel || !draft.trim() || sending) return;

    const userMessage: ChatMessage = { role: "user", content: draft.trim() };
    const chatMessages = [...messages, userMessage];
    const payloadMessages = systemPrompt.trim()
      ? [{ role: "system", content: systemPrompt.trim() } as ChatMessage, ...chatMessages]
      : chatMessages;

    setDraft("");
    setMessages([...chatMessages, { role: "assistant", content: "" }]);
    setUsageSummary("");
    setSending(true);
    setError(streamReplies && !canStream ? "Anthropic routes currently use non-streaming fallback in this view." : null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (streamReplies && canStream) {
        const result = await streamChatCompletion(
          {
            model: selectedModel,
            messages: payloadMessages,
            temperature,
            max_tokens: maxTokens,
            top_p: topP,
          },
          (_delta, accumulated) => {
            setAssistantContent(accumulated);
          },
          controller.signal,
        );

        if (result.usage) {
          setUsageSummary(
            `prompt ${result.usage.prompt_tokens ?? 0} · completion ${result.usage.completion_tokens ?? 0} · total ${result.usage.total_tokens ?? 0}`,
          );
        }
      } else {
        const result = await createChatCompletion(
          {
            model: selectedModel,
            messages: payloadMessages,
            temperature,
            max_tokens: maxTokens,
            top_p: topP,
          },
          controller.signal,
        );

        const content = result.choices[0]?.message?.content ?? "";
        setAssistantContent(content);
        if (result.usage) {
          setUsageSummary(
            `prompt ${result.usage.prompt_tokens ?? 0} · completion ${result.usage.completion_tokens ?? 0} · total ${result.usage.total_tokens ?? 0}`,
          );
        }
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      if (message !== "The user aborted a request." && message !== "signal is aborted without reason") {
        setError(message);
        setMessages((prev) => {
          const next = [...prev];
          if (next[next.length - 1]?.role === "assistant" && !next[next.length - 1]?.content) {
            next.pop();
          }
          return next;
        });
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  const handleAbort = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  };

  return (
    <div className="flex min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_30%),radial-gradient(circle_at_80%_0%,rgba(56,189,248,0.14),transparent_32%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(3,7,18,1))]">
      <Sidebar />
      <main className="ml-56 flex-1 p-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white">Inference Studio</h1>
            <p className="mt-1 text-sm text-slate-300">
              Launch local presets, switch between routed models, and chat in one surface.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-white/10 text-white">{models.length} models</Badge>
            <Badge className="bg-emerald-500/15 text-emerald-300">{runningNames.size} local running</Badge>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="space-y-6">
            <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
              <CardHeader>
                <CardTitle className="text-base">Local Launch Deck</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-slate-300">
                  Start a saved local preset here. Once it is running, it becomes selectable in the chat model list.
                </p>
                <div className="space-y-2">
                  {groups.length === 0 ? (
                    <p className="text-sm text-slate-400">No local presets saved yet.</p>
                  ) : (
                    groups.map((group) => {
                      const running = runningNames.has(group.name);
                      return (
                        <div key={group.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-semibold text-white">{group.name}</p>
                              <p className="text-[11px] text-slate-400">{group.group_name} · {group.engine_type}</p>
                            </div>
                            {running && <Badge className="bg-emerald-500/20 text-emerald-300">Running</Badge>}
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              size="sm"
                              className="flex-1 bg-gradient-to-r from-emerald-500 to-cyan-500 text-white"
                              onClick={() => handleLaunch(group)}
                              disabled={launchingId === group.id}
                            >
                              {running ? "Relaunch" : launchingId === group.id ? "Launching..." : "Launch"}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setSelectedModel(group.name)}>
                              Use
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
              <CardHeader>
                <CardTitle className="text-base">Model Catalog</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                  placeholder="Filter by model or owner"
                  className="border-white/10 bg-black/20 text-white placeholder:text-slate-500"
                />
                <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                  {filteredModels.map((model) => {
                    const active = model.id === selectedModel;
                    return (
                      <button
                        key={`${model.owned_by}-${model.id}`}
                        type="button"
                        onClick={() => setSelectedModel(model.id)}
                        className={`w-full rounded-2xl border p-3 text-left transition ${active ? "border-cyan-400/60 bg-cyan-500/10 shadow-[0_14px_32px_-24px_rgba(34,211,238,0.9)]" : "border-white/10 bg-black/20 hover:border-cyan-400/30 hover:bg-white/8"}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-semibold text-white">{model.id}</p>
                          <Badge className={ownerTone(model.owned_by)}>{model.owned_by}</Badge>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-400">
                          {runningNames.has(model.id) ? "Hot local process" : "Routed or remote target"}
                        </p>
                      </button>
                    );
                  })}
                  {filteredModels.length === 0 && <p className="text-sm text-slate-400">No models match this filter.</p>}
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
              <CardHeader>
                <CardTitle className="text-base">Generation Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <Label className="text-xs text-slate-300">System Prompt</Label>
                  <Textarea
                    value={systemPrompt}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    className="min-h-28 border-white/10 bg-black/20 text-sm text-white"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-2">
                    <Label className="text-xs text-slate-300">Temperature</Label>
                    <Input type="number" step="0.1" min="0" max="2" value={temperature} onChange={(event) => setTemperature(Number(event.target.value) || 0)} className="border-white/10 bg-black/20 text-white" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs text-slate-300">Top P</Label>
                    <Input type="number" step="0.05" min="0" max="1" value={topP} onChange={(event) => setTopP(Number(event.target.value) || 0)} className="border-white/10 bg-black/20 text-white" />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs text-slate-300">Max Tokens</Label>
                    <Input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(Math.max(1, Number(event.target.value) || 1))} className="border-white/10 bg-black/20 text-white" />
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-white">Stream replies</p>
                    <p className="text-[11px] text-slate-400">Anthropic-routed models currently fall back to non-streaming here.</p>
                  </div>
                  <Switch checked={streamReplies} onCheckedChange={setStreamReplies} />
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
            <CardHeader className="border-b border-white/10">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-xl">Conversation</CardTitle>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge className="bg-white/10 text-white">{selectedModel || "No model selected"}</Badge>
                    {selectedModelMeta && <Badge className={ownerTone(selectedModelMeta.owned_by)}>{selectedModelMeta.owned_by}</Badge>}
                    {!canStream && <Badge className="bg-amber-500/15 text-amber-300">non-stream fallback</Badge>}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setMessages([])} disabled={messages.length === 0 || sending}>Clear</Button>
                  {sending ? (
                    <Button size="sm" variant="destructive" onClick={handleAbort}>Stop</Button>
                  ) : (
                    <Button size="sm" onClick={handleSend} disabled={!selectedModel || !draft.trim()}>Send</Button>
                  )}
                </div>
              </div>
              {usageSummary && <p className="text-xs text-slate-400">{usageSummary}</p>}
            </CardHeader>
            <CardContent className="flex h-[calc(100vh-180px)] flex-col gap-4 p-5">
              <div className="flex-1 space-y-4 overflow-y-auto pr-1">
                {messages.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-white/10 bg-black/10 p-8 text-center">
                    <div>
                      <p className="text-lg font-semibold text-white">Start with a loaded local preset or any routed model.</p>
                      <p className="mt-2 text-sm text-slate-400">
                        Use Ctrl+Enter to send. The selected model is {selectedModel || "waiting to be chosen"}.
                      </p>
                    </div>
                  </div>
                ) : (
                  messages.map((message, index) => (
                    <div
                      key={`${message.role}-${index}`}
                      className={`max-w-[88%] rounded-[24px] border px-4 py-3 ${message.role === "user" ? "ml-auto border-cyan-400/30 bg-cyan-500/10" : "border-white/10 bg-black/20"}`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{message.role}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-6 text-white">{message.content || (sending && index === messages.length - 1 ? "Thinking..." : "")}</p>
                    </div>
                  ))
                )}
              </div>

              <div className="rounded-[28px] border border-white/10 bg-black/20 p-4">
                <Label className="mb-2 block text-xs text-slate-300">Prompt</Label>
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="Ask for a summary, compare two routes, or test a local preset..."
                  className="min-h-28 border-white/10 bg-transparent text-sm text-white placeholder:text-slate-500"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">Ctrl+Enter sends immediately.</p>
                  <Button onClick={handleSend} disabled={!selectedModel || !draft.trim() || sending}>
                    {sending ? "Generating..." : "Send Prompt"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}