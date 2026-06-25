import Link from "next/link";

type AccessDeniedProps = {
  title?: string;
  message: string;
};

export function AccessDenied({ title = "Access denied", message }: AccessDeniedProps) {
  return (
    <section className="card">
      <h1>{title}</h1>
      <p className="muted">{message}</p>
      <Link className="button button-link" href="/profile">
        View Profile
      </Link>
    </section>
  );
}
