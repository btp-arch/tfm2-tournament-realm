import { PageHeader, SectionCard } from "@/components/ui";

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" />

      <SectionCard title="Registering for a Tournament">
        <ol>
          <li>Sign in, open the tournament page, and use the Register button while registration is open.</li>
          <li>Your registered tournaments appear on the dashboard until the tournament is completed.</li>
          <li>After registration closes, watch the tournament page or notifications for tournament check-in.</li>
        </ol>
      </SectionCard>

      <SectionCard title="Tournament Check-In">
        <ol>
          <li>When staff opens check-in, registered players must confirm attendance from the tournament page.</li>
          <li>Checked-in players are eligible for the draw, group stage, or bracket.</li>
          <li>Players who miss tournament check-in can be excluded from the generated field.</li>
        </ol>
      </SectionCard>

      <SectionCard title="Replacement Window">
        <p className="muted">
          If the field has open spots after registration or tournament check-in, staff may open a replacement
          window. Eligible players can claim available replacement spots from the tournament page until that
          window closes. Replacement players are added only when capacity remains and before the draw or bracket
          is generated.
        </p>
      </SectionCard>

      <SectionCard title="Match Check-In and Creation">
        <ol>
          <li>When your match room is ready, open it from the dashboard, notification banner, or tournament page.</li>
          <li>Both assigned players should check in inside the match room.</li>
          <li>The assigned host creates the Teamfight Manager 2 match lobby, then marks Match Created.</li>
          <li>Players should use the match room status and notes to stay aligned before playing.</li>
        </ol>
      </SectionCard>

      <SectionCard title="Reporting Results">
        <ol>
          <li>After the match, report the winner and final score from the match room.</li>
          <li>The opponent can confirm the report or submit a different report if something is wrong.</li>
          <li>Evidence and disputes go to organizer/admin review when reports do not match or need staff attention.</li>
          <li>Finalized results update tournament progress and player records when they are eligible for stats.</li>
        </ol>
      </SectionCard>

      <SectionCard title="Creating and Running Tournaments">
        <ol>
          <li>Organizers create tournaments from the Organizer area and configure format, capacity, timing, and rules text.</li>
          <li>The normal flow is registration open, registration closed, tournament check-in, then draw or bracket generation.</li>
          <li>During live play, staff can manage check-in, replacement windows, match issues, and result review from the tournament controls.</li>
        </ol>
      </SectionCard>
    </>
  );
}
