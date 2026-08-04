import { SetMetadata } from '@nestjs/common';

import type { ApiScope } from './scopes';

export const SCOPE_METADATA = 'orchestr:required-scope';

/**
 * Required on every authenticated route — unannotated routes deny API keys (ADR 0051).
 * Several scopes mean ANY of them satisfies the route: a door that leads to different rooms, where
 * what the caller may do once inside is enforced beyond it.
 */
export const Scope = (...scopes: [ApiScope, ...ApiScope[]]): MethodDecorator & ClassDecorator =>
  SetMetadata(SCOPE_METADATA, scopes);
