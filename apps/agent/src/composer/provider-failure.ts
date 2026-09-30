import type { SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';

const GENERIC_ERROR = 'The composer hit a problem — please try again.';

const REPLACE_KEY = 'under Settings → Platform keys — a new key takes effect straight away';
const RETRY = 'Wait a minute, then send the message again.';

/** What the person can do about each way the model provider refuses a turn. */
const ACTIONABLE: Partial<Record<SDKAssistantMessageError, (model: string) => string>> = {
  authentication_failed: () =>
    `Anthropic rejected the API key saved for the composer. Replace it ${REPLACE_KEY}.`,
  billing_error: () =>
    `The Anthropic account behind the composer's API key is out of credit. Add credit to that account, or replace the key ${REPLACE_KEY}.`,
  rate_limit: () => `Anthropic is rate-limiting the composer's API key. ${RETRY}`,
  overloaded: () => `Anthropic is overloaded right now. ${RETRY}`,
  server_error: () => `Anthropic returned a server error. ${RETRY}`,
  model_not_found: (model) =>
    `The composer's model (${model}) is not available to the saved Anthropic API key. Set COMPOSER_MODEL to a model the key can use, or replace the key ${REPLACE_KEY}.`,
};

/** The sentence shown for a turn the provider refused; the generic one when the reason has no remedy of its own. */
export function providerFailureMessage(error: SDKAssistantMessageError | null, model: string): string {
  return (error && ACTIONABLE[error]?.(model)) ?? GENERIC_ERROR;
}
