"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatError, logError } from "@/lib/errors";
import {
  ensureProfile,
  normalizeOptionalText,
  profileSelect,
  type Profile,
  type ProfileUpdate,
} from "@/lib/profiles";
import { getPlatformRoles, type RoleState } from "@/lib/roles";

const emptyRoles: RoleState = {
  roles: [],
  isPlayer: true,
  isOrganizer: false,
  isAdmin: false,
};

export function ProfileForm() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<RoleState>(emptyRoles);
  const [displayName, setDisplayName] = useState("");
  const [discordUsername, setDiscordUsername] = useState("");
  const [steamProfileUrl, setSteamProfileUrl] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadProfile() {
      const { data } = await supabase.auth.getUser();

      if (!data.user) {
        router.replace("/auth?redirectTo=/profile");
        return;
      }

      try {
        const [loadedProfile, loadedRoles] = await Promise.all([
          ensureProfile(supabase, data.user),
          getPlatformRoles(supabase, data.user.id),
        ]);

        if (!isMounted) {
          return;
        }

        setProfile(loadedProfile);
        setDisplayName(loadedProfile.display_name);
        setDiscordUsername(loadedProfile.discord_username ?? "");
        setSteamProfileUrl(loadedProfile.steam_profile_url ?? "");
        setRoles(loadedRoles);
      } catch (caughtError) {
        if (isMounted) {
          logError("Profile load failed.", caughtError);
          setError(formatError(caughtError, "Unable to load profile."));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadProfile();

    return () => {
      isMounted = false;
    };
  }, [router, supabase]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!profile) {
      return;
    }

    const trimmedDisplayName = displayName.trim();
    const trimmedSteamUrl = normalizeOptionalText(steamProfileUrl);

    if (trimmedDisplayName.length < 2 || trimmedDisplayName.length > 40) {
      setError("Display name must be between 2 and 40 characters.");
      return;
    }

    if (trimmedSteamUrl && !/^https?:\/\//.test(trimmedSteamUrl)) {
      setError("Steam profile URL must start with http:// or https://.");
      return;
    }

    setIsSaving(true);
    setNotice(null);
    setError(null);

    const update: ProfileUpdate = {
      display_name: trimmedDisplayName,
      discord_username: normalizeOptionalText(discordUsername),
      steam_profile_url: trimmedSteamUrl,
      updated_at: new Date().toISOString(),
    };

    const { data, error: updateError } = await supabase
      .from("profiles")
      .update(update)
      .eq("id", profile.id)
      .select(profileSelect)
      .single();

    setIsSaving(false);

    if (updateError) {
      logError("Profile update failed.", updateError);
      setError(formatError(updateError, "Unable to save profile."));
      return;
    }

    setProfile(data);
    setNotice("Profile saved.");
  }

  if (isLoading) {
    return <p className="muted">Loading profile...</p>;
  }

  if (error && !profile) {
    return <p className="error">{error}</p>;
  }

  return (
    <div className="profile-layout">
      <form className="card form-card form-stack" onSubmit={handleSave}>
        <label>
          Display name
          <input
            maxLength={40}
            minLength={2}
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        <label>
          Discord username
          <input
            maxLength={64}
            value={discordUsername}
            onChange={(event) => setDiscordUsername(event.target.value)}
            placeholder="name or name#0000"
          />
        </label>

        <label>
          Steam profile URL
          <input
            maxLength={200}
            type="url"
            value={steamProfileUrl}
            onChange={(event) => setSteamProfileUrl(event.target.value)}
            placeholder="https://steamcommunity.com/id/player"
          />
        </label>

        <button className="button" disabled={isSaving} type="submit">
          {isSaving ? "Saving..." : "Save Profile"}
        </button>

        {notice ? <p className="notice">{notice}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </form>

      <aside className="card">
        <h2>Access</h2>
        <p className="muted">Player access is enabled for every signed-in account.</p>
        <div className="role-list" aria-label="Current access">
          <span className="badge">Player</span>
          {roles.isOrganizer ? <span className="badge">Organizer</span> : null}
          {roles.isAdmin ? <span className="badge">Admin</span> : null}
        </div>
      </aside>
    </div>
  );
}
