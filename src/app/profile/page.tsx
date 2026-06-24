import { ProfileForm } from "./profile-form";

export default function ProfilePage() {
  return (
    <>
      <h1>Profile</h1>
      <p className="muted">Manage the public player details organizers use to identify you.</p>
      <ProfileForm />
    </>
  );
}
