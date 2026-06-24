export default function TournamentDetailPage({ params }: { params: { id: string } }) {
  return <><h1>Tournament Detail</h1><p className="muted">Placeholder for tournament {params.id}.</p><div className="card">Registration, organizer roster, matches, and standings will be added in later milestones.</div></>;
}
