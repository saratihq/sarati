import { accountProbeFor, identityFrom } from './account-probes';

/** Every response below was captured from a live connection through the managed rail. */
const answer = (provider: string, output: unknown) => identityFrom(output, accountProbeFor(provider)!);

describe('which account a connection is authorized against', () => {
  it('names the Slack workspace and its team id — the workspace, not the person', () => {
    expect(answer('slack', { team: { id: 'T0BFMNPDEQ2', name: 'orchestr' } })).toEqual({
      subject: 'workspace',
      name: 'orchestr',
      id: 'T0BFMNPDEQ2',
      email: null,
      handle: null,
    });
  });

  it("reads GitHub's login as the handle and its numeric id", () => {
    expect(answer('github', { login: 'eghuzefa', id: 190477365 })).toEqual({
      subject: 'user',
      name: null,
      id: '190477365',
      email: null,
      handle: 'eghuzefa',
    });
  });

  it('names the Google account behind a Sheets or Drive connection', () => {
    const about = {
      user: { displayName: 'A Name', emailAddress: 'huzefa@sarati.io', permissionId: '0884870653855901152' },
    };
    const expected = {
      subject: 'user',
      name: 'A Name',
      id: '0884870653855901152',
      email: 'huzefa@sarati.io',
      handle: null,
    };
    expect(answer('sheets', about)).toEqual(expected);
    expect(answer('drive', about)).toEqual(expected);
  });

  it("reads the Gmail mailbox's address, wrapped or as our action shapes it", () => {
    const profile = { emailAddress: 'huzefa@sarati.io', historyId: '3267', messagesTotal: 5, threadsTotal: 5 };
    const expected = {
      subject: 'user',
      name: null,
      id: 'huzefa@sarati.io',
      email: 'huzefa@sarati.io',
      handle: null,
    };
    expect(answer('gmail', { response_data: profile })).toEqual(expected);
    expect(answer('gmail', profile)).toEqual(expected);
  });

  it('has no way to ask an app without a proven probe', () => {
    expect(accountProbeFor('claude')).toBeUndefined();
  });

  it('returns null rather than half an answer when the response names nothing', () => {
    expect(answer('slack', { ok: true })).toBeNull();
    expect(answer('gmail', 'not an object')).toBeNull();
  });
});
