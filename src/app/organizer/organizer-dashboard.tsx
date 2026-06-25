"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { AccessDenied } from "@/components/access-denied";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile, type Profile } from "@/lib/profiles";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";

export function OrganizerDashboard() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadDashboard() {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.replace("/auth?redirectTo=/organizer");
        return;
      }

      try {
        const [loadedProfile, loadedRoles] = await Promise.all([
          ensureProfile(supabase, data.user),
          getCurrentUserRoles(supabase),
        ]);

        if (!isMounted) {
          return;
        }

        setUser(data.user);
        setProfile(loadedProfile);
        setRoles(loadedRoles);
      } catch (caughtError) {
        if (isMounted) {
          logError("Organizer dashboard load failed.", caughtError);
          setError(formatError(caughtError, "Unable to load organizer access."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadDashboard();

    return () => {
      isMounted = false;
    };
  }, [router, supabase]);

  if (isLoading) {
    return <p className="muted">Loading organizer dashboard...</p>;
  }

  if (error) {
    return <p className="error">{error}</p>;
  }

  if (!user || !profile || !roles.isOrganizer) {
    return (
      <AccessDenied message="Organizer tools are available only to accounts with organizer or admin access." />
    );
  }

  return (
    <>
      <h1>Organizer Dashboard</h1>
      <p className="muted">Signed in as {profile.display_name}.</p>

      <section className="grid">
        <div className="card">
          <h2>Organizer Status</h2>
          <div className="role-list" aria-label="Current access">
            <span className="badge">Player</span>
            <span className="badge">Organizer</span>
            {roles.isAdmin ? <span className="badge">Admin</span> : null}
          </div>
        </div>

        <div className="card">
          <h2>Milestone 3</h2>
          <p>Tournament creation coming in Milestone 3.</p>
        </div>
      </section>

      <section className="card">
        <h2>Planned Organizer Tools</h2>
        <p className="muted">
          Organizer tools will cover free-entry tournament setup, registration review, brackets,
          scheduling notes, and community moderation workflows. Match rooms, automated result
          verification, Discord bot features, and monetization are outside this milestone.
        </p>
      </section>
    </>
  );
}
