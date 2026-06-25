import { TournamentDetail } from "@/app/tournaments/[id]/tournament-detail";

export default async function TournamentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <TournamentDetail tournamentId={id} />;
}
