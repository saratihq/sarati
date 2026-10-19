import { DomainError } from '../common/domain-error';
import type { RunAsAccounts } from '../connections/run-as-account';
import { assertEnvSlotsCover, stepsRefusedIn } from './env-slot-preflight';

const staging = { id: 'env-staging', name: 'staging' };

// Only slots matter under an environment; anything else asked of the store is a bug.
function slots(
  filled: Record<string, string>,
  inactive: string[] = [],
  heldFor: Record<string, string> = {},
  oneClick: string[] = [],
): RunAsAccounts {
  const unused = (): Promise<never> => Promise.reject(new Error('an environment run never asks the runner'));
  return {
    resolveSlotConnection: (_env, app) => {
      const id = filled[app];
      const status = inactive.includes(app) ? 'expired' : 'active';
      const provider = heldFor[app] ?? app;
      const managed = oneClick.includes(app);
      return Promise.resolve(id ? { id, ownerUserId: 'owner', status, provider, managed } : null);
    },
    resolveClusterConnection: unused,
    environmentNameOf: () => Promise.resolve(staging.name),
    ownConnections: unused,
    accountsServing: unused,
  };
}

const node = (id: string, node_type: string, parameters: Record<string, unknown> = {}) => ({
  id,
  name: id,
  node_type,
  parameters,
});

const document = {
  nodes: [
    node('trigger', 'orchestr:webhook'),
    node('think', 'orchestr:agent', { model: { provider: 'claude', model: 'x' } }),
    node('post', 'slack.send_channel_message', { connectionId: 'c3' }),
    node('mail', 'gmail.send_email'),
    node('fetch', 'http.send_request', { url: 'https://example.com' }),
  ],
};

describe('env slot preflight — the run-as rule, dry, under an environment', () => {
  it('names every step a run there would refuse, chosen account or not', async () => {
    const missing = await stepsRefusedIn(document, staging, slots({}));
    expect(missing.map((step) => [step.node_id, step.app])).toEqual([
      ['think', 'claude'],
      ['post', 'slack'],
      ['mail', 'gmail'],
    ]);
  });

  it('refuses with a 428 naming the environment, the apps — each by its slug — and the steps', async () => {
    const err = await assertEnvSlotsCover(document, staging, slots({ slack: 's1' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).status).toBe(428);
    expect((err as DomainError).message).toBe(
      'staging has no claude or gmail account assigned, so "think" and "mail" can\'t run there — assign them under Integrations → Environments before promoting here',
    );
    expect((err as DomainError).details).toMatchObject({
      code: 'environment_slots_empty',
      environment: 'staging',
      apps: ['claude', 'gmail'],
    });
  });

  it('refuses a slot whose account is not active, naming it apart from an empty one', async () => {
    const inactive = await assertEnvSlotsCover(
      document,
      staging,
      slots({ claude: 'c', slack: 's', gmail: 'g' }, ['gmail']),
    ).catch((e: unknown) => e);
    expect((inactive as DomainError).status).toBe(428);
    expect((inactive as DomainError).message).toBe(
      "staging's gmail account isn't active, so \"mail\" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments before promoting here",
    );
    expect((inactive as DomainError).details).toMatchObject({
      code: 'environment_slots_inactive',
      apps: ['gmail'],
      steps: [{ node_id: 'mail', reason: 'inactive_slot' }],
    });

    const several = await assertEnvSlotsCover(
      document,
      staging,
      slots({ claude: 'c', slack: 's', gmail: 'g' }, ['gmail', 'slack']),
    ).catch((e: unknown) => e);
    expect((several as DomainError).message).toBe(
      'staging\'s gmail and slack accounts aren\'t active, so "post" and "mail" can\'t run there — their owners reconnect them under Integrations, or an owner reassigns the slots under Integrations → Environments before promoting here',
    );

    const both = await assertEnvSlotsCover(
      document,
      staging,
      slots({ slack: 's', gmail: 'g' }, ['gmail']),
    ).catch((e: unknown) => e);
    expect((both as DomainError).message).toBe(
      'staging has no claude account assigned, so "think" can\'t run there; staging\'s gmail account isn\'t active, so "mail" can\'t run there — assign or reassign them under Integrations → Environments before promoting here',
    );
    expect((both as DomainError).details).toMatchObject({
      code: 'environment_slots_empty',
      apps: ['claude', 'gmail'],
    });
  });

  it('refuses a slot whose account can’t serve its steps, saying why, apart from empty and inactive ones', async () => {
    const reminding = {
      nodes: [
        ...document.nodes,
        node('remind', 'slack.create_a_reminder', { text: 'x', time: 'in 5 minutes' }),
      ],
    };
    const err = await assertEnvSlotsCover(
      reminding,
      staging,
      slots({ claude: 'c', slack: 's', gmail: 'g' }, [], { gmail: 'slack' }),
    ).catch((e: unknown) => e);
    expect((err as DomainError).message).toBe(
      'staging\'s gmail account is for another app, so "mail" can\'t run there; staging\'s slack account uses its own credentials, and "remind" runs only on a one-click (managed) one, so it can\'t run there — reassign them under Integrations → Environments before promoting here',
    );
    expect((err as DomainError).details).toMatchObject({
      code: 'environment_slots_unfit',
      apps: ['gmail', 'slack'],
      steps: [
        { node_id: 'mail', reason: 'wrong_app_slot' },
        { node_id: 'remind', reason: 'needs_managed_slot' },
      ],
    });

    const withEmpty = await assertEnvSlotsCover(
      document,
      staging,
      slots({ slack: 's', gmail: 'g' }, [], { gmail: 'slack' }),
    ).catch((e: unknown) => e);
    expect((withEmpty as DomainError).message).toMatch(/ — assign or reassign them under Integrations/);
  });

  describe("an app trigger's slot, which its activation listens as", () => {
    const covered = { claude: 'c', slack: 's', gmail: 'g' };
    const watching = (parameters: Record<string, unknown>) => ({
      nodes: [
        { ...node('watch', 'asana.new_task', parameters), metadata: { trigger: true } },
        ...document.nodes.slice(1),
      ],
    });

    it('refuses a promote whose trigger names an account and finds its app with no slot, in its own words, before its steps', async () => {
      const err = await assertEnvSlotsCover(
        watching({ connectionId: 'a1' }),
        staging,
        slots({ slack: 's' }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).status).toBe(428);
      expect((err as DomainError).message).toBe(
        "The staging environment has no connection for asana — assign it to staging's slot before promoting here",
      );
      expect((err as DomainError).details).toBeUndefined();
    });

    it('asks only that the slot is filled, and nothing of a trigger naming no account', async () => {
      await expect(
        assertEnvSlotsCover(
          watching({ connectionId: 'a1' }),
          staging,
          slots({ ...covered, asana: 'a' }, ['asana']),
        ),
      ).resolves.toBeUndefined();
      await expect(assertEnvSlotsCover(watching({}), staging, slots(covered))).resolves.toBeUndefined();
    });

    it('never holds a branch test to a trigger, which the test does not stand up', async () => {
      await expect(
        stepsRefusedIn(watching({ connectionId: 'a1' }), staging, slots(covered)),
      ).resolves.toEqual([]);
    });
  });

  it('passes once every slot the version needs is filled', async () => {
    await expect(
      assertEnvSlotsCover(document, staging, slots({ claude: 'c', slack: 's', gmail: 'g' })),
    ).resolves.toBeUndefined();
  });
});
