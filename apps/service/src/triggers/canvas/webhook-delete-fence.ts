import { type RegisteredWebhook, sameRegistration } from '../registered-webhook';

interface InFlightDelete {
  webhook: RegisteredWebhook;
  landed: Promise<void>;
}

/** Runs retried webhook deletes beside stand-ups, so only a stand-up handed a handle being deleted waits, then registers again. In-process only. */
export class WebhookDeleteFence {
  private readonly deletes = new Set<InFlightDelete>();
  // Per running stand-up, the deletes that finished while it ran.
  private readonly standUps = new Set<RegisteredWebhook[]>();

  /** Runs `retry` (its held check, then the delete) where every stand-up it overlaps sees it. */
  async deleting<T>(webhook: RegisteredWebhook, retry: () => Promise<T>): Promise<T> {
    let landed = (): void => undefined;
    const entry: InFlightDelete = { webhook, landed: new Promise<void>((resolve) => (landed = resolve)) };
    this.deletes.add(entry);
    try {
      return await retry();
    } finally {
      this.deletes.delete(entry);
      for (const finished of this.standUps) finished.push(webhook);
      landed();
    }
  }

  /** Runs `register` (the app call, then its record) until no delete of the handle it returns can land after it. */
  async standUp(register: () => Promise<RegisteredWebhook | null>): Promise<void> {
    const finished: RegisteredWebhook[] = [];
    this.standUps.add(finished);
    try {
      for (;;) {
        const webhook = await register();
        if (!webhook) return;
        const inFlight = [...this.deletes].filter((d) => sameRegistration(d.webhook, webhook));
        if (inFlight.length === 0 && !finished.some((w) => sameRegistration(w, webhook))) return;
        await Promise.all(inFlight.map((d) => d.landed));
        finished.length = 0;
      }
    } finally {
      this.standUps.delete(finished);
    }
  }
}
