import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the fixture received: `METHOD path`, the API key it carried, and its JSON body. */
export interface ComposioArrival {
  call: string;
  key: string | undefined;
  body: Record<string, unknown>;
}

/** A Composio stand-in on 127.0.0.1 that records every request and answers as Composio's v3 API does. */
export interface ComposioFixture {
  origin: string;
  arrivals: ComposioArrival[];
  /** The live trigger instances `GET /trigger_instances/active` lists. */
  active: Array<{ id: string; connected_account_id: string }>;
  /** Tool executions, typed and proxied, in arrival order. */
  executions: () => ComposioArrival[];
  close: () => Promise<void>;
}

const MANAGED_TOOLKITS = ['trello', 'zendesk', 'slack', 'gmail', 'github', 'jira'];
const TRIGGER_TYPES = [
  {
    slug: 'GMAIL_NEW_GMAIL_MESSAGE',
    name: 'New Gmail Message Received Trigger',
    toolkit: { slug: 'gmail' },
    type: 'poll',
  },
];
const ZENDESK_PAGE_2 = 'https://acme.zendesk.com/api/v2/tickets.json?page=2&per_page=100';

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
    });
  });
}

// What the app behind Composio's proxy answers, by the request the action made.
function proxied(body: Record<string, unknown>): unknown {
  const call = `${String(body.method)} ${String(body.endpoint)}`;
  if (call === `GET ${ZENDESK_PAGE_2}`) return { tickets: [{ id: 8 }], next_page: null };
  if (call.startsWith('GET https://acme.zendesk.com/api/v2/tickets.json')) {
    return { tickets: [{ id: 7 }], next_page: ZENDESK_PAGE_2 };
  }
  if (call === 'POST https://slack.com/api/chat.postMessage') return { ok: true, channel: 'C1', ts: '1.0' };
  return null;
}

function typed(slug: string): unknown {
  if (slug === 'SLACK_FETCH_TEAM_INFO') return { team: { id: 'T1', name: 'Acme' } };
  if (slug === 'GMAIL_GET_PROFILE') return { emailAddress: 'someone@e2e.local' };
  if (slug === 'GMAIL_FETCH_EMAILS') return { messages: [] };
  return { via: slug };
}

/** Starts the fixture; each connect link mints the next `ca_<n>` account. */
export async function startComposioFixture(): Promise<ComposioFixture> {
  const arrivals: ComposioArrival[] = [];
  const active: ComposioFixture['active'] = [];
  let linked = 0;

  const answer = (call: string, body: Record<string, unknown>, res: ServerResponse): void => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const path = call.slice(call.indexOf(' ') + 1).split('?')[0] ?? '';
    const method = call.slice(0, call.indexOf(' '));
    const execute = /^\/api\/v3\/tools\/execute\/([A-Za-z0-9_]+)$/.exec(path);
    if (method === 'GET' && path === '/api/v3/toolkits') {
      json(200, {
        items: MANAGED_TOOLKITS.map((slug) => ({
          slug,
          name: slug,
          composio_managed_auth_schemes: ['OAUTH2'],
        })),
        next_cursor: null,
      });
    } else if (method === 'GET' && path === '/api/v3/auth_configs') {
      json(200, { items: [] });
    } else if (method === 'POST' && path === '/api/v3/auth_configs') {
      json(201, {
        auth_config: { id: `ac_${String((body.toolkit as { slug?: string } | undefined)?.slug)}` },
      });
    } else if (method === 'POST' && path === '/api/v3/connected_accounts/link') {
      linked += 1;
      json(201, {
        redirect_url: `https://connect.composio.test/${linked}`,
        connected_account_id: `ca_${linked}`,
      });
    } else if (method === 'GET' && path.startsWith('/api/v3/connected_accounts/')) {
      json(200, { id: path.split('/').pop(), status: 'ACTIVE', state: { val: { token_type: 'Bearer' } } });
    } else if (method === 'DELETE' && path.startsWith('/api/v3/connected_accounts/')) {
      json(200, {});
    } else if (method === 'POST' && path === '/api/v3/tools/execute/proxy') {
      const data = proxied(body);
      json(200, { data: data ?? { error: 'not found' }, status: data === null ? 404 : 200, headers: {} });
    } else if (method === 'POST' && execute) {
      json(200, { successful: true, data: typed(execute[1]!), error: null });
    } else if (method === 'GET' && path === '/api/v3/tools') {
      json(200, { items: [], next_cursor: null });
    } else if (method === 'GET' && path === '/api/v3/triggers_types') {
      json(200, { items: TRIGGER_TYPES, next_cursor: null });
    } else if (method === 'GET' && path === '/api/v3/trigger_instances/active') {
      json(200, { items: active, next_cursor: null });
    } else if (method === 'DELETE' && path.startsWith('/api/v3/trigger_instances/manage/')) {
      json(200, {});
    } else if (method === 'POST' && /^\/api\/v3\/trigger_instances\/[^/]+\/upsert$/.test(path)) {
      json(200, { trigger_id: `ti_${String(body.connected_account_id)}` });
    } else {
      json(404, { error: `unexpected ${call}` });
    }
  };

  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const call = `${req.method ?? ''} ${req.url ?? ''}`;
      arrivals.push({ call, key: req.headers['x-api-key'] as string | undefined, body });
      answer(call, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    arrivals,
    active,
    executions: () => arrivals.filter((a) => a.call.startsWith('POST /api/v3/tools/execute/')),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
