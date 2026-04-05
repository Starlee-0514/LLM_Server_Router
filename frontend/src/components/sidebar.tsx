"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export const sidebarNavItems = [
  { href: "/", label: "Dashboard", icon: "◈" },
  { href: "/models", label: "Models", icon: "⬡" },
  { href: "/inference", label: "Inference", icon: "✦" },
  { href: "/benchmarks", label: "Benchmarks", icon: "◉" },
  { href: "/providers", label: "Providers", icon: "⟠" },
  { href: "/routes", label: "Routes", icon: "⇄" },
  { href: "/mapping", label: "Mapping", icon: "⏎" },
  { href: "/mesh", label: "Mesh", icon: "⛓" },
  { href: "/lmstudio", label: "LM Studio", icon: "◐" },
  { href: "/reports", label: "Reports", icon: "⚑" },
  { href: "/dev", label: "Dev", icon: "⌘" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

const SIDEBAR_WIDTH_EXPANDED = "14rem";
const SIDEBAR_WIDTH_COLLAPSED = "4.75rem";
const SIDEBAR_STORAGE_KEY = "llm-router-sidebar-collapsed";

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    const nextCollapsed = stored === "1";
    setCollapsed(nextCollapsed);
    document.documentElement.style.setProperty("--sidebar-width", nextCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 flex flex-col overflow-y-auto border-r border-border/40 bg-card/50 backdrop-blur-xl transition-[width] duration-200"
      style={{ width: "var(--sidebar-width, 14rem)" }}
    >
      {/* Logo */}
      <div className={cn("relative flex shrink-0 items-center", collapsed ? "justify-center px-2 py-5" : "justify-between gap-2 px-5 py-6")}>
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-red-500 to-orange-500 text-sm font-bold text-white shadow-lg shadow-red-500/20">
            R
          </div>
          {!collapsed && (
            <div>
              <h1 className="text-sm font-semibold tracking-tight">LLM Router</h1>
              <p className="text-[10px] text-muted-foreground">AMD Strix Point</p>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((prev) => !prev)}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground",
            collapsed && "absolute right-2 top-5",
          )}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 py-2">
        {sidebarNavItems.map((item) => {
          const isActive =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                collapsed ? "justify-center gap-0 px-2" : "gap-3",
                isActive
                  ? "bg-primary/10 text-primary shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              title={collapsed ? item.label : undefined}
            >
              <span className="text-base">{item.icon}</span>
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="mt-auto border-t border-border/40 px-5 py-4">
          <p className="text-[10px] text-muted-foreground">v0.1.0 · OpenAI Compatible</p>
        </div>
      )}
    </aside>
  );
}
