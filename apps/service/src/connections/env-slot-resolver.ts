import { DomainError } from '../common/domain-error';

/**
 * The env scope a run carries: `environmentId` is THE resolution key, `environment` is the NAME and,
 * with `orgId`, the LEGACY pre-006 cluster key. All unset = a Default run on the personal pool.
 */
export interface EnvScope {
  environment?: string | null;
  environmentId?: string | null;
  orgId?: string | null;
}

/** A resolved env slot: the pool connection it references + the OWNER the run must run AS. */
export interface EnvSlot {
  connectionId: string;
  ownerUserId: string;
}

/** A row from the connection store — the pool connection's id + its owning user. */
interface StoredConnectionRef {
  id: string;
  ownerUserId: string;
}

/** The structural slice of ConnectionsService this resolver needs — an interface, so it stays free of a service import. */
export interface EnvSlotResolvers {
  resolveSlotConnection(environmentId: string, app: string): Promise<StoredConnectionRef | null>;
  resolveClusterConnection(
    orgId: string,
    environment: string,
    app: string,
  ): Promise<StoredConnectionRef | null>;
}

/**
 * THE env-slot decision, shared by every in-process rail so a model call resolves exactly like an action:
 * `null` when the run isn't env-scoped, a SLOT the caller rebinds to AND runs AS the owner of, or a hard 428 when
 * the slot is empty — NEVER a silent fall back to anyone's personal pool.
 */
export async function resolveEnvSlotConnection(
  resolvers: EnvSlotResolvers,
  env: EnvScope,
  appSlug: string,
): Promise<EnvSlot | null> {
  let slot: StoredConnectionRef | null;
  if (env.environmentId) {
    slot = await resolvers.resolveSlotConnection(env.environmentId, appSlug);
  } else if (env.environment && env.orgId) {
    slot = await resolvers.resolveClusterConnection(env.orgId, env.environment, appSlug);
  } else {
    return null; // Default run — not env-scoped; the personal pool, untouched
  }
  if (!slot) {
    const envName = env.environment ?? 'selected';
    throw new DomainError(
      `No "${appSlug}" connection in the ${envName} environment — an owner must assign one to the ${envName} environment's ${appSlug} slot before running here`,
      428,
    );
  }
  return { connectionId: slot.id, ownerUserId: slot.ownerUserId };
}
