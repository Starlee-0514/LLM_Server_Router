"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Sidebar from "@/components/sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listTerminalSessions,
  createTerminalSession,
  deleteTerminalSession,
  TerminalSession,
} from "@/lib/api";

function getWsBase(): string {
  if (typeof window === "undefined") return "ws://localhost:8000";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.hostname}:8000`;
}

export default function TerminalPage() {
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [newSessionName, setNewSessionName] = useState("");
  const [loading, setLoading] = useState(false);

  // Fetch session list
  const refreshSessions = useCallback(async () => {
    try {
      const data = await listTerminalSessions();
      setSessions(data.sessions);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 5000);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  // Disconnect current session
  const disconnect = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termInstanceRef.current) {
      termInstanceRef.current.dispose();
      termInstanceRef.current = null;
    }
    setConnected(false);
    setActiveSession(null);
    // Refresh after short delay so backend marks session as detached
    setTimeout(refreshSessions, 500);
  }, [refreshSessions]);

  // Connect to a session
  const connectToSession = useCallback(async (sessionName: string) => {
    // Disconnect existing first
    disconnect();

    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { WebLinksAddon } = await import("@xterm/addon-web-links");
    await import("@xterm/xterm/css/xterm.css");

    if (!termRef.current) return;
    termRef.current.innerHTML = "";

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: "#0a0a0a",
        foreground: "#e4e4e7",
        cursor: "#f97316",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(termRef.current);
    setTimeout(() => fitAddon.fit(), 10);

    termInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket with session name
    const wsUrl = `${getWsBase()}/api/terminal/ws?session=${encodeURIComponent(sessionName)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setActiveSession(sessionName);
      setError(null);
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send("\x01" + JSON.stringify({ type: "resize", rows: dims.rows, cols: dims.cols }));
      }
      refreshSessions();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setActiveSession(null);
      term.write("\r\n\x1b[33m[Disconnected — session preserved]\x1b[0m\r\n");
      setTimeout(refreshSessions, 500);
    };

    ws.onerror = () => {
      setError("WebSocket connection failed. Is the backend running?");
      setConnected(false);
    };

    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const onResize = () => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send("\x01" + JSON.stringify({ type: "resize", rows: dims.rows, cols: dims.cols }));
      }
    };

    window.addEventListener("resize", onResize);
    const resizeObserver = new ResizeObserver(() => onResize());
    if (termRef.current) resizeObserver.observe(termRef.current);

    term.focus();

    cleanupRef.current = () => {
      window.removeEventListener("resize", onResize);
      resizeObserver.disconnect();
    };
  }, [disconnect, refreshSessions]);

  // Create new session
  const handleCreateSession = async () => {
    const name = newSessionName.trim();
    if (!name) return;
    setLoading(true);
    try {
      const result = await createTerminalSession(name);
      if (result.error) {
        setError(result.error);
      } else {
        setNewSessionName("");
        await refreshSessions();
        // Auto-connect to new session
        await connectToSession(name);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Delete session
  const handleDeleteSession = async (name: string) => {
    try {
      const result = await deleteTerminalSession(name);
      if (result.error) {
        setError(result.error);
      } else {
        if (activeSession === name) disconnect();
        await refreshSessions();
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current();
      if (wsRef.current) wsRef.current.close();
      if (termInstanceRef.current) termInstanceRef.current.dispose();
    };
  }, []);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="ml-[var(--sidebar-width,14rem)] flex-1 flex flex-col p-4 transition-[margin] duration-200">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Terminal</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {connected && activeSession
                ? `Connected to "${activeSession}"`
                : "Select or create a session"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-green-500 shadow-lg shadow-green-500/30" : "bg-zinc-600"}`} />
            {connected && (
              <Button variant="outline" size="sm" onClick={disconnect}>
                Disconnect
              </Button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 text-destructive/60 hover:text-destructive">✕</button>
          </div>
        )}

        <div className="flex gap-3 flex-1 min-h-0">
          {/* Session sidebar */}
          <div className="w-56 flex-shrink-0 flex flex-col gap-2">
            <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
              <CardContent className="p-3 space-y-2">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Sessions</h3>
                <div className="flex gap-1">
                  <Input
                    placeholder="New session name"
                    value={newSessionName}
                    onChange={(e) => setNewSessionName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateSession()}
                    className="h-8 text-xs"
                  />
                  <Button
                    size="sm"
                    className="h-8 px-2 text-xs"
                    onClick={handleCreateSession}
                    disabled={loading || !newSessionName.trim()}
                  >
                    +
                  </Button>
                </div>

                <div className="space-y-1 max-h-[60vh] overflow-y-auto">
                  {sessions.length === 0 && (
                    <p className="text-xs text-muted-foreground py-2 text-center">No sessions</p>
                  )}
                  {sessions.map((s) => (
                    <div
                      key={s.name}
                      className={`group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs cursor-pointer transition-colors ${
                        activeSession === s.name
                          ? "bg-primary/15 text-primary border border-primary/30"
                          : "hover:bg-muted/50"
                      }`}
                      onClick={() => {
                        if (activeSession !== s.name) connectToSession(s.name);
                      }}
                    >
                      <div className={`h-2 w-2 rounded-full flex-shrink-0 ${
                        activeSession === s.name ? "bg-green-500" : s.attached ? "bg-yellow-500" : "bg-zinc-500"
                      }`} />
                      <span className="truncate flex-1 font-medium">{s.name}</span>
                      <button
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-0.5"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteSession(s.name);
                        }}
                        title="Kill session"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                      </button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Terminal */}
          <Card className="flex-1 border-border/40 bg-card/60 backdrop-blur-sm overflow-hidden">
            <CardContent className="p-0 h-full">
              <div
                ref={termRef}
                className="h-full min-h-[500px] w-full"
                style={{ background: "#0a0a0a" }}
              />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
