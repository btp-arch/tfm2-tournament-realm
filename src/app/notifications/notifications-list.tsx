"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { formatError, logError } from "@/lib/errors";
import { formatDateTime } from "@/lib/tournaments";
import { liveRefreshIntervalMs, type NotificationRow } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/client";

export function NotificationsList() {
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadNotifications = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getUser();
      setUser(data.user);

      if (!data.user) {
        setNotifications([]);
        return;
      }

      const { data: rows, error: notificationsError } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", data.user.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (notificationsError) {
        throw notificationsError;
      }

      setNotifications((rows ?? []) as NotificationRow[]);
    } catch (caughtError) {
      logError("Notifications load failed.", caughtError);
      setError(formatError(caughtError, "Unable to load notifications."));
    } finally {
      setIsLoading(false);
    }
  }, [supabase]);

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

  async function markRead(notificationId: string) {
    const { error: updateError } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId);

    if (updateError) {
      setError(formatError(updateError, "Unable to update notification."));
      return;
    }

    await loadNotifications();
  }

  async function markAllRead() {
    const { error: updateError } = await supabase.rpc("mark_all_notifications_read");

    if (updateError) {
      setError(formatError(updateError, "Unable to update notifications."));
      return;
    }

    await loadNotifications();
  }

  if (isLoading) {
    return <p className="muted">Loading notifications...</p>;
  }

  if (!user) {
    return (
      <section className="card">
        <h1>Notifications</h1>
        <p className="muted">Sign in to view notifications.</p>
        <Link className="button button-link" href="/auth?redirectTo=/notifications">
          Sign In
        </Link>
      </section>
    );
  }

  return (
    <>
      <div className="section-heading">
        <div>
          <h1>Notifications</h1>
          <p className="muted">Recent tournament and match updates for your account.</p>
        </div>
        <button className="button secondary-button" type="button" onClick={markAllRead}>
          Mark All Read
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <section className="card">
        {notifications.length === 0 ? (
          <p className="muted">No notifications yet.</p>
        ) : (
          <div className="notification-list full-list">
            {notifications.map((notification) => (
              <article
                className={notification.read_at ? "notification-row" : "notification-row unread"}
                key={notification.id}
              >
                <div>
                  <h2>{notification.title}</h2>
                  <p>{notification.body}</p>
                  <p className="muted">{formatDateTime(notification.created_at)}</p>
                </div>
                <div className="match-action-grid">
                  <Link
                    className="button secondary-button button-link"
                    href={notification.link_url ?? "/notifications"}
                  >
                    Open
                  </Link>
                  {!notification.read_at ? (
                    <button
                      className="button"
                      type="button"
                      onClick={() => markRead(notification.id)}
                    >
                      Mark Read
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
