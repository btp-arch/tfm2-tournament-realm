import { Suspense } from "react";
import { AuthForm } from "./auth-form";

export default function AuthPage() {
  return (
    <>
      <h1>Account Access</h1>
      <p className="muted">Sign in, create an account, or reset your password.</p>
      <Suspense fallback={<p className="muted">Loading auth form...</p>}>
        <AuthForm />
      </Suspense>
    </>
  );
}
