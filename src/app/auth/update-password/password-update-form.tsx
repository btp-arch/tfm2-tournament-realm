"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { logError } from "@/lib/errors";
import {
  getPasswordRequirementStatus,
  mapAuthErrorMessage,
  passwordsMatch,
  validatePassword,
} from "@/lib/password-validation";
import { createClient } from "@/lib/supabase/client";

export function PasswordUpdateForm() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const passwordRequirementStatus = getPasswordRequirementStatus(password);
  const hasConfirmPassword = confirmPassword.length > 0;
  const doPasswordsMatch = passwordsMatch(password, confirmPassword);

  useEffect(() => {
    let isMounted = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isMounted) {
        return;
      }

      if (event === "PASSWORD_RECOVERY" || session?.user) {
        setHasSession(true);
        setError(null);
      }
    });

    supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!isMounted) {
          return;
        }

        if (sessionError) {
          setError(mapAuthErrorMessage(sessionError, "Unable to read the password reset session."));
          setHasSession(false);
          return;
        }

        setHasSession(Boolean(data.session));
        if (!data.session) {
          setError("Open this page from your password reset email, or request a new reset link.");
        }
      })
      .catch((caughtError) => {
        if (!isMounted) {
          return;
        }

        logError("Password reset session check failed.", caughtError);
        setError(mapAuthErrorMessage(caughtError, "Unable to read the password reset session."));
        setHasSession(false);
      })
      .finally(() => {
        if (isMounted) {
          setIsCheckingSession(false);
        }
      });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus(null);
    setError(null);
    setPasswordError(null);
    setConfirmPasswordError(null);

    const passwordValidation = validatePassword(password);
    const passwordMatches = passwordsMatch(password, confirmPassword);

    if (!passwordValidation.isValid || !passwordMatches) {
      if (!passwordValidation.isValid) {
        setPasswordError("Password must meet all requirements.");
      }

      if (!confirmPassword) {
        setConfirmPasswordError("Confirm your new password.");
      } else if (!passwordMatches) {
        setConfirmPasswordError("Passwords do not match.");
      }

      return;
    }

    setIsSubmitting(true);

    try {
      const result = await supabase.auth.updateUser({ password });

      if (result.error) {
        setError(mapAuthErrorMessage(result.error, "Unable to update your password."));
        return;
      }

      setPassword("");
      setConfirmPassword("");
      setStatus("Password updated. Redirecting to your profile...");
      window.setTimeout(() => {
        router.replace("/profile");
        router.refresh();
      }, 900);
    } catch (caughtError) {
      logError("Password update failed.", caughtError);
      setError(mapAuthErrorMessage(caughtError, "Unable to update your password."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="card form-card">
      {isCheckingSession ? <p className="muted">Checking reset link...</p> : null}

      <form className="form-stack" onSubmit={handleSubmit}>
        <label>
          New Password
          <input
            autoComplete="new-password"
            disabled={!hasSession || isCheckingSession}
            minLength={8}
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

        <ul className="password-requirements" aria-label="Password requirements">
          {passwordRequirementStatus.map((requirement) => (
            <li className={requirement.isMet ? "met" : ""} key={requirement.key}>
              {requirement.label}
            </li>
          ))}
        </ul>
        {passwordError ? <p className="field-error">{passwordError}</p> : null}

        <label>
          Confirm New Password
          <input
            autoComplete="new-password"
            disabled={!hasSession || isCheckingSession}
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

        <button
          className="button"
          disabled={!hasSession || isCheckingSession || isSubmitting}
          type="submit"
        >
          {isSubmitting ? "Updating..." : "Update Password"}
        </button>
      </form>

      {status ? <p className="notice" aria-live="polite">{status}</p> : null}
      {error ? <p className="error" aria-live="polite">{error}</p> : null}

      {!hasSession && !isCheckingSession ? (
        <Link className="button button-link secondary-button" href="/auth">
          Request a new reset link
        </Link>
      ) : null}
    </div>
  );
}
