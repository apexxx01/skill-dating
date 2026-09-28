"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  LayoutDashboard,
  Users,
  FolderGit2,
  Trophy,
  MessageSquare,
  Bell,
  Search,
  Menu,
  X,
  User,
  Settings,
  LogOut,
  Zap,
  Code,
  ChevronDown,
  Command,
} from "lucide-react";
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
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "@/components/command-palette/CommandPalette";
import { NotificationsPanel } from "@/components/notifications/NotificationsPanel";
import { MobileNavigation } from "@/components/navigation/MobileNavigation";

const navigationItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, description: "Your builder home" },
  { href: "/discover", label: "Discover", icon: Users, description: "Find builders, projects, teams" },
  { href: "/projects", label: "Projects", icon: FolderGit2, description: "Your projects and collaborations" },
  { href: "/teams", label: "Teams", icon: Code, description: "Team spaces and applications" },
  { href: "/hackathons", label: "Hackathons", icon: Trophy, description: "Upcoming and active hackathons" },
  { href: "/messages", label: "Messages", icon: MessageSquare, description: "Direct and group conversations" },
];

export function NavMain() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const [activeIndicator, setActiveIndicator] = useState<{ x: number; width: number } | null>(null);

  useEffect(() => {
    setMounted(true);
    const handleScroll = () => setIsScrolled(window.scrollY > 8);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsCommandOpen(true);
      }
      if (e.key === "Escape") {
        setIsCommandOpen(false);
        setIsNotificationsOpen(false);
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const updateActiveIndicator = useCallback((item: HTMLElement | null) => {
    if (item) {
      const rect = item.getBoundingClientRect();
      const navRect = navRef.current?.getBoundingClientRect();
      if (navRect) {
        setActiveIndicator({
          x: rect.left - navRect.left + (navRef.current?.scrollLeft || 0),
          width: rect.width,
        });
      }
    } else {
      setActiveIndicator(null);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const activeItem = navRef.current?.querySelector('[data-active="true"]') as HTMLElement;
    updateActiveIndicator(activeItem);
  }, [pathname, mounted, updateActiveIndicator]);

  if (!mounted) {
    return (
      <nav
        className="fixed top-0 left-0 right-0 z-50 h-16 bg-background/80 backdrop-blur-xl border-b border-border/50"
        aria-label="Main navigation"
      />
    );
  }

  return (
    <TooltipProvider>
      <nav
        ref={navRef}
        className={cn(
          "fixed top-0 left-0 right-0 z-50 h-16 transition-all duration-200",
          "bg-background/80 backdrop-blur-xl border-b border-border/50",
          isScrolled && "shadow-sm bg-background/95"
        )}
        aria-label="Main navigation"
        role="navigation"
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 h-full">
          <div className="flex h-full items-center justify-between gap-4">
            <div className="flex items-center gap-6 lg:gap-8">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 font-display font-bold text-heading-lg text-foreground hover:opacity-80 transition-opacity"
                aria-label="Skill Dating - Home"
              >
                <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Zap className="h-5 w-5" aria-hidden="true" />
                  <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-success-500 text-[10px] font-bold text-white">
                    1
                  </span>
                </span>
                <span className="hidden sm:block">Skill Dating</span>
              </Link>

              <div className="hidden md:flex items-center gap-1 bg-muted/50 rounded-lg p-1" role="menubar" aria-label="Main navigation">
                {navigationItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
                  return (
                    <Tooltip key={item.href}>
                      <TooltipTrigger asChild>
                        <Link
                          ref={(el) => {
                            if (isActive && el) updateActiveIndicator(el);
                          }}
                          href={item.href}
                          className={cn(
                            "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200",
                            "relative overflow-hidden",
                            isActive
                              ? "bg-primary text-primary-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground hover:bg-accent"
                          )}
                          role="menuitem"
                          aria-current={isActive ? "page" : undefined}
                          aria-label={item.label}
                          data-active={isActive ? "true" : "false"}
                        >
                          <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                          <span className="hidden sm:inline">{item.label}</span>
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" align="center" className="gap-1 p-2">
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
                {activeIndicator && (
                  <motion.div
                    className="absolute bottom-1 left-0 h-0.5 bg-primary/60 rounded-full pointer-events-none -z-10"
                    style={{ transform: `translateX(${activeIndicator.x}px)`, width: activeIndicator.width }}
                    initial={false}
                    animate={{ x: 0 }}
                    transition={{ type: "spring", stiffness: 400, damping: 40 }}
                  />
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-lg"
                    onClick={() => setIsCommandOpen(true)}
                    aria-label="Open command palette (⌘K)"
                    aria-haspopup="dialog"
                  >
                    <Search className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">Search</span>
                    <kbd className="hidden lg:inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/50 bg-muted rounded">
                      <Command className="h-3 w-3" aria-hidden="true" />
                      <span>K</span>
                    </kbd>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">
                  <span>Open command palette</span>
                  <kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded">⌘K</kbd>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-lg relative"
                    onClick={() => setIsNotificationsOpen(true)}
                    aria-label="Notifications"
                    aria-haspopup="dialog"
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    <span className="absolute top-1.5 right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-white">
                      3
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">
                  <span>Notifications</span>
                </TooltipContent>
              </Tooltip>

              <div className="hidden sm:block w-px h-6 bg-border mx-1" aria-hidden="true" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-lg"
                    onClick={() => setIsMobileMenuOpen(true)}
                    aria-label="Open menu"
                    aria-haspopup="dialog"
                  >
                    <Menu className="h-5 w-5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">Menu</TooltipContent>
              </Tooltip>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-lg pr-3"
                    aria-label="User menu"
                    aria-haspopup="menu"
                    aria-expanded={false}
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarImage
                        src={session?.user?.image || ""}
                        alt={session?.user?.name || "User avatar"}
                      />
                      <AvatarFallback className="text-xs font-medium">
                        {session?.user?.name?.charAt(0).toUpperCase() || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <ChevronDown className="h-4 w-4 ml-1 text-muted-foreground" aria-hidden="true" />
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
                    <Link href="/profile" className="flex w-full items-center gap-2">
                      <User className="h-4 w-4" aria-hidden="true" />
                      <span>Profile</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/profile/edit" className="flex w-full items-center gap-2">
                      <Settings className="h-4 w-4" aria-hidden="true" />
                      <span>Settings</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard" className="flex w-full items-center gap-2">
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
          </div>
        </div>
      </nav>

      <AnimatePresence mode="wait">
        {isCommandOpen && (
          <CommandPalette
            onClose={() => setIsCommandOpen(false)}
            onNavigate={(href) => {
              setIsCommandOpen(false);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {isNotificationsOpen && (
          <NotificationsPanel
            onClose={() => setIsNotificationsOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {isMobileMenuOpen && (
          <MobileNavigation
            onClose={() => setIsMobileMenuOpen(false)}
            navigationItems={navigationItems}
            currentPath={pathname}
          />
        )}
      </AnimatePresence>
    </TooltipProvider>
  );
}