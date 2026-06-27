import { PlayerProfile } from "@/app/players/[id]/player-profile";

export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <PlayerProfile playerId={id} />;
}
