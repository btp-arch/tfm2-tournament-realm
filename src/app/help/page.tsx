import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/ui";
import { helpTopics } from "@/app/help/help-content";

export default function HelpPage() {
  return (
    <>
      <PageHeader
        eyebrow="Public Help"
        title="Help"
        description="Player and organizer guides for free-entry unofficial Teamfight Manager 2 community tournaments."
      />

      <section className="help-card-grid" aria-label="Help topics">
        {helpTopics.map((topic) => (
          <Link className="help-card-link" key={topic.slug} href={`/help/${topic.slug}`}>
            <span>{topic.title}</span>
            <p>{topic.summary}</p>
          </Link>
        ))}
      </section>

      <SectionCard title="Quick Start">
        <ol className="help-list">
          <li>Sign in, open a public tournament, and register while registration is open.</li>
          <li>Check in near the tournament start time so staff can include you in the field.</li>
          <li>Open your match room when assigned, follow host setup, then report winner and score after play.</li>
          <li>Use disputes only when a score, winner, or match state needs organizer/admin review.</li>
        </ol>
      </SectionCard>
    </>
  );
}
