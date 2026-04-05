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
  frontendLog,
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

// ---- System prompt profiles persistence ----
const SYSTEM_PROMPT_PROFILES_KEY = "llm-router-system-prompt-profiles";

interface SystemPromptProfile {
  id: string;
  name: string;
  content: string;
}

const BUILTIN_PROFILES: SystemPromptProfile[] = [
  { id: "__default", name: "Default Assistant", content: DEFAULT_SYSTEM_PROMPT },
  { id: "__coder", name: "Coder", content: "You are an expert software engineer. Write clean, efficient code. Explain your reasoning when asked." },
  { id: "__writer", name: "Creative Writer", content: "You are a creative writer. Produce vivid, engaging prose. Adapt your tone to the user's request." },
  { id: "__analyst", name: "Data Analyst", content: "You are a data analyst. Provide precise, evidence-based answers. Use tables and structured output when helpful." },
];

function loadProfiles(): SystemPromptProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SYSTEM_PROMPT_PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveProfiles(profiles: SystemPromptProfile[]) {
  window.localStorage.setItem(SYSTEM_PROMPT_PROFILES_KEY, JSON.stringify(profiles));
}

// ---- Chat session persistence helpers ----
const SESSIONS_STORAGE_KEY = "llm-router-chat-sessions";
const ACTIVE_SESSION_KEY = "llm-router-active-session";

interface ChatSession {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function generateSessionId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSessions(sessions: ChatSession[]) {
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

function loadActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_SESSION_KEY);
}

function saveActiveSessionId(id: string) {
  window.localStorage.setItem(ACTIVE_SESSION_KEY, id);
}

