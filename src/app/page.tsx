export default function HomePage() {
  return (
    <>
      <span className="badge">Free-entry community tournaments</span>
      <h1>TFM2 Tournament Realm</h1>
      <p className="muted">An unofficial competitive tournament hub for Teamfight Manager 2 players and organizers.</p>
      <section className="grid">
        <div className="card"><h2>Players</h2><p>Register for tournaments, check in for matches, report results, and build match history.</p></div>
        <div className="card"><h2>Organizers</h2><p>Create brackets, manage match rooms, review evidence, and resolve disputes.</p></div>
        <div className="card"><h2>Fair play</h2><p>No gambling, wagers, buy-ins, wallets, or payment features. This is for community play only.</p></div>
      </section>
    </>
  );
}
