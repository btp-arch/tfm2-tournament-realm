"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import {
  liveRefreshIntervalMs,
  loadActiveAction,
  type ActiveAction,
} from "@/lib/notifications";

export function ActiveActionBanner() {
  const [supabase] = useState(() => createClient());
  const [action, setAction] = useState<ActiveAction | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [isLoaded, setIsLoaded] = useState(false);

  const loadAction = useCallback(async () => {
    const { data } = await supabase.auth.getUser();

    if (!data.user) {
      setAction(null);
      setRoles(emptyRoleState);
      setIsLoaded(true);
      return;
    }

    try {
      const loadedRoles = await getCurrentUserRoles(supabase);
      const loadedAction = await loadActiveAction(supabase, data.user.id, loadedRoles);
      setRoles(loadedRoles);
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

  if (!isLoaded || !action) {
    return null;
  }

  return (
    <aside className="active-action-banner">
      <div>
        <strong>{action.title}</strong>
        <p>{action.body}</p>
      </div>
      <div className="active-action-links">
        <Link className="button button-link" href={action.href}>
          Open
        </Link>
        <Link className="button secondary-button button-link" href="/notifications">
          Notifications
        </Link>
        {roles.isOrganizer ? (
          <Link className="button secondary-button button-link" href="/organizer">
            Organizer
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
