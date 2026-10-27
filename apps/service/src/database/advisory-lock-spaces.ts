// Every two-key advisory lock space, so no two collide; the one-key locks are pg-boss's and DBOS's.

/** The trigger activation lock's space: one key per activation. */
export const ACTIVATION_LOCK_SPACE = 7301;

/** The account admission lock's space: one key, so every admission — a password sign-up, a single sign-on account's first sign-in, an identity link, an address taken — takes its turn. */
export const ADMISSION_LOCK_SPACE = 7302;
