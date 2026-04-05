"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: "◈" },
  { href: "/models", label: "Models", icon: "⬡" },
  { href: "/inference", label: "Inference", icon: "✦" },
  { href: "/benchmarks", label: "Benchmarks", icon: "◉" },
  { href: "/providers", label: "Providers", icon: "⟠" },
  { href: "/routes", label: "Routes", icon: "⇄" },
  { href: "/mesh", label: "Mesh", icon: "⛓" },
  { href: "/reports", label: "Reports", icon: "⚑" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-border/40 bg-card/50 backdrop-blur-xl">
      {/* Logo */}
      <div className="flex items-center gap-2 px-5 py-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-red-500 to-orange-500 text-sm font-bold text-white shadow-lg shadow-red-500/20">
          R
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">LLM Router</h1>
          <p className="text-[10px] text-muted-foreground">AMD Strix Point</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 py-2">
        {navItems.map((item) => {
          const isActive =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-primary/10 text-primary shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border/40 px-5 py-4">
        <p className="text-[10px] text-muted-foreground">v0.1.0 · OpenAI Compatible</p>
      </div>
    </aside>
  );
}
