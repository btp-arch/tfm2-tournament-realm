import { Suspense } from "react";
import { AuthForm } from "./auth-form";

export default function AuthPage() {
  return (
    <>
      <h1>Sign In</h1>
      <p className="muted">Use Supabase Auth to access your player profile.</p>
      <Suspense fallback={<p className="muted">Loading auth form...</p>}>
        <AuthForm />
      </Suspense>
    </>
  );
}
