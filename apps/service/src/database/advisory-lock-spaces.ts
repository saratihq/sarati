// Every two-key advisory lock space, so no two collide; the one-key locks are pg-boss's and DBOS's.

/** The trigger activation lock's space: one key per activation. */
export const ACTIVATION_LOCK_SPACE = 7301;

/** The local registration lock's space: one key, so registrations take turns. */
export const REGISTRATION_LOCK_SPACE = 7302;