function deriveTitle(msgs: ChatMessage[]): string {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return "New Chat";
  const text = first.content.slice(0, 60);
  return text.length < first.content.length ? text + "…" : text;
}

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
  const [profiles, setProfiles] = useState<SystemPromptProfile[]>([]);
  const [newProfileName, setNewProfileName] = useState("");
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
  const [launchDeckCollapsed, setLaunchDeckCollapsed] = useState(false);
  const [collapsedLaunchGroups, setCollapsedLaunchGroups] = useState<Record<string, boolean>>({});
  const [usageSummary, setUsageSummary] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionListCollapsed, setSessionListCollapsed] = useState(false);
  const skipSaveRef = useRef(false);

  // --- Session bootstrap (runs once) ---
  useEffect(() => {
    setProfiles(loadProfiles());
    const loaded = loadSessions();
    const storedId = loadActiveSessionId();
    if (loaded.length === 0) {
      const id = generateSessionId();
      const fresh: ChatSession = { id, title: "New Chat", model: "", messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      saveSessions([fresh]);
      saveActiveSessionId(id);
      setSessions([fresh]);
      setActiveSessionId(id);
    } else {
      setSessions(loaded);
      const target = loaded.find((s) => s.id === storedId) ?? loaded[0];
      setActiveSessionId(target.id);
      skipSaveRef.current = true;
      setMessages(target.messages);
    }
  }, []);

  // --- Auto-save messages into current session ---
  useEffect(() => {
    if (!activeSessionId) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === activeSessionId
          ? { ...s, messages, model: selectedModel, title: deriveTitle(messages.length > 0 ? messages : s.messages === messages ? s.messages : messages), updatedAt: new Date().toISOString() }
          : s,
      );
      saveSessions(next);
      return next;
    });
  }, [messages, activeSessionId, selectedModel]);

  const switchSession = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    // Abort any in-flight streaming response before switching
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setSending(false);
    }
    setActiveSessionId(id);
    saveActiveSessionId(id);
    skipSaveRef.current = true;
    setMessages(target.messages);
    if (target.model) setSelectedModel(target.model);
    setUsageSummary("");
    setError(null);
  };

  const createNewSession = () => {
    const id = generateSessionId();
    const fresh: ChatSession = { id, title: "New Chat", model: selectedModel, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const next = [fresh, ...sessions];
    saveSessions(next);
    saveActiveSessionId(id);
    setSessions(next);
    setActiveSessionId(id);
    skipSaveRef.current = true;
    setMessages([]);
    setUsageSummary("");
    setError(null);
  };

  const deleteSession = (id: string) => {
    const next = sessions.filter((s) => s.id !== id);
    if (next.length === 0) {
      createNewSession();
      return;
    }
    saveSessions(next);
    setSessions(next);
    if (activeSessionId === id) {
      switchSession(next[0].id);
    }
  };
  const abortRef = useRef<AbortController | null>(null);
  const sendSessionRef = useRef<string | null>(null);

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

  const processPhaseMap = useMemo(
    () => {
      const map: Record<string, string> = {};
      for (const p of runningProcesses) {
        if (p.is_running && p.phase) map[p.identifier] = p.phase;
      }
      return map;
    },
    [runningProcesses],
  );

  const phaseBadgeColor = (phase: string) => {
    switch (phase) {
      case "ready": return "bg-emerald-500/15 text-emerald-300 border-emerald-400/30";
      case "loading vocabulary":
      case "loading model tensors":
      case "loading model metadata":
      case "starting": return "bg-amber-500/15 text-amber-300 border-amber-400/30";
      case "warming up": return "bg-yellow-500/15 text-yellow-300 border-yellow-400/30";
      case "processing prompt": return "bg-cyan-500/15 text-cyan-300 border-cyan-400/30";
      case "generating": return "bg-violet-500/15 text-violet-300 border-violet-400/30";
      default: return "bg-white/10 text-slate-300 border-white/20";
    }
  };

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

  const groupedLaunchPresets = useMemo(() => {
    return groups.reduce<Record<string, ModelGroup[]>>((accumulator, group) => {
      const key = group.group_name || "Default";
      if (!accumulator[key]) accumulator[key] = [];
      accumulator[key].push(group);
      return accumulator;
    }, {});
  }, [groups]);

  const selectedModelMeta = models.find((model) => model.id === selectedModel);
  const canStream = !selectedModel.startsWith("claude-");

  const allProfiles = [...BUILTIN_PROFILES, ...profiles];

  const handleSaveProfile = () => {
    const name = newProfileName.trim();
    if (!name || !systemPrompt.trim()) return;
    const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const next = [...profiles, { id, name, content: systemPrompt }];
    setProfiles(next);
    saveProfiles(next);
    setNewProfileName("");
  };

  const handleDeleteProfile = (id: string) => {
    const next = profiles.filter((p) => p.id !== id);
    setProfiles(next);
    saveProfiles(next);
  };

  const handleLoadProfile = (profile: SystemPromptProfile) => {
    setSystemPrompt(profile.content);
  };

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

    frontendLog("INFO", "inference", `Sending message to model=${selectedModel} stream=${streamReplies} session=${activeSessionId}`);

    const userMessage: ChatMessage = { role: "user", content: draft.trim() };
    const chatMessages = [...messages, userMessage];
    const payloadMessages = systemPrompt.trim()
      ? [{ role: "system", content: systemPrompt.trim() } as ChatMessage, ...chatMessages]
      : chatMessages;

    const currentSessionId = activeSessionId;
    sendSessionRef.current = currentSessionId;

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
            // Guard: only update if still on the same session
            if (sendSessionRef.current === currentSessionId) {
              setAssistantContent(accumulated);
            }
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
        frontendLog("ERROR", "inference", `Chat error model=${selectedModel}: ${message}`);
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
      <main className="ml-[var(--sidebar-width,14rem)] flex h-screen min-w-0 flex-1 flex-col overflow-hidden p-6 transition-[margin] duration-200">
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

        <div className="grid min-h-0 flex-1 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="min-h-0 space-y-6 overflow-y-auto pr-2">
            {/* Chat Sessions */}
            <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">Chat Sessions</CardTitle>
                  <div className="flex gap-1">
                    <Button variant="outline" size="sm" onClick={createNewSession}>New</Button>
                    <Button variant="outline" size="sm" onClick={() => setSessionListCollapsed((prev) => !prev)}>
                      {sessionListCollapsed ? "Show" : "Hide"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {!sessionListCollapsed && (
                <CardContent className="space-y-1">
                  <div className="max-h-[200px] space-y-1 overflow-y-auto pr-1">
                    {sessions.map((session) => {
                      const active = session.id === activeSessionId;
                      return (
                        <div key={session.id} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${active ? "bg-cyan-500/10 border border-cyan-400/40" : "border border-transparent hover:bg-white/5"}`}>
                          <button
                            type="button"
                            onClick={() => switchSession(session.id)}
                            className="flex-1 truncate text-left"
                            title={session.title}
                          >
                            <span className="font-medium">{session.title}</span>
                            <span className="ml-2 text-[10px] text-slate-400">{session.messages.length} msgs</span>
                          </button>
                          {sessions.length > 1 && (
                            <button
                              type="button"
                              onClick={() => deleteSession(session.id)}
                              className="shrink-0 text-xs text-slate-500 hover:text-rose-400"
                              title="Delete session"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              )}
            </Card>
            <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="text-base">Local Launch Deck</CardTitle>
                  <Button variant="outline" size="sm" onClick={() => setLaunchDeckCollapsed((prev) => !prev)}>
                    {launchDeckCollapsed ? "Expand" : "Collapse"}
                  </Button>
                </div>
              </CardHeader>
              {!launchDeckCollapsed && <CardContent className="space-y-3">
                <p className="text-xs text-slate-300">
                  Start a saved local preset here. Once it is running, it becomes selectable in the chat model list.
                </p>
                <div className="space-y-2">
                  {groups.length === 0 ? (
                    <p className="text-sm text-slate-400">No local presets saved yet.</p>
                  ) : (
                    Object.entries(groupedLaunchPresets).map(([groupName, presets]) => {
                      const collapsed = collapsedLaunchGroups[groupName] ?? false;
                      return (
                        <div key={groupName} className="rounded-2xl border border-white/10 bg-black/15 p-3">
                          <button
                            type="button"
                            onClick={() => setCollapsedLaunchGroups((prev) => ({ ...prev, [groupName]: !collapsed }))}
                            className="flex w-full items-center justify-between gap-3 text-left"
                          >
                            <div>
                              <p className="text-sm font-semibold text-white">{groupName}</p>
                              <p className="text-[11px] text-slate-400">{presets.length} preset{presets.length > 1 ? "s" : ""}</p>
                            </div>
                            <Badge className="bg-white/10 text-white">{collapsed ? "Show" : "Hide"}</Badge>
                          </button>
                          {!collapsed && (
                            <div className="mt-3 space-y-2">
                              {presets.map((group) => {
                                const running = runningNames.has(group.name);
                                return (
                                  <div key={group.id} className="rounded-2xl border border-white/10 bg-black/20 p-3">
                                    <div className="flex items-start justify-between gap-2">
                                      <div>
                                        <p className="text-sm font-semibold text-white">{group.name}</p>
                                        <p className="text-[11px] text-slate-400">{group.engine_type}</p>
                                      </div>
                                      <div className="flex flex-col items-end gap-1">
                                        {running && <Badge className="bg-emerald-500/20 text-emerald-300">Running</Badge>}
                                        {running && processPhaseMap[group.name] && (
                                          <Badge className={phaseBadgeColor(processPhaseMap[group.name])}>{processPhaseMap[group.name]}</Badge>
                                        )}
                                      </div>
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
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </CardContent>}
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
                <div className="max-h-[420px] space-y-4 overflow-y-auto pr-1">
                  {filteredModels.length === 0 && <p className="text-sm text-slate-400">No models match this filter.</p>}
                  {(() => {
                    const groups = filteredModels.reduce<Record<string, typeof filteredModels>>((acc, m) => {
                      (acc[m.owned_by] ??= []).push(m);
                      return acc;
                    }, {});
                    return Object.entries(groups).map(([owner, items]) => (
                      <div key={owner}>
                        <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">{owner}</p>
                        <div className="space-y-1.5">
                          {items.map((model) => {
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
                                </div>
                                <p className="mt-1 text-[11px] text-slate-400">
                                  {runningNames.has(model.id)
                                    ? `Local: ${processPhaseMap[model.id] || "running"}`
                                    : "Routed or remote target"}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ));
                  })()}

                </div>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-white/6 text-white backdrop-blur-xl">
              <CardHeader>
                <CardTitle className="text-base">Generation Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-slate-300">System Prompt</Label>
                    <div className="flex flex-wrap gap-1">
                      {allProfiles.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => handleLoadProfile(p)}
                          className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
                            systemPrompt === p.content
                              ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-300"
                              : "border-white/10 bg-black/20 text-slate-400 hover:border-white/20 hover:text-slate-300"
                          }`}
                          title={p.content}
                        >
                          {p.name}
                          {!p.id.startsWith("__") && (
                            <span
                              role="button"
                              className="ml-1 text-slate-500 hover:text-rose-400"
                              onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.id); }}
                            >
                              ✕
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Textarea
                    value={systemPrompt}
                    onChange={(event) => setSystemPrompt(event.target.value)}
                    className="min-h-28 border-white/10 bg-black/20 text-sm text-white"
                  />
                  <div className="flex gap-2">
                    <Input
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      placeholder="Profile name..."
                      className="flex-1 border-white/10 bg-black/20 text-xs text-white placeholder:text-slate-500"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSaveProfile(); } }}
                    />
                    <Button variant="outline" size="sm" onClick={handleSaveProfile} disabled={!newProfileName.trim() || !systemPrompt.trim()}>
                      Save
                    </Button>
                  </div>
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

          <Card className="flex min-h-0 flex-col border-white/10 bg-white/6 text-white backdrop-blur-xl">
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
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-5">
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