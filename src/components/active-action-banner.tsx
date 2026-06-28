"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getCurrentUserRoles } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  liveRefreshIntervalMs,
  loadActiveAction,
  type ActiveAction,
} from "@/lib/notifications";
import { getCountdownLabel } from "@/lib/tournament-timing";

export function ActiveActionBanner() {
  const [supabase] = useState(() => createClient());
  const [action, setAction] = useState<ActiveAction | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const loadAction = useCallback(async () => {
    const { data } = await supabase.auth.getUser();

    if (!data.user) {
      setAction(null);
      setIsLoaded(true);
      return;
    }

    try {
      const loadedRoles = await getCurrentUserRoles(supabase);
      const loadedAction = await loadActiveAction(supabase, data.user.id, loadedRoles);
      setAction(loadedAction);
    } catch {
      setAction(null);
    } finally {
      setIsLoaded(true);
    }
  }, [supabase]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadAction();
    }, 0);

    const intervalId = window.setInterval(() => {
      void loadAction();
    }, liveRefreshIntervalMs);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void loadAction();
    });

    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      subscription.unsubscribe();
    };
  }, [loadAction, supabase]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  if (!isLoaded || !action) {
    return null;
  }

  return (
    <aside className="active-action-banner">
      <div>
        <strong>{action.title}</strong>
        <p>{action.body}</p>
        {action.deadlineAt ? (
          <p className="active-action-timer">
            {action.timerLabel ?? "Deadline"}: {getCountdownLabel(new Date(action.deadlineAt), false, now)}
          </p>
        ) : null}
      </div>
      <div className="active-action-links">
        <Link className="button button-link" href={action.href}>
          Open
        </Link>
        <Link className="button secondary-button button-link" href="/notifications">
          Notifications
        </Link>
      </div>
    </aside>
  );
}
