import { DomainError } from '../common/domain-error';
import {
  decideRunAs,
  isInlineCredential,
  planForRunner,
  planRunAs,
  providersServing,
  resolveRunAs,
  type RunAsAccounts,
  stepsRunningAsAccounts,
} from './run-as-account';

const RUNNER = 'runner';
const OWNER = 'slot-owner';

// An in-memory connection store: the runner's personal accounts by provider, and slots by `env:app`.
function store(
  opts: {
    accounts?: Array<{ id: string; provider: string; owner?: string; status?: string; managed?: boolean }>;
    slots?: Record<string, string | { id: string; status?: string; provider?: string; managed?: boolean }>;
    envNames?: Record<string, string>;
  } = {},
): RunAsAccounts & { calls: string[] } {
  const accounts = opts.accounts ?? [];
  const calls: string[] = [];
  return {
    calls,
    resolveSlotConnection: (environmentId, app) => {
      calls.push(`slot:${environmentId}:${app}`);
      const slot = opts.slots?.[`${environmentId}:${app}`];
      if (!slot) return Promise.resolve(null);
      const {
        id,
        status = 'active',
        provider = app,
        managed = false,
      } = typeof slot === 'string' ? { id: slot } : slot;
      return Promise.resolve({ id, ownerUserId: OWNER, status, provider, managed });
    },
    resolveClusterConnection: () => Promise.resolve(null),
    environmentNameOf: (environmentId) => Promise.resolve(opts.envNames?.[environmentId] ?? null),
    ownConnections: (userId, ids) => {
      calls.push(`own:${userId}:${ids.join(',')}`);
      const own = accounts.filter((a) => ids.includes(a.id) && (a.owner ?? RUNNER) === userId);
      return Promise.resolve(
        new Map(
          own.map((a) => [
            a.id,
            { provider: a.provider, status: a.status ?? 'active', managed: a.managed ?? false },
          ]),
        ),
      );
    },
    accountsServing: (userId, apps) => {
      calls.push(`serving:${userId}:${apps.join(',')}`);
      const providers = apps.flatMap(providersServing);
      return Promise.resolve(
        accounts
          .filter(
            (a) =>
              (a.owner ?? RUNNER) === userId &&
              providers.includes(a.provider) &&
              (a.status ?? 'active') === 'active',
          )
          .map((a) => ({ id: a.id, provider: a.provider, managed: a.managed ?? false })),
      );
    },
  };
}

const gmailStep = (connectionId: string | null = null) => ({
  name: 'Email me the report',
  app: 'gmail',
  connectionId,
});

describe('the app-matching rule', () => {
  it('an app is served by its own accounts and by each family it belongs to', () => {
    expect(providersServing('gmail')).toEqual(['gmail']);
    expect(providersServing('zoho-crm')).toEqual(['zoho-crm', 'zoho']);
    expect(providersServing('facebook-pages')).toEqual(['facebook-pages', 'facebook']);
    expect(providersServing('a-b-c')).toEqual(['a-b-c', 'a', 'a-b']);
  });
});

describe('a credential handed to a step inline', () => {
  it('is a token or a credential record, never an account reference or nothing', () => {
    for (const auth of ['tok', { access_token: 'tok' }, { username: 'me', password: 'pw' }]) {
      expect(isInlineCredential(auth)).toBe(true);
    }
    for (const auth of [undefined, null, '', {}, { connectionId: 'c1' }, { connectionId: '' }, 7]) {
      expect(isInlineCredential(auth)).toBe(false);
    }
  });
});

