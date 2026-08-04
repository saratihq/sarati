// Test-only defaults, loaded via jest `setupFiles`. Specs hit a local HTTP server, so they opt
// loopback back past the SDK's SSRF guard via the operator allowlist. NEVER set this in production.
if (!process.env.ORCHESTR_HTTP_ALLOWED_HOSTS) {
  process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = '127.0.0.1,localhost';
}
