import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, SectionCard } from "@/components/ui";
import { helpTopicMap, helpTopics } from "@/app/help/help-content";

export function generateStaticParams() {
  return helpTopics.map((topic) => ({ slug: topic.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const topic = helpTopicMap.get(slug);

  return {
    title: topic ? `${topic.title} | Help` : "Help",
  };
}

export default async function HelpTopicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const topic = helpTopicMap.get(slug);

  if (!topic) {
    notFound();
  }

  return (
    <>
      <PageHeader
        eyebrow="Help"
        title={topic.title}
        description={topic.summary}
        action={<Link className="button button-link secondary-button" href="/help">Back to Help</Link>}
      />

      {topic.sections.map((section) => (
        <SectionCard key={section.title} title={section.title}>
          <ul className="help-list">
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </SectionCard>
      ))}

      <SectionCard title="Related Help">
        <div className="related-links">
          {topic.related.map((relatedSlug) => {
            const relatedTopic = helpTopicMap.get(relatedSlug);

            if (!relatedTopic) {
              return null;
            }

            return (
              <Link key={relatedTopic.slug} href={`/help/${relatedTopic.slug}`}>
                {relatedTopic.title}
              </Link>
            );
          })}
        </div>
      </SectionCard>
    </>
  );
}

