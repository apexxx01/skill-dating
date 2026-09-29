"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Bell, X, Check, Filter, BellOff, MessageSquare, Users, Trophy, FolderGit2, Award, GitBranch, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";
import { useNotifications, type Notification } from "@/hooks/useNotifications";

const notificationIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  NEW_MESSAGE: MessageSquare,
  TEAM_INVITATION: Users,
  JOIN_REQUEST: CheckCircle,
  HACKATHON_REMINDER: Trophy,
  PROJECT_UPDATE: FolderGit2,
  ACHIEVEMENT: Award,
  CHALLENGE_COMPLETION: Trophy,
  CONNECTION: GitBranch,
  MENTION: MessageSquare,
  APPLICATION_RESPONSE: CheckCircle,
  SYSTEM: Bell,
};

const getIcon = (type: string) => notificationIcons[type] || Bell;
const getIconColor = (type: string) => {
  switch (type) {
    case "NEW_MESSAGE": case "MENTION": return "text-primary";
    case "TEAM_INVITATION": case "JOIN_REQUEST": case "APPLICATION_RESPONSE": return "text-builder-500";
    case "HACKATHON_REMINDER": return "text-warning-500";
    case "PROJECT_UPDATE": return "text-success-500";
    case "ACHIEVEMENT": case "CHALLENGE_COMPLETION": return "text-yellow-500";
    case "CONNECTION": return "text-purple-500";
    default: return "text-muted-foreground";
  }
};

export default function NotificationsPage() {
  const { notifications, unreadCount, isLoading, error, markRead, markAllRead } = useNotifications();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [showSettings, setShowSettings] = useState(false);

  const filteredNotifications = notifications.filter(n => filter === "unread" ? !n.isRead : true);

  const handleMarkRead = (id: string) => {
    markRead(id);
  };

  const handleMarkAllRead = () => {
    markAllRead();
  };

  const handleClick = (notification: Notification) => {
    if (!notification.isRead) handleMarkRead(notification.id);
    if (notification.link) window.location.href = notification.link;
  };

  return (
    <div className="container-padding section-spacing">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-display-md font-bold tracking-tight flex items-center gap-3">
            <Bell className="h-7 w-7 text-primary" aria-hidden="true" />
            Notifications
            {unreadCount > 0 && <Badge variant="secondary" className="bg-primary text-primary-foreground">{unreadCount}</Badge>}
          </h1>
          <p className="text-muted-foreground mt-1">Stay up to date with your builder activity</p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => setShowSettings(!showSettings)}>
                <Filter className="h-4 w-4 mr-2" aria-hidden="true" />
                Preferences
              </Button>
            </TooltipTrigger>
            <TooltipContent>Notification preferences</TooltipContent>
          </Tooltip>
          {unreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
                  <Check className="h-4 w-4 mr-2" aria-hidden="true" />
                  Mark all read
                </Button>
              </TooltipTrigger>
              <TooltipContent>Mark all as read</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {showSettings && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Bell className="h-5 w-5" aria-hidden="true" />Notification Preferences</CardTitle>
            <CardDescription>Choose which notifications you want to receive</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { id: "messages", label: "New Messages", description: "Direct messages and mentions" },
              { id: "teams", label: "Team Activity", description: "Invitations, applications, and updates" },
              { id: "hackathons", label: "Hackathons", description: "Reminders, registration, and results" },
              { id: "projects", label: "Project Updates", description: "New updates, milestones, and ships" },
              { id: "achievements", label: "Achievements", description: "Badges, XP rewards, and milestones" },
              { id: "connections", label: "Connections", description: "New connections and endorsements" },
              { id: "system", label: "System", description: "Important announcements and updates" },
            ].map((pref) => (
              <div key={pref.id} className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{pref.label}</p>
                  <p className="text-sm text-muted-foreground">{pref.description}</p>
                </div>
                <DropdownMenuCheckboxItem checked={true} onCheckedChange={() => {}}>{pref.label}</DropdownMenuCheckboxItem>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex border-b border-border mb-4">
        <button
          className={cn("flex-1 py-2 text-sm font-medium border-b-2 -mb-px transition-colors", filter === "all" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        <button
          className={cn("flex-1 py-2 text-sm font-medium border-b-2 -mb-px transition-colors", filter === "unread" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          onClick={() => setFilter("unread")}
        >
          Unread {unreadCount > 0 && <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-medium bg-primary text-primary-foreground rounded-full">{unreadCount}</span>}
        </button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading && filteredNotifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <Bell className="h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
              <h3 className="text-lg font-semibold mb-2">Loading notifications…</h3>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <Bell className="h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
              <h3 className="text-lg font-semibold mb-2">Couldn't load notifications</h3>
              <p className="text-muted-foreground mb-4">{error}</p>
            </div>
          ) : filteredNotifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
              <Bell className="h-12 w-12 text-muted-foreground/50 mb-4" aria-hidden="true" />
              <h3 className="text-lg font-semibold mb-2">{filter === "unread" ? "No unread notifications" : "No notifications yet"}</h3>
              <p className="text-muted-foreground mb-4">{filter === "unread" ? "You're all caught up! 🎉" : "When you get notifications, they'll appear here."}</p>
            </div>
          ) : (
            <ScrollArea className="max-h-[70vh]">
              <div className="divide-y divide-border/50" role="list" aria-label="Notifications">
                {filteredNotifications.map((notification, index) => {
                  const Icon = getIcon(notification.type);
                  return (
                    <motion.div
                      key={notification.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.03 }}
                      className={cn("p-4 hover:bg-accent/50 transition-colors", !notification.isRead && "bg-accent/30")}
                      role="listitem"
                      onClick={() => handleClick(notification)}
                      tabIndex={0}
                      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(notification); } }}
                    >
                      <div className="flex gap-3">
                        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", getIconColor(notification.type))}>
                          <Icon className="h-5 w-5 text-white" aria-hidden="true" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <p className={cn("font-medium text-sm", !notification.isRead && "font-semibold")}>{notification.title}</p>
                            {!notification.isRead && <span className="flex h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{notification.message}</p>
                          <p className="mt-2 text-xs text-muted-foreground/70">{formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}</p>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}