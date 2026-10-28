import { randomBytes } from 'node:crypto';

import {
  actions,
  type AuthHandle,
  defineTrigger,
  type DirectCredential,
  type FetchLike,
  type NormalizedResponse,
} from '@sarati/actions-sdk';

import { buildDirectAuth, buildLazyDirectAuth, buildObservedDirectAuth } from './sdk-trigger-auth';

const scheme = actions.clickup.newTask.auth;
const DELETE_URL = 'https://api.clickup.com/api/v2/webhook/subscription-1';

// No shipped trigger's delete lets an app's refusal through; any `http.*` call that keeps `throwOnError` would.
const refusedDelete = defineTrigger({
  type: 'test.refused_delete',
  strategy: 'webhook',
  name: 'Refused delete',
  description: 'Deletes its subscription and surfaces the refusal.',
  auth: scheme,
  props: {},
  onDisable: async ({ http, auth }) => {
    await http.delete(DELETE_URL, { auth });
  },
  onRequest: () => [],
});

const noStore = { get: () => Promise.resolve(undefined), set: () => Promise.resolve() };

describe('every direct-rail auth handle the service builds', () => {
  const key = `pk_${randomBytes(12).toString('hex')}`;
  const credential: DirectCredential = { type: 'apiKey', value: key };
  const sent: string[] = [];
  const observed: NormalizedResponse[] = [];

  // The app refuses the delete and echoes the key it was sent, as some providers' error bodies do.
  const echoingRefusal: FetchLike = (_input, init) => {
    sent.push(init?.headers?.authorization ?? '');
    const body = JSON.stringify({ message: `Token ${init?.headers?.authorization ?? ''} is not valid` });
    return Promise.resolve({
      status: 401,
      headers: { forEach: (cb) => cb('application/json', 'content-type') },
      text: () => Promise.resolve(body),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  };

  const builders: Array<[string, () => AuthHandle]> = [
    ['buildDirectAuth', () => buildDirectAuth(scheme, credential, echoingRefusal)],
    [
      'buildLazyDirectAuth',
      () => buildLazyDirectAuth(scheme, () => Promise.resolve(credential), echoingRefusal),
    ],
    [
      'buildObservedDirectAuth',
      () => buildObservedDirectAuth(scheme, credential, echoingRefusal, (r) => observed.push(r)),
    ],
  ];

  beforeEach(() => {
    sent.length = 0;
    observed.length = 0;
  });

  it.each(builders)(
    '%s keeps the credential an app echoes out of the error it raises',
    async (_name, build) => {
      const failure = await refusedDelete
        .disable({ auth: build(), props: {}, store: noStore, webhookUrl: '', secret: '' })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(sent).toEqual([key]);
      expect(failure).toBeInstanceOf(Error);
      const { message, stack } = failure as Error;
      expect(message).toMatch(/^HTTP 401: .*\[redacted\]/);
      expect(`${message}\n${stack}`).not.toContain(key);
    },
  );

  it('the observed handle still reports the refusal it scrubbed', async () => {
    const auth = builders[2]![1]();
    await expect(
      refusedDelete.disable({ auth, props: {}, store: noStore, webhookUrl: '', secret: '' }),
    ).rejects.toThrow('HTTP 401');
    expect(observed.map((r) => r.status)).toEqual([401]);
  });
});
