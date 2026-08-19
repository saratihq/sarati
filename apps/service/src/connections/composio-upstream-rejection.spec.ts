import { upstreamRejection } from './composio-upstream-rejection';

/**
 * The body Slack actually returned when the app could not reach the channel — HTTP 200, Composio
 * `successful: true`, and the step was recorded green while nobody was notified.
 */
describe('an upstream refusal hiding inside a 200', () => {
  it('names the reason Slack gave', () => {
    const live = { error: 'channel_not_found', ok: false, warning: 'missing_charset' };
    expect(upstreamRejection(live)).toBe('channel_not_found');
  });

  it("sees through Composio's envelope", () => {
    expect(upstreamRejection({ response_data: { ok: false, error: 'not_in_channel' } })).toBe(
      'not_in_channel',
    );
  });

  it('still fails the step when the refusal carries no reason', () => {
    expect(upstreamRejection({ ok: false })).toBe('the API rejected the call');
  });

  it('reads a nested error object', () => {
    expect(upstreamRejection({ success: false, error: { message: 'INVALID_ARGUMENT' } })).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('passes a successful call', () => {
    expect(upstreamRejection({ ok: true, id: 'srv_1' })).toBeNull();
  });

  it('says nothing about a body that never carried the flag — guessing would fail working steps', () => {
    for (const body of [
      { values: [['a']] },
      { spreadsheetId: 'x' },
      { files: [], count: 0 },
      { ok: 'false' },
      { status: 'error' },
      null,
      'a string',
      42,
    ]) {
      expect(upstreamRejection(body)).toBeNull();
    }
  });
});
