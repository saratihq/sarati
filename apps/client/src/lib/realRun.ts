// The ONE honest-signalling copy for "this runs for real" surfaces, so no surface can call a live run
// safe while another writes to the user's connected accounts. There is no dry-run yet.

/** The consequence line every real-run surface renders; do NOT fork divergent wording per surface. */
export const REAL_RUN_CONSEQUENCE =
  "Real effects can fire: messages sent, data written, external calls made. There is no dry-run yet.";

/** The short inline note for an action that runs against a connected account. */
export const REAL_RUN_STEP_NOTE = `Runs for real on your connected account. ${REAL_RUN_CONSEQUENCE}`;