describe('which account a step runs as', () => {
  it('a Default run takes the runner’s only account for a step with none chosen', async () => {
    const decision = await decideRunAs(
      gmailStep(),
      { externalUserId: RUNNER },
      store({
        accounts: [
          { id: 'g1', provider: 'gmail' },
          { id: 's1', provider: 'slack' },
        ],
      }),
    );
    expect(decision).toEqual({ kind: 'account', connectionId: 'g1', ownerUserId: RUNNER, via: 'only' });
  });

  it('a family account serves its app: one zoho account runs a zoho-crm step', async () => {
    const decision = await decideRunAs(
      { name: 'Add the lead', app: 'zoho-crm', connectionId: null },
      { externalUserId: RUNNER },
      store({ accounts: [{ id: 'z1', provider: 'zoho' }] }),
    );
    expect(decision).toMatchObject({ kind: 'account', connectionId: 'z1', via: 'only' });
  });

  it('no account fails naming the step and the app', async () => {
    const decision = await decideRunAs(gmailStep(), { externalUserId: RUNNER }, store());
    expect(decision).toMatchObject({
      kind: 'refused',
      reason: 'none',
      status: 422,
      message: 'Step "Email me the report" has no gmail account to run as — connect one',
    });
  });

  it('several accounts fail naming the step and how many, never picking one', async () => {
    const decision = await decideRunAs(
      gmailStep(),
      { externalUserId: RUNNER },
      store({
        accounts: [
          { id: 'g1', provider: 'gmail' },
          { id: 'g2', provider: 'gmail' },
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: 'refused',
      reason: 'several',
      message:
        'Step "Email me the report" has no gmail account chosen and you have 2 active gmail accounts — pick one on the step',
    });
  });

  it('a chosen account the runner owns is used, even when they have others', async () => {
    const decision = await decideRunAs(
      gmailStep('g2'),
      { externalUserId: RUNNER },
      store({
        accounts: [
          { id: 'g1', provider: 'gmail' },
          { id: 'g2', provider: 'gmail' },
        ],
      }),
    );
    expect(decision).toEqual({ kind: 'account', connectionId: 'g2', ownerUserId: RUNNER, via: 'chosen' });
  });

  it('a chosen account that is gone or someone else’s is refused — never swapped for the runner’s own', async () => {
    const accounts = store({
      accounts: [
        { id: 'mine', provider: 'gmail' },
        { id: 'theirs', provider: 'gmail', owner: 'teammate' },
      ],
    });
    for (const chosen of ['theirs', 'deleted']) {
      const decision = await decideRunAs(gmailStep(chosen), { externalUserId: RUNNER }, accounts);
      expect(decision).toMatchObject({ kind: 'refused', reason: 'stale', status: 422 });
      if (decision.kind !== 'refused') throw new Error('expected a refusal');
      expect(decision.message).toBe(
        'Step "Email me the report" runs as a gmail account that no longer exists or isn\'t yours — pick one of your gmail accounts on the step',
      );
      expect(decision.message).not.toContain(chosen);
    }
  });

  it.each(['pending', 'expired', 'failed'])(
    'a chosen account of the runner’s that is %s is refused naming the step and the fix — never run',
    async (status) => {
      const decision = await decideRunAs(
        gmailStep('g1'),
        { externalUserId: RUNNER },
        store({ accounts: [{ id: 'g1', provider: 'gmail', status }] }),
      );
      expect(decision).toEqual({
        kind: 'refused',
        reason: 'inactive',
        status: 422,
        message:
          'Step "Email me the report" runs as a gmail account that isn\'t active — pick another of your gmail accounts on the step',
      });
    },
  );

  it('a chosen account for another app is refused naming both apps — never handed to this one', async () => {
    const decision = await decideRunAs(
      gmailStep('s1'),
      { externalUserId: RUNNER },
      store({
        accounts: [
          { id: 'g1', provider: 'gmail' },
          { id: 's1', provider: 'slack' },
        ],
      }),
    );
    expect(decision).toEqual({
      kind: 'refused',
      reason: 'wrong_app',
      status: 422,
      message:
        'Step "Email me the report" runs as an account for slack, not gmail — pick one of your gmail accounts on the step',
    });
  });

  it('a chosen family account serves its app: a zoho account chosen on a zoho-crm step runs', async () => {
    const decision = await decideRunAs(
      { name: 'Add the lead', app: 'zoho-crm', connectionId: 'z1' },
      { externalUserId: RUNNER },
      store({ accounts: [{ id: 'z1', provider: 'zoho' }] }),
    );
    expect(decision).toMatchObject({ kind: 'account', connectionId: 'z1', via: 'chosen' });
  });

  it('an environment run takes the slot, chosen account or not, and runs as its owner', async () => {
    const accounts = store({
      accounts: [{ id: 'g1', provider: 'gmail' }],
      slots: { 'prod:gmail': 'slot-gmail' },
    });
    for (const chosen of [null, 'g1']) {
      const decision = await decideRunAs(
        gmailStep(chosen),
        { externalUserId: RUNNER, environmentId: 'prod', environment: 'production' },
        accounts,
      );
      expect(decision).toEqual({
        kind: 'account',
        connectionId: 'slot-gmail',
        ownerUserId: OWNER,
        via: 'slot',
      });
    }
  });

  it('an empty slot is a 428 naming the environment by name — looked up when the run carries only its id', async () => {
    const decision = await decideRunAs(
      gmailStep(),
      { externalUserId: RUNNER, environmentId: 'env-1' },
      store({ accounts: [{ id: 'g1', provider: 'gmail' }], envNames: { 'env-1': 'production' } }),
    );
    expect(decision).toMatchObject({
      kind: 'refused',
      reason: 'empty_slot',
      status: 428,
      message:
        'production has no gmail account assigned, so "Email me the report" can\'t run there — an owner assigns one under Integrations → Environments',
    });
  });

  it.each(['pending', 'expired', 'failed'])(
    'a slot whose account is %s is a 428 naming the environment, the app and the fix — never run',
    async (status) => {
      const decision = await decideRunAs(
        gmailStep('g1'),
        { externalUserId: RUNNER, environmentId: 'env-1', environment: 'production' },
        store({
          accounts: [{ id: 'g1', provider: 'gmail' }],
          slots: { 'env-1:gmail': { id: 'slot-gmail', status } },
          envNames: { 'env-1': 'production' },
        }),
      );
      expect(decision).toEqual({
        kind: 'refused',
        reason: 'inactive_slot',
        status: 428,
        message:
          "production's gmail account isn't active, so \"Email me the report\" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments",
      });
    },
  );

  it('a refusal names the environment as it is called now, not as the run recorded it', async () => {
    const decision = await decideRunAs(
      gmailStep(),
      { externalUserId: RUNNER, environmentId: 'env-1', environment: 'zz-old' },
      store({ envNames: { 'env-1': 'zz-renamed' } }),
    );
    expect(decision).toMatchObject({
      reason: 'empty_slot',
      message: expect.stringMatching(/^zz-renamed has no gmail/),
    });
  });

  it('a slot holding another app’s account is a 428 naming that app — never handed to this one', async () => {
    const decision = await decideRunAs(
      gmailStep(),
      { externalUserId: RUNNER, environmentId: 'env-1' },
      store({
        slots: { 'env-1:gmail': { id: 'slot-slack', provider: 'slack' } },
        envNames: { 'env-1': 'production' },
      }),
    );
    expect(decision).toEqual({
      kind: 'refused',
      reason: 'wrong_app_slot',
      status: 428,
      message:
        'production\'s gmail account is for slack, so "Email me the report" can\'t run there — an owner assigns a gmail account under Integrations → Environments',
    });
  });

  describe('a step only the managed rail runs', () => {
    const reminder = (connectionId: string | null = null) => ({
      name: 'Remind me',
      app: 'slack',
      connectionId,
      managedOnly: true,
    });
    const own = { id: 'own', provider: 'slack' };
    const oneClick = { id: 'one-click', provider: 'slack', managed: true };

    it('runs as the runner’s only one-click account, never one with its own credentials', async () => {
      const decision = await decideRunAs(
        reminder(),
        { externalUserId: RUNNER },
        store({ accounts: [own, oneClick] }),
      );
      expect(decision).toMatchObject({ kind: 'account', connectionId: 'one-click', via: 'only' });
    });

    it('with only own-credentials accounts it has none to run as, and says which kind it needs', async () => {
      const decision = await decideRunAs(reminder(), { externalUserId: RUNNER }, store({ accounts: [own] }));
      expect(decision).toEqual({
        kind: 'refused',
        reason: 'none',
        status: 422,
        message:
          'Step "Remind me" runs only on a one-click (managed) slack account, and you have none — connect one under Integrations',
      });
    });

    it('counts only one-click accounts when there are several', async () => {
      const decision = await decideRunAs(
        reminder(),
        { externalUserId: RUNNER },
        store({ accounts: [own, oneClick, { ...oneClick, id: 'one-click-2' }] }),
      );
      expect(decision).toMatchObject({
        reason: 'several',
        message:
          'Step "Remind me" has no slack account chosen and you have 2 active one-click slack accounts — pick one on the step',
      });
    });

    it('a chosen own-credentials account is refused before its status, naming the step and the kind it needs', async () => {
      const decision = await decideRunAs(
        reminder('own'),
        { externalUserId: RUNNER },
        store({ accounts: [{ ...own, status: 'expired' }, oneClick] }),
      );
      expect(decision).toEqual({
        kind: 'refused',
        reason: 'needs_managed',
        status: 422,
        message:
          'Step "Remind me" runs as an account that uses its own credentials, and it runs only on a one-click (managed) slack account — pick one on the step, or connect one under Integrations',
      });
    });

    it('a slot holding an own-credentials account can’t run it, while a step with an SDK action runs on that slot', async () => {
      const accounts = store({ slots: { 'env-1:slack': 'slot-own' }, envNames: { 'env-1': 'production' } });
      const scope = { externalUserId: RUNNER, environmentId: 'env-1' };
      expect(await decideRunAs(reminder(), scope, accounts)).toEqual({
        kind: 'refused',
        reason: 'needs_managed_slot',
        status: 428,
        message:
          'production\'s slack account uses its own credentials, and "Remind me" runs only on a one-click (managed) one, so it can\'t run there — an owner assigns a one-click slack account under Integrations → Environments',
      });
      expect(await decideRunAs({ ...reminder(), managedOnly: false }, scope, accounts)).toMatchObject({
        kind: 'account',
        connectionId: 'slot-own',
      });
    });

    it('the plan marks it and offers only one-click accounts for a pick', async () => {
      const plan = await planForRunner(
        { nodes: [{ id: 'r', name: 'Remind me', node_type: 'slack.create_a_reminder', parameters: {} }] },
        RUNNER,
        store({ accounts: [own, oneClick] }),
      );
      expect(plan).toEqual([
        expect.objectContaining({ node_id: 'r', managed_only: true, offered: ['one-click'] }),
      ]);
    });
  });

  it('resolveRunAs throws the refusal as the run’s error', async () => {
    const err = await resolveRunAs(gmailStep(), { externalUserId: RUNNER }, store()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(422);
    expect((err as DomainError).details).toEqual({ reason: 'none' });
  });
});

describe('the steps of a document that run as an account', () => {
  const node = (id: string, node_type: string, parameters: Record<string, unknown> = {}, extra = {}) => ({
    id,
    name: `${id} step`,
    node_type,
    parameters,
    ...extra,
  });

  it('every action needing an account, chosen or not, and every agent under its model provider', () => {
    const steps = stepsRunningAsAccounts({
      nodes: [
        node('trigger', 'orchestr:webhook'),
        node('app_trigger', 'gmail.new_email_trigger', { connectionId: 'c0' }),
        node('mail', 'gmail.send_email'),
        node('post', 'slack.send_channel_message', { connectionId: 'c3' }),
        node('fetch', 'http.send_request', { url: 'https://example.com' }),
        node('code', 'orchestr:code', { code: 'return 1' }),
        node('agent', 'orchestr:agent', { model: { provider: 'openai', model: 'gpt' } }),
        node('default_agent', 'orchestr:agent', {}),
      ],
    });
    expect(steps).toEqual([
      { nodeId: 'mail', name: 'mail step', app: 'gmail', connectionId: null },
      { nodeId: 'post', name: 'post step', app: 'slack', connectionId: 'c3' },
      expect.objectContaining({ nodeId: 'agent', name: 'agent step', app: 'openai', label: 'OpenAI' }),
      expect.objectContaining({
        nodeId: 'default_agent',
        app: 'claude',
        label: 'Claude',
        connectionId: null,
      }),
    ]);
  });

  it('an agent step with no model account says where model accounts are connected — dry and live alike', async () => {
    const [step] = stepsRunningAsAccounts({ nodes: [node('think', 'orchestr:agent', {})] });
    const decision = await decideRunAs(step!, { externalUserId: RUNNER }, store());
    expect(decision).toMatchObject({
      kind: 'refused',
      reason: 'none',
      message:
        'Step "think step" has no Claude account to run as — connect one under Integrations → "Use your own credentials" → Claude. The Anthropic key in Settings → Platform keys powers the AI composer only, not agent steps',
    });
  });

  it('a step whose action needs no account, or that no catalog knows, never runs as one — even one it names', () => {
    const steps = stepsRunningAsAccounts({
      nodes: [
        node('fetch', 'http.send_request', { connectionId: 'c1' }),
        node('join', 'text.concat', { connectionId: 'c2' }),
        node('mystery', 'nowhere.do_thing', { connectionId: 'c3' }),
        node('bare', 'nowhere.do_other'),
      ],
    });
    expect(steps).toEqual([]);
  });

  it('a dry run over types no catalog knows asks the store nothing, however many name an account', async () => {
    const accounts = store();
    const nodes = Array.from({ length: 500 }, (_, i) => node(`z${i}`, `z${i}.x`, { connectionId: 'c' }));

    const plan = await planForRunner({ nodes }, RUNNER, accounts);

    expect(plan).toEqual([]);
    expect(accounts.calls).toEqual([]);
  });

  it('survives a document that is not one', () => {
    for (const junk of [null, 'a string', 42, {}, { nodes: 'no' }, { nodes: [null, 7, { id: 'x' }] }]) {
      expect(stepsRunningAsAccounts(junk)).toEqual([]);
    }
  });

  it('a runner’s dry run reads the accounts serving every app in one lookup, however many apps it holds', async () => {
    const accounts = store({
      accounts: [
        { id: 'g1', provider: 'gmail' },
        { id: 's1', provider: 'slack' },
        { id: 'z1', provider: 'zoho' },
      ],
    });
    const plan = await planForRunner(
      {
        nodes: [
          node('a', 'gmail.send_email'),
          node('b', 'slack.send_channel_message'),
          node('c', 'github.list_issues'),
          node('d', 'orchestr:agent', { model: { provider: 'openai', model: 'gpt' } }),
        ],
      },
      RUNNER,
      accounts,
    );

    expect(plan.map((step) => [step.node_id, step.decision.kind, step.offered])).toEqual([
      ['a', 'account', ['g1']],
      ['b', 'account', ['s1']],
      ['c', 'refused', []],
      ['d', 'refused', []],
    ]);
    expect(accounts.calls.filter((call) => call.startsWith('serving:'))).toHaveLength(1);
  });

  it('a dry run decides every step with the same rule, asking the store once for every app', async () => {
    const accounts = store({ accounts: [{ id: 'g1', provider: 'gmail' }] });
    const plan = await planRunAs(
      {
        nodes: [
          node('a', 'gmail.send_email'),
          node('b', 'gmail.send_email'),
          node('c', 'slack.send_channel_message'),
        ],
      },
      { externalUserId: RUNNER },
      accounts,
    );
    expect(plan.map((step) => [step.node_id, step.decision.kind])).toEqual([
      ['a', 'account'],
      ['b', 'account'],
      ['c', 'refused'],
    ]);
    expect(accounts.calls).toEqual([`serving:${RUNNER}:gmail,slack`]);
  });

  it('a dry run reads every account the runner chose in one lookup, however many steps choose one', async () => {
    const accounts = store({ accounts: [{ id: 'g1', provider: 'gmail' }] });
    const nodes = Array.from({ length: 40 }, (_, i) =>
      node(`s${i}`, 'gmail.send_email', { connectionId: i % 2 === 0 ? 'g1' : `gone-${i}` }),
    );

    const plan = await planForRunner({ nodes }, RUNNER, accounts);

    expect(plan.filter((step) => step.decision.kind === 'account')).toHaveLength(20);
    expect(plan.filter((step) => step.decision.kind === 'refused')).toHaveLength(20);
    expect(accounts.calls.filter((call) => call.startsWith('own:'))).toHaveLength(1);
  });

  it('an environment plan reads no account the runner chose', async () => {
    const accounts = store({ slots: { 'env-1:gmail': 'slot-g' } });
    const plan = await planRunAs(
      { nodes: [node('a', 'gmail.send_email', { connectionId: 'g1' })] },
      { externalUserId: RUNNER, environmentId: 'env-1' },
      accounts,
    );

    expect(plan[0]!.decision).toMatchObject({ kind: 'account', connectionId: 'slot-g' });
    expect(accounts.calls.filter((call) => call.startsWith('own:'))).toEqual([]);
  });

  it('the plan for a runner names the accounts a pick may offer, asking the store once for both', async () => {
    const accounts = store({
      accounts: [
        { id: 'g1', provider: 'gmail' },
        { id: 'g2', provider: 'gmail' },
        { id: 'g3', provider: 'gmail', status: 'pending' },
      ],
    });
    const plan = await planForRunner(
      { nodes: [node('a', 'gmail.send_email', { connectionId: 'g2' }), node('b', 'gmail.send_email')] },
      RUNNER,
      accounts,
    );
    expect(plan.map((step) => [step.node_id, step.decision.kind, step.offered])).toEqual([
      ['a', 'account', ['g1', 'g2']],
      ['b', 'refused', ['g1', 'g2']],
    ]);
    expect(accounts.calls).toEqual([`own:${RUNNER}:g2`, `serving:${RUNNER}:gmail`]);
  });
});
