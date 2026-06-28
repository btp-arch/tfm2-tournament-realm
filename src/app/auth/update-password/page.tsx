import { PasswordUpdateForm } from "./password-update-form";

export default function UpdatePasswordPage() {
  return (
    <>
      <h1>Update Password</h1>
      <p className="muted">Choose a new password for your Tournament Realm account.</p>
      <PasswordUpdateForm />
    </>
  );
}
