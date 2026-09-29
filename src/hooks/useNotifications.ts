"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}

interface UseNotificationsOptions {
  limit?: number;
  unreadOnly?: boolean;
  type?: string;
  /** Interval for the unread-count-only poll, in ms. Pass 0 to disable. */
  pollIntervalMs?: number;
}

interface UseNotificationsResult {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refetch: () => Promise<void>;
}

// There's no websocket/push layer for notifications yet - building one is
// out of scope here. This interval keeps the unread badge roughly fresh in
// the meantime; it's deliberately cheap (unreadOnly, limit 1) since it only
// needs the count, not the list.
const DEFAULT_POLL_INTERVAL_MS = 45_000;

export function useNotifications(options: UseNotificationsOptions = {}): UseNotificationsResult {
  const { limit = 20, unreadOnly = false, type, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = options;

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Latest snapshot for optimistic-update rollback, without pulling
  // `notifications` into markAllRead's dependency array.
  const notificationsRef = useRef<Notification[]>([]);
  notificationsRef.current = notifications;

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (unreadOnly) params.set("unreadOnly", "true");
    if (type) params.set("type", type);
    return params.toString();
  }, [limit, unreadOnly, type]);

  const fetchNotifications = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/notifications?${buildQuery()}`);
      if (!res.ok) throw new Error(`Failed to load notifications (${res.status})`);
      const data = await res.json();
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    } finally {
      setIsLoading(false);
    }
  }, [buildQuery]);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=1&unreadOnly=true");
      if (!res.ok) return;
      const data = await res.json();
      setUnreadCount(data.unreadCount);
    } catch {
      // Silent - a missed poll tick shouldn't surface as a page-level error.
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (!pollIntervalMs) return;
    const interval = setInterval(fetchUnreadCount, pollIntervalMs);
    return () => clearInterval(interval);
  }, [pollIntervalMs, fetchUnreadCount]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      const res = await fetch(`/api/notifications/${id}`, { method: "PATCH" });
      if (!res.ok) throw new Error(`Failed to mark notification read (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark notification read");
      // The optimistic update may now be wrong - resync with the server
      // rather than leave stale local state behind.
      await fetchNotifications();
    }
  }, [fetchNotifications]);

  const markAllRead = useCallback(async () => {
    const previous = notificationsRef.current;
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) throw new Error(`Failed to mark all notifications read (${res.status})`);
    } catch (err) {
      setNotifications(previous);
      setError(err instanceof Error ? err.message : "Failed to mark all notifications read");
      await fetchNotifications();
    }
  }, [fetchNotifications]);

  return { notifications, unreadCount, isLoading, error, markRead, markAllRead, refetch: fetchNotifications };
}
