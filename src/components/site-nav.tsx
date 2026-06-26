"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { emptyRoleState, getCurrentUserRoles, type RoleState } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";
import { NotificationMenu } from "@/components/notification-menu";

const links = [
  ["Home", "/"],
  ["Tournaments", "/tournaments"],
  ["Rules", "/rules"],
  ["About", "/about"],
];

export function SiteNav() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoleState);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadSession() {
      const { data } = await supabase.auth.getUser();

      if (!isMounted) {
        return;
      }

      setUser(data.user);

      if (data.user) {
        try {
          const loadedRoles = await getCurrentUserRoles(supabase);
          if (isMounted) {
            setRoles(loadedRoles);
          }
        } catch {
          if (isMounted) {
            setRoles(emptyRoleState);
          }
        }
      } else {
        setRoles(emptyRoleState);
      }

      if (isMounted) {
        setIsLoading(false);
      }
    }

    loadSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setRoles(emptyRoleState);
      setIsLoading(false);

      if (session?.user) {
        getCurrentUserRoles(supabase)
          .then((loadedRoles) => {
            if (isMounted) {
              setRoles(loadedRoles);
            }
          })
          .catch(() => {
            if (isMounted) {
              setRoles(emptyRoleState);
            }
          });
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
    setRoles(emptyRoleState);
    router.push("/");
    router.refresh();
  }

  return (
    <nav className="nav" aria-label="Primary navigation">
      {links.map(([label, href]) => (
        <Link key={href} href={href}>{label}</Link>
      ))}
      {!isLoading && roles.isOrganizer ? <Link href="/organizer">Organizer</Link> : null}
      {!isLoading && roles.isAdmin ? <Link href="/admin">Admin</Link> : null}
      <span className="nav-spacer" />
      {!isLoading && user ? (
        <>
          <NotificationMenu user={user} />
          <Link href="/profile">Profile</Link>
          <button className="nav-button" type="button" onClick={handleSignOut}>
            Sign Out
          </button>
        </>
      ) : null}
      {!isLoading && !user ? <Link href="/auth">Sign In</Link> : null}
    </nav>
  );
}
