"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bell, X, Check, Clock, MessageSquare, Users, FolderGit2, Trophy, Code, GitBranch, ExternalLink, UserCheck, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
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
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

const mockNotifications: Notification[] = [
  {
    id: "1",
    type: "NEW_MESSAGE",
    title: "New message from Sarah Chen",
    message: "Hey! I saw your project on Skill Dating and would love to collaborate...",
    link: "/messages/1",
    isRead: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    id: "2",
    type: "TEAM_INVITATION",
    title: "Team invitation from Alex Rivera",
    message: "You've been invited to join 'AI Research Collective' as a Founding Engineer",
    link: "/teams/1",
    metadata: { teamName: "AI Research Collective", role: "FOUNDING_ENGINEER" },
    isRead: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    id: "3",
    type: "HACKATHON_REMINDER",
    title: "HackMIT 2024 starts in 2 days!",
    message: "Registration closes tomorrow. Don't forget to form your team.",
    link: "/hackathons/hackmit-2024",
    isRead: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  },
  {
    id: "4",
    type: "PROJECT_UPDATE",
    title: "New update on 'NeuralSearch'",
    message: "Marcus Chen posted: 'Just shipped the vector search integration!'",
    link: "/projects/neural-search",
    isRead: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  },
  {
    id: "5",
    type: "ACHIEVEMENT",
    title: "Achievement unlocked: 'First Ship'",
    message: "You've shipped your first project! +500 XP",
    link: "/profile/achievements",
    metadata: { achievementId: "first-ship", xp: 500 },
    isRead: true,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
  {
    id: "6",
    type: "APPLICATION_RESPONSE",
    title: "Application accepted!",
    message: "Your application to 'Web3 Builders Guild' has been accepted.",
    link: "/teams/web3-builders-guild",
    isRead: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
  },
];

const notificationIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  NEW_MESSAGE: MessageSquare,
  TEAM_INVITATION: Users,
  JOIN_REQUEST: UserCheck,
  HACKATHON_REMINDER: Trophy,
  PROJECT_UPDATE: FolderGit2,
  ACHIEVEMENT: Code,
  CHALLENGE_COMPLETION: Trophy,
  CONNECTION: GitBranch,
  MENTION: MessageSquare,
  APPLICATION_RESPONSE: Check,
  SYSTEM: Bell,
};

interface NotificationsPanelProps {
  onClose: () => void;
}

export function NotificationsPanel({ onClose }: NotificationsPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>(mockNotifications);
  const [unreadCount, setUnreadCount] = useState(3);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [isLoading, setIsLoading] = useState(false);
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

  const filteredNotifications = notifications.filter((n) =>
    filter === "unread" ? !n.isRead : true
  );

  const handleMarkRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, isRead: true } : n
      )
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const handleMarkAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
  }, []);

  const handleClick = useCallback((notification: Notification) => {
    if (!notification.isRead) {
      handleMarkRead(notification.id);
    }
    if (notification.link) {
      onClose();
      window.location.href = notification.link;
    }
  }, [handleMarkRead, onClose]);

  const getIcon = (type: string) => {
    const Icon = notificationIcons[type] || Bell;
    return Icon;
  };

  const getIconColor = (type: string) => {
    switch (type) {
      case "NEW_MESSAGE":
      case "MENTION":
        return "bg-primary text-white";
      case "TEAM_INVITATION":
      case "JOIN_REQUEST":
      case "APPLICATION_RESPONSE":
        return "bg-builder-500 text-white";
      case "HACKATHON_REMINDER":
        return "bg-warning-500 text-white";
      case "PROJECT_UPDATE":
        return "bg-success-500 text-white";
      case "ACHIEVEMENT":
      case "CHALLENGE_COMPLETION":
        return "bg-warning-500 text-white";
      case "CONNECTION":
        return "bg-purple-500 text-white";
      default:
        return "bg-muted-foreground text-white";
    }
  };

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
      aria-label="Notifications"
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
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <div>
              <h2 className="font-semibold text-heading-sm">Notifications</h2>
              {unreadCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {unreadCount} unread
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs"
                    onClick={handleMarkAllRead}
                    aria-label="Mark all as read"
                  >
                    <Check className="h-3 w-3 mr-1" aria-hidden="true" />
                    Mark all read
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">Mark all as read</TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg"
              onClick={onClose}
              aria-label="Close notifications"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex border-b border-border px-4 sticky top-16 bg-background/95 backdrop-blur-sm z-10" role="tablist" aria-label="Notification filters">
          <button
            role="tab"
            aria-selected={filter === "all"}
            className={cn(
              "flex-1 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              filter === "all"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            role="tab"
            aria-selected={filter === "unread"}
            className={cn(
              "flex-1 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              filter === "unread"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => setFilter("unread")}
          >
            Unread {unreadCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground rounded-full">
                {unreadCount}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto" role="list" aria-label="Notifications">
          <AnimatePresence mode="wait">
            {filteredNotifications.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col items-center justify-center h-full px-6 py-12"
              >
                <EmptyState
                  icon={<Bell className="h-8 w-8" aria-hidden="true" />}
                  title={filter === "unread" ? "No unread notifications" : "No notifications yet"}
                  description={filter === "unread"
                    ? "You're all caught up!"
                    : "When you get notifications, they'll appear here."}
                  action={{
                    label: filter === "unread" ? "View all" : "Explore",
                    onClick: () => { onClose(); window.location.href = "/notifications"; },
                  }}
                />
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="divide-y divide-border/50"
              >
                {filteredNotifications.map((notification, index) => {
                  const Icon = getIcon(notification.type);
                  return (
                    <motion.div
                      key={notification.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10, height: 0 }}
                      transition={{ delay: index * 0.03, duration: 0.15 }}
                      className={cn(
                        "relative p-4 hover:bg-accent/50 transition-colors",
                        !notification.isRead && "bg-accent/30"
                      )}
                      role="listitem"
                      onClick={() => handleClick(notification)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleClick(notification);
                        }
                      }}
                    >
                      <div className="flex gap-3">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                            getIconColor(notification.type)
                          )}
                        >
                          <Icon className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("font-medium text-sm", !notification.isRead && "font-semibold")}>
                              {notification.title}
                            </p>
                            {!notification.isRead && (
                              <span
                                className="flex h-2 w-2 shrink-0 rounded-full bg-primary"
                                aria-label="Unread"
                              />
                            )}
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                            {notification.message}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground/70">
                            {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="border-t border-border p-4 sticky bottom-0 bg-background/95 backdrop-blur-sm">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => { onClose(); window.location.href = "/notifications"; }}
          >
            View all notifications
            <ExternalLink className="ml-2 h-3 w-3" aria-hidden="true" />
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}