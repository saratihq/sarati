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
