import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import type { FetchLike } from '@sarati/actions-sdk';

import type { ConnectionsService } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import { SdkActionsProvider } from './sdk-actions.provider';

const PAGE = readFileSync(
  join(__dirname, '../../../../docs/src/content/docs/operate/troubleshooting.md'),
  'utf8',
);

interface WrongValue {
  actionId: string;
  props: Record<string, unknown>;
  credential: unknown;
}

/** Per app the page advises, a step given the value its bullet warns against, on the app's own credential. */
const WRONG_VALUE: Record<string, WrongValue> = {
  Salesforce: {
    actionId: 'salesforce.run_query',
    props: { instanceUrl: 'https://na123.salesforce.com', query: 'SELECT Id FROM Account' },
    credential: { access_token: 'tok' },
  },
  Mailchimp: {
    actionId: 'mailchimp.list_audiences',
    props: { serverPrefix: 'us21.api.mailchimp.com' },
    credential: { username: 'any', password: 'key-us21' },
  },
  Zendesk: {
    actionId: 'zendesk.list_tickets',
    props: { subdomain: 'acme.zendesk.com' },
    credential: { username: 'me@acme.com/token', password: 'tok' },
  },
};

/** Each `- **App:**` bullet that follows a quoted step failure in its section, with that quote. */
function adviceByQuote(page: string): Map<string, string> {
  const advice = new Map<string, string>();
  let quote = '';
  let fence: string[] | null = null;
  for (const line of page.split('\n')) {
    if (line.startsWith('```')) {
      if (fence) quote = fence.join('\n');
      fence = fence ? null : [];
    } else if (fence) {
      fence.push(line);
    } else if (line.startsWith('## ')) {
      quote = '';
    } else {
      const app = /^- \*\*([A-Za-z]+):\*\*/.exec(line)?.[1];
      if (app && /^[a-z_]+\.[a-z_]+ failed: /m.test(quote)) advice.set(app, quote);
    }
  }
  return advice;
}

async function refusal(app: string): Promise<{ message: string; sent: string[] }> {
  const { actionId, props, credential } = WRONG_VALUE[app]!;
  const sent: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    sent.push(String(url));
    return Promise.reject(new Error('sent'));
  };
  const connections = {
    managedRef: () =>
      Promise.resolve({ id: 'conn', authType: 'token', status: 'active', connectedAccountId: null }),
    getCredential: () => Promise.resolve(credential),
  } as unknown as ConnectionsService;
  const config = {
    get: () => ({ composioBaseUrl: 'https://backend.composio.dev' }),
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  const err = await new SdkActionsProvider(config, connections, fetchImpl)
    .runAction({ externalUserId: 'user-1', actionId, props, auth: { connectionId: 'conn' } })
    .catch((e: unknown) => e);
  return { message: (err as Error).message, sent };
}

/** The page tells an operator what to set after a refusal, so each app's advice sits under the refusal it really gets. */
describe('docs/operate/troubleshooting.md', () => {
  const advice = adviceByQuote(PAGE);

  it('advises exactly the apps it has a wrong value for', () => {
    expect([...advice.keys()].sort()).toEqual(Object.keys(WRONG_VALUE).sort());
  });

  it.each(Object.keys(WRONG_VALUE))(
    'puts the %s advice under the refusal its step prints, sent nowhere',
    async (app) => {
      const { message, sent } = await refusal(app);
      expect(sent).toEqual([]);
      expect(advice.get(app)?.split('\n')).toContain(message);
    },
  );
});
