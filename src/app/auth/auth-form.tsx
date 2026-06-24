"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatError, logError } from "@/lib/errors";
import { ensureProfile } from "@/lib/profiles";

type AuthMode = "sign-in" | "sign-up";

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") || "/profile";
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [supabase] = useState(() => createClient());

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (isMounted && data.user) {
        router.replace(redirectTo);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [redirectTo, router, supabase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    setIsSubmitting(true);

    try {
      const result =
        mode === "sign-in"
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({
              email,
              password,
              options: {
                data: {
                  display_name: displayName.trim(),
                },
              },
            });

      if (result.error) {
        setError(result.error.message);
        return;
      }

      if (result.data.user && result.data.session) {
        await ensureProfile(supabase, result.data.user);
        router.replace(redirectTo);
        router.refresh();
        return;
      }

      setStatus("Check your email to confirm your account, then sign in.");
    } catch (caughtError) {
      logError("Authentication failed.", caughtError);
      setError(formatError(caughtError, "Authentication failed."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="card form-card">
      <div className="segmented-control" aria-label="Authentication mode">
        <button
          className={mode === "sign-in" ? "active" : ""}
          type="button"
          onClick={() => setMode("sign-in")}
        >
          Sign In
        </button>
        <button
          className={mode === "sign-up" ? "active" : ""}
          type="button"
          onClick={() => setMode("sign-up")}
        >
          Sign Up
        </button>
      </div>

      <form className="form-stack" onSubmit={handleSubmit}>
        {mode === "sign-up" ? (
          <label>
            Display name
            <input
              minLength={2}
              maxLength={40}
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Tournament name"
            />
          </label>
        ) : null}

        <label>
          Email
          <input
            autoComplete="email"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="player@example.com"
          />
        </label>

        <label>
          Password
          <input
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={6}
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting ? "Working..." : mode === "sign-in" ? "Sign In" : "Create Account"}
        </button>
      </form>

      {status ? <p className="notice">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
