"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { LoadingState, PageHeader } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { ProfileForm } from "./profile-form";
import { ProfileRecordsPanel } from "./profile-records-panel";

type ProfileTab = "account" | "stats" | "history";

const profileTabs: { id: ProfileTab; label: string }[] = [
  { id: "account", label: "Account Info" },
  { id: "stats", label: "Stats" },
  { id: "history", label: "History" },
];

export function ProfileDashboard() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<ProfileTab>("account");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadUser() {
      const { data } = await supabase.auth.getUser();

      if (!isMounted) {
        return;
      }

      if (!data.user) {
        router.replace("/auth?redirectTo=/profile");
        return;
      }

      setUser(data.user);
      setIsLoading(false);
    }

    loadUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) {
        return;
      }

      if (!session?.user) {
        setUser(null);
        router.replace("/auth?redirectTo=/profile");
        return;
      }

      setUser(session.user);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [router, supabase]);

  if (isLoading) {
    return <LoadingState message="Loading profile..." />;
  }

  if (!user) {
    return null;
  }

  return (
    <>
      <PageHeader title="Profile" />

      <nav aria-label="Profile sections" className="tournament-tabs" role="tablist">
        {profileTabs.map((tab) => (
          <button
            aria-controls={`profile-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "active" : undefined}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="tournament-tab-panel" id={`profile-tab-${activeTab}`} role="tabpanel">
        {activeTab === "account" ? <ProfileForm /> : null}
        {activeTab === "stats" ? <ProfileRecordsPanel playerId={user.id} section="stats" /> : null}
        {activeTab === "history" ? <ProfileRecordsPanel playerId={user.id} section="history" /> : null}
      </div>
    </>
  );
}
