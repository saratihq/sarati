// Test-only defaults, loaded via jest `setupFiles`. Specs hit a local HTTP server, so they opt
// loopback back past the SDK's SSRF guard via the operator allowlist. NEVER set this in production.
if (!process.env.ORCHESTR_HTTP_ALLOWED_HOSTS) {
  process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
}

// Encryption fails open without a key, so a machine that happens to have apps/service/.env would
// assert against real Fernet while CI asserted against plaintext. Pinning it here makes the
// at-rest tests mean the same thing everywhere.
if (!process.env.FERNET_KEY) {
  process.env.FERNET_KEY = Buffer.from('sarati-test-only-fernet-key!!!!!').toString('base64');
}
