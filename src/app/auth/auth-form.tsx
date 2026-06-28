"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { logError } from "@/lib/errors";
import {
  getPasswordRequirementStatus,
  mapAuthErrorMessage,
  passwordsMatch,
  validatePassword,
} from "@/lib/password-validation";
import { ensureProfile } from "@/lib/profiles";

type AuthMode = "sign-in" | "sign-up" | "forgot-password";

export function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirectTo") || "/profile";
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [supabase] = useState(() => createClient());
  const passwordRequirementStatus = getPasswordRequirementStatus(password);
  const hasConfirmPassword = confirmPassword.length > 0;
  const doPasswordsMatch = passwordsMatch(password, confirmPassword);

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (isMounted && data.user && mode !== "forgot-password") {
        router.replace(redirectTo);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [mode, redirectTo, router, supabase]);

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setStatus(null);
    setError(null);
    setPasswordError(null);
    setConfirmPasswordError(null);
    setPassword("");
    setConfirmPassword("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    setPasswordError(null);
    setConfirmPasswordError(null);
    setIsSubmitting(true);

    try {
      if (mode === "forgot-password") {
        const passwordResetRedirectTo = `${window.location.origin}/auth/update-password`;
        const result = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: passwordResetRedirectTo,
        });

        if (result.error) {
          setError(mapAuthErrorMessage(result.error, "Unable to send a reset email right now."));
          return;
        }

        setStatus("If an account uses that email, a reset link will be sent shortly.");
        return;
      }

      if (mode === "sign-up") {
        const passwordValidation = validatePassword(password);
        const passwordMatches = passwordsMatch(password, confirmPassword);

        if (!passwordValidation.isValid || !passwordMatches) {
          if (!passwordValidation.isValid) {
            setPasswordError("Password must meet all requirements.");
          }

          if (!confirmPassword) {
            setConfirmPasswordError("Confirm your password.");
          } else if (!passwordMatches) {
            setConfirmPasswordError("Passwords do not match.");
          }

          return;
        }
      }

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
        setError(mapAuthErrorMessage(result.error));
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
      setError(mapAuthErrorMessage(caughtError));
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
          onClick={() => changeMode("sign-in")}
        >
          Sign In
        </button>
        <button
          className={mode === "sign-up" ? "active" : ""}
          type="button"
          onClick={() => changeMode("sign-up")}
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

        {mode === "forgot-password" ? (
          <p className="muted">
            Enter your account email and we will send a reset link if the account exists.
          </p>
        ) : (
          <label>
            Password
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              minLength={mode === "sign-up" ? 8 : undefined}
              required
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError(null);
                setConfirmPasswordError(null);
              }}
            />
          </label>
        )}

        {mode === "sign-up" ? (
          <>
            <ul className="password-requirements" aria-label="Password requirements">
              {passwordRequirementStatus.map((requirement) => (
                <li
                  className={requirement.isMet ? "met" : ""}
                  key={requirement.key}
                >
                  {requirement.label}
                </li>
              ))}
            </ul>
            {passwordError ? <p className="field-error">{passwordError}</p> : null}

            <label>
              Confirm Password
              <input
                autoComplete="new-password"
                minLength={8}
                required
                type="password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setConfirmPasswordError(null);
                }}
              />
            </label>
            {confirmPasswordError ? (
              <p className="field-error">{confirmPasswordError}</p>
            ) : hasConfirmPassword ? (
              <p className={doPasswordsMatch ? "field-success" : "field-error"}>
                {doPasswordsMatch ? "Passwords match" : "Passwords do not match."}
              </p>
            ) : null}
          </>
        ) : null}

        <button className="button" disabled={isSubmitting} type="submit">
          {isSubmitting
            ? "Working..."
            : mode === "sign-in"
              ? "Sign In"
              : mode === "sign-up"
                ? "Create Account"
                : "Send Reset Link"}
        </button>
      </form>

      {mode === "sign-in" ? (
        <button
          className="text-button"
          type="button"
          onClick={() => changeMode("forgot-password")}
        >
          Forgot password?
        </button>
      ) : null}

      {mode === "forgot-password" ? (
        <button
          className="text-button"
          type="button"
          onClick={() => changeMode("sign-in")}
        >
          Back to sign in
        </button>
      ) : null}

      {status ? <p className="notice" aria-live="polite">{status}</p> : null}
      {error ? <p className="error" aria-live="polite">{error}</p> : null}
    </div>
  );
}
