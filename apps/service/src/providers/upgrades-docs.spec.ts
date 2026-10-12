import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import type { ConnectionsService } from '../connections/connections.service';
import type { EnvConfig } from '../config/env.config';
import type { PlatformKeysService } from '../platform/platform-keys.service';
import { SdkActionsProvider } from './sdk-actions.provider';

const PAGE = readFileSync(join(__dirname, '../../../../docs/src/content/docs/operate/upgrades.md'), 'utf8');

const SITE = 'https://acme.atlassian.net';

// Each ran on v0.2.23 as a managed Jira step's Instance URL, on a connection whose one site is SITE.
const RAN_ON_V0_2_23 = [
  SITE,
  'acme.atlassian.net',
  'http://acme.atlassian.net',
  'https://jira.acme.com',
  'https://old.atlassian.net',
];

function versionNote(page: string, version: string): string {
  const start = page.indexOf(`\n### ${version}:`);
  if (start < 0) throw new Error(`upgrades.md has no ${version} note`);
  const end = page.indexOf('\n##', start + 1);
  return page.slice(start, end < 0 ? undefined : end);
}

function proxyResponse(data: unknown, status: number): FetchLikeResponse {
  return {
    status: 200,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(JSON.stringify({ data, status, headers: {} })),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

const composioReachingOnlySite: FetchLike = (_url, init) => {
  const { endpoint } = JSON.parse(String(init?.body)) as { endpoint: string };
  if (endpoint === 'https://api.atlassian.com/oauth/token/accessible-resources') {
    return Promise.resolve(proxyResponse([{ id: 'cloud-acme', url: SITE, name: 'acme' }], 200));
  }
  if (endpoint.startsWith('https://api.atlassian.com/ex/jira/cloud-acme/rest/api/3/issue/ENG-1')) {
    return Promise.resolve(proxyResponse({ id: '10001', key: 'ENG-1', fields: {} }, 200));
  }
  return Promise.resolve(proxyResponse({ errorMessages: ['not found'] }, 404));
};

async function refuses(instanceUrl: string): Promise<boolean> {
  const connections = {
    managedRef: () =>
      Promise.resolve({ id: 'conn', authType: 'managed', status: 'active', connectedAccountId: 'ca_jira' }),
  } as unknown as ConnectionsService;
  const config = {
    get: () => ({ composioBaseUrl: 'https://backend.composio.dev' }),
  } as unknown as ConfigService<{ env: EnvConfig }, true>;
  const platformKeys = {
    scopeFor: (userId: string) => Promise.resolve({ kind: 'user', userId }),
    composioApiKey: () => Promise.resolve('ak_test'),
  } as unknown as PlatformKeysService;
  const outcome = await new SdkActionsProvider(config, connections, composioReachingOnlySite, platformKeys)
    .runAction({
      externalUserId: 'user-1',
      actionId: 'jira.get_issue',
      props: { instanceUrl, issueIdOrKey: 'ENG-1' },
      auth: { connectionId: 'conn' },
    })
    .catch((e: unknown) => e);
  if (!(outcome instanceof Error)) return false;
  if (outcome.message.includes('instanceUrl')) return true;
  throw outcome;
}

describe('docs/operate/upgrades.md', () => {
  const note = versionNote(PAGE, 'v0.2.24');

  it.each(RAN_ON_V0_2_23)('names %s exactly when a managed Jira step refuses it', async (instanceUrl) => {
    expect(note.includes(`\`${instanceUrl}\``)).toBe(await refuses(instanceUrl));
  });
});
