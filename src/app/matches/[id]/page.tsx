import { MatchRoom } from "@/app/matches/[id]/match-room";

export default async function MatchRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <MatchRoom matchId={id} />;
}
