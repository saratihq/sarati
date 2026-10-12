-- 032 — an activation records the intake URL a provider was told to deliver to, so a changed URL registers again.
-- A live webhook carries over the URL its registration record already holds, so 032 re-registers nothing recorded; a row
-- with no such record keeps NULL and is registered once more. Idempotent: db:migrate re-runs every file.

ALTER TABLE runtime_trigger_activations ADD COLUMN IF NOT EXISTS webhook_url text;

UPDATE runtime_trigger_activations a
   SET webhook_url = s.value ->> 'webhookUrl',
       materialized = a.materialized || jsonb_build_object('webhookUrl', s.value ->> 'webhookUrl')
  FROM runtime_activation_store s
 WHERE s.activation_id = a.id
   AND s.key = 'webhook.registration'
   AND a.kind = 'registered_webhook'
   AND a.webhook_url IS NULL
   AND a.materialized IS NOT NULL
   AND NOT (a.materialized ? 'webhookUrl')
   AND s.value ->> 'webhookUrl' IS NOT NULL;
