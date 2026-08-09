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
