import { EditTournamentForm } from "@/app/tournaments/[id]/edit/tournament-edit-form";

export default async function EditTournamentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <EditTournamentForm tournamentId={id} />;
}
