"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { X, LayoutDashboard, Users, FolderGit2, Trophy, Code, MessageSquare, Bell, Settings, User, LogOut, Zap, UserCheck } from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

interface MobileNavigationProps {
  onClose: () => void;
  navigationItems: Array<{
    href: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    description: string;
  }>;
  currentPath: string;
}

export function MobileNavigation({ onClose, navigationItems, currentPath }: MobileNavigationProps) {
  const { data: session } = useSession();
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousActiveElement.current = document.activeElement as HTMLElement;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const focusableElements = drawerRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusableElements && focusableElements.length > 0) {
          const firstElement = focusableElements[0];
          const lastElement = focusableElements[focusableElements.length - 1];

          if (e.shiftKey && document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          } else if (!e.shiftKey && document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    const firstFocusable = drawerRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();

    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
      previousActiveElement.current?.focus();
    };
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-50 lg:hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Mobile navigation"
    >
      <motion.div
        ref={drawerRef}
        className="absolute right-0 top-0 h-full w-full max-w-sm bg-background border-l border-border shadow-2xl flex flex-col"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-16 items-center justify-between px-4 border-b border-border sticky top-0 bg-background/95 backdrop-blur-sm z-10">
          <span className="font-display font-bold text-heading-md">Menu</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto px-4 py-6 space-y-1 pb-24" aria-label="Main navigation">
          {navigationItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = currentPath === item.href || (item.href !== "/dashboard" && currentPath.startsWith(item.href));
            return (
              <motion.div
                key={item.href}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.03, duration: 0.2 }}
              >
                <Link
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-3 text-base font-medium transition-all duration-200",
                    "relative overflow-hidden",
                    isActive
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                  {isActive && (
                    <motion.span
                      layoutId="mobile-nav-indicator"
                      className="absolute inset-0 bg-primary/20 -z-10"
                      transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    />
                  )}
                </Link>
              </motion.div>
            );
          })}
        </nav>

        <div className="border-t border-border p-4 space-y-3 sticky bottom-0 bg-background/95 backdrop-blur-sm">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full justify-start gap-3" aria-label="User menu">
                <Avatar className="h-9 w-9">
                  <AvatarImage
                    src={session?.user?.image || ""}
                    alt={session?.user?.name || "User avatar"}
                  />
                  <AvatarFallback className="text-sm font-medium">
                    {session?.user?.name?.charAt(0).toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 text-left truncate">
                  <p className="font-medium truncate">{session?.user?.name || "User"}</p>
                  <p className="text-xs text-muted-foreground truncate">{session?.user?.email}</p>
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 min-w-[220px]">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col items-start">
                  <p className="text-sm font-medium truncate w-full">{session?.user?.name || "User"}</p>
                  <p className="text-xs text-muted-foreground truncate w-full">{session?.user?.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/profile" onClick={onClose} className="flex w-full items-center gap-2">
                  <User className="h-4 w-4" aria-hidden="true" />
                  <span>Profile</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/profile/edit" onClick={onClose} className="flex w-full items-center gap-2">
                  <Settings className="h-4 w-4" aria-hidden="true" />
                  <span>Settings</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/dashboard" onClick={onClose} className="flex w-full items-center gap-2">
                  <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                  <span>Dashboard</span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => signOut({ callbackUrl: "/" })}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>Sign out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </motion.div>
    </motion.div>
  );
}