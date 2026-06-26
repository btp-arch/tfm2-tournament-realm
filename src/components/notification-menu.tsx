"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { formatDateTime } from "@/lib/tournaments";
import { liveRefreshIntervalMs, type NotificationRow } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function NotificationMenu({ user }: { user: User | null }) {
  const [supabase] = useState(() => createClient());
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const loadNotifications = useCallback(async () => {
    if (!user) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    const [notificationsResult, unreadResult] = await Promise.all([
      supabase
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("read_at", null),
    ]);

    if (!notificationsResult.error) {
      setNotifications((notificationsResult.data ?? []) as NotificationRow[]);
    }

    if (!unreadResult.error) {
      setUnreadCount(unreadResult.count ?? 0);
    }
  }, [supabase, user]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadNotifications();
    }, 0);

    const intervalId = window.setInterval(() => {
      void loadNotifications();
    }, liveRefreshIntervalMs);

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
  }, [loadNotifications]);

  async function markAllRead() {
    if (!user) {
      return;
    }

    const { error } = await supabase.rpc("mark_all_notifications_read");
    if (!error) {
      await loadNotifications();
    }
  }

  if (!user) {
    return null;
  }

  return (
    <details className="notification-menu">
      <summary aria-label={`${unreadCount} unread notifications`}>
        <span>Notifications</span>
        {unreadCount > 0 ? <span className="notification-count">{unreadCount}</span> : null}
      </summary>
      <div className="notification-popover">
        <div className="section-heading compact-heading">
          <strong>Notifications</strong>
          <button className="nav-button" type="button" onClick={markAllRead}>
            Mark all read
          </button>
        </div>
        {notifications.length === 0 ? (
          <p className="muted">No notifications yet.</p>
        ) : (
          <div className="notification-list">
            {notifications.map((notification) => (
              <Link
                className={notification.read_at ? "notification-item" : "notification-item unread"}
                href={notification.link_url ?? "/notifications"}
                key={notification.id}
              >
                <strong>{notification.title}</strong>
                <span>{notification.body}</span>
                <span className="muted">{formatDateTime(notification.created_at)}</span>
              </Link>
            ))}
          </div>
        )}
        <Link className="button secondary-button button-link" href="/notifications">
          View All
        </Link>
      </div>
    </details>
  );
}
