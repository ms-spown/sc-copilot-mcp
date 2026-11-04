/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The words that name a break in a session and how far a start balance can be trusted, for the session report
 * (providers/sessions/debrief.ts). The dashboard page carries its OWN copies (sessionInterruptionLabel and
 * sessionQualityLabel in dashboard/sessionPanel.ts): the page serialises its functions and cannot import. A test keeps the two
 * in step, so neither layer imports the other.
 */

/** The three words of a break: the game closed itself, or no end marker was left. */
export function sessionInterruptionLabel(kind: string): string {
  return kind === "game_closed"
    ? "jeu fermé normalement"
    : "sans marqueur de fin (plantage, redémarrage du PC ou serveur arrêté)";
}

export function sessionQualityLabel(q: any): string {
  const labels: any = {
    game_start: "relevé dès le démarrage du jeu",
    first_seen: "premier solde vu par le serveur (le jeu tournait déjà)",
    new_session: "relevé au moment de la nouvelle session",
    late: "relevé longtemps après le début de la session",
  };
  return labels[q] || "";
}
