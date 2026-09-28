"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Search,
  Command as CommandIcon,
  LayoutDashboard,
  Users,
  FolderGit2,
  Trophy,
  Code,
  MessageSquare,
  Bell,
  Settings,
  User,
  Plus,
  Zap,
  BookOpen,
  Globe,
  ExternalLink,
  Keyboard,
  ArrowRight,
  Home,
  FolderOpen,
  UserCheck,
  Mail,
  Lock,
  Key,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";

const appCommands = [
  { href: "/dashboard", label: "Dashboard", description: "Your builder home", icon: LayoutDashboard, keywords: ["home", "overview", "stats"] },
  { href: "/discover", label: "Discover Builders", description: "Find people to build with", icon: Users, keywords: ["people", "search", "find", "builders"] },
  { href: "/discover/projects", label: "Discover Projects", description: "Browse open projects", icon: FolderGit2, keywords: ["projects", "browse", "open source"] },
  { href: "/discover/teams", label: "Discover Teams", description: "Find teams to join", icon: Code, keywords: ["teams", "join", "collaborate"] },
  { href: "/hackathons", label: "Hackathons", description: "Upcoming and active hackathons", icon: Trophy, keywords: ["events", "competitions", "hackathon"] },
  { href: "/projects", label: "My Projects", description: "Your projects and collaborations", icon: FolderOpen, keywords: ["my projects", "owned", "member"] },
  { href: "/teams", label: "My Teams", description: "Teams you belong to", icon: UserCheck, keywords: ["my teams", "membership"] },
  { href: "/messages", label: "Messages", description: "Direct and group conversations", icon: MessageSquare, keywords: ["chat", "dm", "conversations"] },
  { href: "/notifications", label: "Notifications", description: "Your notification center", icon: Bell, keywords: ["alerts", "updates"] },
  { href: "/profile", label: "Profile", description: "View your builder passport", icon: User, keywords: ["passport", "profile", "skills"] },
  { href: "/profile/edit", label: "Settings", description: "Account and profile settings", icon: Settings, keywords: ["preferences", "account", "configuration"] },
];

const actionCommands = [
  { label: "Create New Project", description: "Start a new project", action: () => {}, icon: Plus, keywords: ["new", "create", "project", "start"] },
  { label: "Create New Team", description: "Form a new team", action: () => {}, icon: Users, keywords: ["new", "create", "team", "form"] },
  { label: "Join Hackathon", description: "Register for a hackathon", action: () => {}, icon: Trophy, keywords: ["register", "join", "hackathon", "event"] },
  { label: "Start Conversation", description: "Message a builder", action: () => {}, icon: MessageSquare, keywords: ["message", "chat", "dm", "contact"] },
];

const shortcuts = [
  { keys: ["⌘", "K"], description: "Open Command Palette" },
  { keys: ["⌘", "⇧", "N"], description: "New Project" },
  { keys: ["⌘", "⇧", "T"], description: "New Team" },
  { keys: ["⌘", "⇧", "M"], description: "Messages" },
  { keys: ["⌘", "⇧", "H"], description: "Hackathons" },
  { keys: ["⌘", ",",], description: "Settings" },
  { keys: ["G", "D"], description: "Go to Dashboard" },
  { keys: ["G", "P"], description: "Go to Projects" },
  { keys: ["G", "T"], description: "Go to Teams" },
  { keys: ["?",], description: "Show Shortcuts" },
];

interface CommandPaletteProps {
  onClose: () => void;
  onNavigate?: (href: string) => void;
}

