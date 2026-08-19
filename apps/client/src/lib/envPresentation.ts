// Environment & tag PRESENTATION — the client cell of the invariant vault.
// Vault rule: meaning derives from FLAGS and ids (`is_prod`); names are display only.

const TAG_COLORS: Record<string, { bg: string; text: string }> = {
  prod: { bg: "var(--orchestr-success-tint)", text: "var(--orchestr-success)" },
  production: { bg: "var(--orchestr-success-tint)", text: "var(--orchestr-success)" },
  uat: { bg: "var(--orchestr-warning-tint)", text: "var(--orchestr-warning)" },
  staging: { bg: "rgba(33,150,243,0.15)", text: "#64b5f6" },
  dev: { bg: "rgba(156,39,176,0.15)", text: "#ce93d8" },
  latest: { bg: "rgba(255,255,255,0.06)", text: "rgba(255,255,255,0.45)" },
};

export function getTagColor(tag: string): { bg: string; text: string } {
  return TAG_COLORS[tag] || { bg: "var(--orchestr-accent-tint)", text: "var(--orchestr-ink-muted)" };
}

/** Predefined environments: locked name, undeletable. */
export function isProtectedEnv(env: { is_prod: boolean; name: string }): boolean {
  return env.is_prod || env.name === "uat";
}
