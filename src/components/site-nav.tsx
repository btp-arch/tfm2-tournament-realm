"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

const links = [
  ["Home", "/"],
  ["Tournaments", "/tournaments"],
  ["Create", "/tournaments/create"],
  ["Organizer", "/organizer"],
  ["Admin", "/admin"],
  ["Rules", "/rules"],
  ["About", "/about"],
];

export function SiteNav() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (isMounted) {
        setUser(data.user);
        setIsLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
    router.push("/");
    router.refresh();
  }

  return (
    <nav className="nav" aria-label="Primary navigation">
      {links.map(([label, href]) => (
        <Link key={href} href={href}>{label}</Link>
      ))}
      <span className="nav-spacer" />
      {!isLoading && user ? (
        <>
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
