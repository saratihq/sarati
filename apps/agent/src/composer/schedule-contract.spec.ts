import { composerSystemPrompt } from './system-prompt';

/**
 * The service validates `orchestr:schedule` as EXACTLY ONE of cron | interval_minutes, plus an
 * optional IANA timezone. These strings are the only description of that contract the model ever
 * sees, so a field missing here reads to the model as a capability that does not exist.
 */
describe('what the composer is told about orchestr:schedule', () => {
  const prompt = composerSystemPrompt(true);

  it.each(['cron', 'interval_minutes', 'timezone'])('names the %s field the validator accepts', (field) => {
    expect(prompt).toContain(field);
  });

  it('gives a concrete cron example, so a clock time is never reported as impossible', () => {
    expect(prompt).toMatch(/\d+ \d+ \* \* /);
  });
});

/** Live triggers come only from environment pointers (triggers/canvas/reconcile.ts), and Default is production. */
describe('what the composer is told about what a save changes', () => {
  const prompt = composerSystemPrompt(true);

  it('says a save never changes what a trigger runs, and never that Default follows saves', () => {
    expect(prompt).toContain('a save never changes what a trigger runs');
    expect(prompt).toContain('Default means production');
    expect(prompt).not.toMatch(/latest saved version on main/i);
  });
});

/** Integrations offers Reconnect only on an account that is not active; connecting again adds a second one beside it. */
describe('what the composer is told about a sign-in that stopped working', () => {
  const prompt = composerSystemPrompt(true);

  it('never says reconnecting replaces an active account, and says to remove the one that stopped working', () => {
    expect(prompt).toContain('remove the one that stopped working');
    expect(prompt).not.toMatch(/tell them to reconnect the app under Integrations/);
  });
});

/** Row 18: a step with no account chosen runs as its runner's only one, so a fix never writes one person's id into shared content. */
describe('what the composer is told about a chosen account the step cannot run as', () => {
  const prompt = composerSystemPrompt(true);

  it('clears the choice so the step runs as their only usable account, and writes an id only for a pick they made', () => {
    expect(prompt).toContain('set its connectionId to null with update_node');
    expect(prompt).toContain(
      'Write an account id into a step only for one they picked when you asked with ask_user',
    );
    expect(prompt).not.toMatch(/connectionId with update_node to another of their active accounts/);
    expect(prompt).not.toMatch(/set its connectionId to one of their one-click accounts/);
  });
});
