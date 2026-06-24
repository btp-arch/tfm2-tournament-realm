import Link from "next/link";

const links = [
  ["Home", "/"],
  ["Tournaments", "/tournaments"],
  ["Create", "/tournaments/create"],
  ["Profile", "/profile"],
  ["Organizer", "/organizer"],
  ["Admin", "/admin"],
  ["Rules", "/rules"],
  ["About", "/about"],
];

export function SiteNav() {
  return (
    <nav className="nav" aria-label="Primary navigation">
      {links.map(([label, href]) => (
        <Link key={href} href={href}>{label}</Link>
      ))}
    </nav>
  );
}
