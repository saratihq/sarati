-- 022 — inbound idempotency for the Composio webhook rail.
--
-- Webhook delivery is at-least-once BY CONTRACT: the same Svix message
-- (`webhook-id` header, stable across retries and duplicate sends) can arrive many
-- times, and one event delivered four times fired four complete runs — four emails
-- sent, four tasks created.
--
-- This table is the claim ledger: the intake inserts the id BEFORE firing, and a
-- conflict means "already handled" → ack without firing. Rows are pruned on a TTL
-- far longer than any provider's retry window.
CREATE TABLE IF NOT EXISTS composio_webhook_deliveries (
  webhook_id  text PRIMARY KEY,
  trigger_id  text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Prune scan: the TTL sweep deletes by age.
CREATE INDEX IF NOT EXISTS idx_composio_webhook_deliveries_received_at
  ON composio_webhook_deliveries (received_at);