export function CommandPalette({ onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  const filteredCommands = useMemo(() => {
    if (!query) return [];
    const lowerQuery = query.toLowerCase();
    return appCommands
      .filter((cmd) =>
        cmd.label.toLowerCase().includes(lowerQuery) ||
        cmd.description.toLowerCase().includes(lowerQuery) ||
        cmd.keywords.some((k) => k.toLowerCase().includes(lowerQuery))
      )
      .slice(0, 8);
  }, [query]);

  const filteredActions = useMemo(() => {
    if (!query) return [];
    const lowerQuery = query.toLowerCase();
    return actionCommands
      .filter((cmd) =>
        cmd.label.toLowerCase().includes(lowerQuery) ||
        cmd.description.toLowerCase().includes(lowerQuery) ||
        cmd.keywords.some((k) => k.toLowerCase().includes(lowerQuery))
      )
      .slice(0, 4);
  }, [query]);

  const allVisibleItems = useMemo(() => {
    const items: Array<{ type: "command" | "action" | "shortcut"; data: typeof appCommands[0] | typeof actionCommands[0] | typeof shortcuts[0] }> = [];
    if (showShortcuts) {
      shortcuts.forEach((s) => items.push({ type: "shortcut", data: s }));
    } else {
      filteredCommands.forEach((c) => items.push({ type: "command", data: c }));
      filteredActions.forEach((a) => items.push({ type: "action", data: a }));
      if (!query) {
        appCommands.slice(0, 6).forEach((c) => items.push({ type: "command", data: c }));
        if (session) {
          actionCommands.slice(0, 3).forEach((a) => items.push({ type: "action", data: a }));
        }
      }
    }
    return items;
  }, [query, showShortcuts, filteredCommands, filteredActions, session]);

  useEffect(() => {
    inputRef.current?.focus();
    setSelectedIndex(0);
  }, [showShortcuts, query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "k") onClose();
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && (!e.target || (e.target as HTMLElement).tagName !== "INPUT")) {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSelect = useCallback((href: string) => {
    onClose();
    router.push(href);
    onNavigate?.(href);
  }, [onClose, onNavigate, router]);

  const handleAction = useCallback((action: () => void) => {
    onClose();
    action();
  }, [onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = allVisibleItems;
    if (items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[selectedIndex];
      if (item) {
        if (item.type === "command" && "href" in item.data) {
          handleSelect(item.data.href);
        } else if (item.type === "action" && "action" in item.data) {
          handleAction(item.data.action);
        } else if (item.type === "shortcut" && item.data.description === "Show Shortcuts") {
          setShowShortcuts(true);
        }
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [allVisibleItems, selectedIndex, handleSelect, handleAction, onClose]);

  return (
    <CommandDialog open onOpenChange={onClose}>
      <Command className="w-full max-w-2xl">
        <CommandInput
          ref={inputRef}
          placeholder="Search apps, commands, and shortcuts..."
          value={query}
          onValueChange={setQuery}
          aria-label="Command palette search"
          onKeyDown={handleKeyDown}
        />
        <CommandList className="max-h-[500px]" ref={listRef}>
          <AnimatePresence mode="wait">
            <CommandEmpty className="py-8 text-center">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.15 }}
              >
                {query ? (
                  <>
                    <Search className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">No results for "{query}"</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">Try a different search term</p>
                  </>
                ) : (
                  <>
                    <Search className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">Type to search...</p>
                    <p className="text-xs text-muted-foreground/70 mt-1">Press <kbd className="px-1.5 py-0.5 bg-muted rounded">?</kbd> for shortcuts</p>
                  </>
                )}
              </motion.div>
            </CommandEmpty>
          </AnimatePresence>

          {showShortcuts && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              <CommandGroup>
                <CommandSeparator />
                <CommandItem className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Keyboard Shortcuts
                </CommandItem>
                {shortcuts.map((shortcut, index) => (
                  <motion.div
                    key={shortcut.description}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.02, duration: 0.15 }}
                  >
                    <CommandItem className="px-3 py-2.5 gap-3">
                      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        {shortcut.keys.map((key, i) => (
                          <kbd
                            key={i}
                            className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono font-medium bg-muted rounded text-muted-foreground"
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                      <span className="text-sm text-foreground">{shortcut.description}</span>
                    </CommandItem>
                  </motion.div>
                ))}
              </CommandGroup>
            </motion.div>
          )}

          {!showShortcuts && filteredCommands.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              <CommandGroup>
                <CommandSeparator />
                <CommandItem className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Navigation
                </CommandItem>
                {filteredCommands.map((cmd, index) => {
                  const Icon = cmd.icon;
                  const isActive = pathname === cmd.href || (cmd.href !== "/dashboard" && pathname.startsWith(cmd.href));
                  return (
                    <motion.div
                      key={cmd.href}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.02, duration: 0.15 }}
                    >
                      <CommandItem
                        onSelect={() => handleSelect(cmd.href)}
                        className={cn(
                          "relative",
                          isActive && "bg-primary/10"
                        )}
                      >
                        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{cmd.label}</span>
                            {isActive && (
                              <span className="text-xs text-primary font-medium px-1.5 py-0.5 rounded bg-primary/10">
                                Current
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{cmd.description}</p>
                        </div>
                        <CommandShortcut className="text-xs text-muted-foreground">
                          {isMac ? "⌘" : "Ctrl"} + Click
                        </CommandShortcut>
                      </CommandItem>
                    </motion.div>
                  );
                })}
              </CommandGroup>
            </motion.div>
          )}

          {!showShortcuts && filteredActions.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              <CommandGroup>
                <CommandSeparator />
                <CommandItem className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </CommandItem>
                {filteredActions.map((cmd, index) => {
                  const Icon = cmd.icon;
                  return (
                    <motion.div
                      key={cmd.label}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.02, duration: 0.15 }}
                    >
                      <CommandItem
                        onSelect={() => handleAction(cmd.action)}
                        className="relative"
                      >
                        <Icon className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
                        <div className="flex-1 min-w-0">
                          <span className="font-medium truncate">{cmd.label}</span>
                          <p className="text-xs text-muted-foreground truncate">{cmd.description}</p>
                        </div>
                        <span className="text-xs text-primary font-medium">Action</span>
                      </CommandItem>
                    </motion.div>
                  );
                })}
              </CommandGroup>
            </motion.div>
          )}

          {!query && !showShortcuts && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              <CommandGroup>
                <CommandSeparator />
                <CommandItem className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Quick Access
                </CommandItem>
                {appCommands.slice(0, 6).map((cmd, index) => {
                  const Icon = cmd.icon;
                  const isActive = pathname === cmd.href || (cmd.href !== "/dashboard" && pathname.startsWith(cmd.href));
                  return (
                    <motion.div
                      key={cmd.href}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.02, duration: 0.15 }}
                    >
                      <CommandItem
                        onSelect={() => handleSelect(cmd.href)}
                        className={cn("relative", isActive && "bg-primary/10")}
                      >
                        <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{cmd.label}</span>
                            {isActive && (
                              <span className="text-xs text-primary font-medium px-1.5 py-0.5 rounded bg-primary/10">
                                Current
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{cmd.description}</p>
                        </div>
                      </CommandItem>
                    </motion.div>
                  );
                })}
              </CommandGroup>
            </motion.div>
          )}

          {!query && !showShortcuts && session && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              <CommandGroup>
                <CommandSeparator />
                <CommandItem className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Quick Actions
                </CommandItem>
                {actionCommands.slice(0, 3).map((cmd, index) => {
                  const Icon = cmd.icon;
                  return (
                    <motion.div
                      key={cmd.label}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.02, duration: 0.15 }}
                    >
                      <CommandItem
                        onSelect={() => handleAction(cmd.action)}
                        className="relative"
                      >
                        <Icon className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
                        <div className="flex-1 min-w-0">
                          <span className="font-medium truncate">{cmd.label}</span>
                          <p className="text-xs text-muted-foreground truncate">{cmd.description}</p>
                        </div>
                        <span className="text-xs text-primary font-medium">Action</span>
                      </CommandItem>
                    </motion.div>
                  );
                })}
              </CommandGroup>
            </motion.div>
          )}

          {!query && !showShortcuts && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
            >
              <CommandGroup>
                <CommandSeparator />
                <CommandItem
                  className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2 cursor-pointer"
                  onSelect={() => setShowShortcuts(true)}
                >
                  <Keyboard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span>Show All Shortcuts</span>
                  <kbd className="ml-auto px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/50 bg-muted rounded">
                    ?
                  </kbd>
                </CommandItem>
              </CommandGroup>
            </motion.div>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}