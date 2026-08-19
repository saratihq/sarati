import { Injectable } from '@nestjs/common';

/** The plans seam: every limit point asks here, so core never learns about plans or billing. */
export interface EntitlementsProvider {
  /** Feature gate: may this org use `feature` at all? */
  allows(orgId: string, feature: string): Promise<boolean>;
  /** Numeric limit for a metric, or null = unlimited. */
  limitFor(orgId: string, metric: string): Promise<number | null>;
}

export const ENTITLEMENTS_PROVIDER = Symbol('ENTITLEMENTS_PROVIDER');

@Injectable()
export class UnlimitedEntitlements implements EntitlementsProvider {
  allows(): Promise<boolean> {
    return Promise.resolve(true);
  }

  limitFor(): Promise<number | null> {
    return Promise.resolve(null);
  }
}
