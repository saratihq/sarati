import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

/** A message the fake Gmail sent, with the access token that sent it. */
export interface SentMessage {
  token: string;
  raw: string;
}

/** Gmail in-process — one mailbox per access token, answering the identity probe and the send; nothing leaves the machine. */
export function gmailFake(mailboxes: Record<string, string>): { fetch: FetchLike; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = new URL(String(input));
    const token = (init?.headers?.authorization ?? '').replace(/^Bearer /, '');
    const reply = (status: number, body: unknown): Promise<FetchLikeResponse> =>
      Promise.resolve({
        status,
        headers: { forEach: (cb) => cb('application/json', 'content-type') },
        text: () => Promise.resolve(JSON.stringify(body)),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    const mailbox = mailboxes[token];
    if (!mailbox) return reply(401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (url.pathname.endsWith('/profile')) {
      return reply(200, { emailAddress: mailbox, messagesTotal: 1, threadsTotal: 1, historyId: '1' });
    }
    if (url.pathname.endsWith('/messages/send')) {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { raw: string }) : { raw: '' };
      sent.push({ token, raw: Buffer.from(body.raw, 'base64url').toString('utf8') });
      return reply(200, { id: `m-${sent.length}`, threadId: 't', labelIds: ['SENT'] });
    }
    return reply(404, { error: { code: 404, message: `unexpected ${url.pathname}` } });
  };
  return { fetch, sent };
}
