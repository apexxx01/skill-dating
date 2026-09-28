"use client";

import { ReactNode, useEffect, useState } from "react";
import { NavMain } from "@/components/navigation/NavMain";
import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  children: ReactNode;
  className?: string;
}

export function DashboardLayout({ children, className }: DashboardLayoutProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className={cn("min-h-screen bg-background", className)}>
      {mounted && <NavMain />}
      <main
        id="main-content"
        className={cn(
          "pt-16 lg:pt-16",
          "min-h-[calc(100vh-4rem)]"
        )}
        tabIndex={-1}
        role="main"
      >
        {children}
      </main>
      <footer className="border-t border-border py-6 px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <p>&copy; 2024 Skill Dating. Built by builders, for builders.</p>
          <div className="flex items-center gap-6">
            <a href="/privacy" className="hover:text-foreground transition-colors">Privacy</a>
            <a href="/terms" className="hover:text-foreground transition-colors">Terms</a>
            <a href="/community" className="hover:text-foreground transition-colors">Community Guidelines</a>
            <a href="https://github.com/skill-dating" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
              Open Source
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}