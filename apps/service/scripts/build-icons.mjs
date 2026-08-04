// Regenerate data/app-icons.json from self-hosted, full-colour brand marks.
// Run from apps/service:  node scripts/build-icons.mjs
//
// Sources are resolved per slug in order (Iconify `logos` → simple-icons →
// monogram tile rendered client-side). Marks are emitted UNMODIFIED, in their own
// colours — the only form brand guidelines sanction; see TRADEMARKS.md and
// data/ICON_CREDITS.md for provenance. Removing a brand is one map edit.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as simpleIcons from 'simple-icons';

const require = createRequire(import.meta.url);
const logosSet = require('@iconify-json/logos/icons.json');

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'app-icons.json');

// Every slug MUST resolve to logos-mapped, si-mapped, omit-utility or monogram —
// asserted at the end, so a new slug appearing unhandled fails the build.
const ALL_SOURCE_SLUGS = [
  'http',
  'text',
  'date',
  'rss',
  'slack',
  'sheets',
  'gmail',
  'airtable',
  'apify',
  'apitable',
  'asana',
  'ashby',
  'azure-openai',
  'bamboohr',
  'baserow',
  'bigquery',
  'binance',
  'calendar',
  'calendly',
  'claude',
  'clickup',
  'clockify',
  'convertkit',
  'crypto',
  'csv',
  'customerio',
  'data-mapper',
  'datadog',
  'discord',
  'docs',
  'docusign',
  'drip',
  'drive',
  'dropbox',
  'elevenlabs',
  'excel',
  'facebook-pages',
  'figma',
  'forms',
  'gcs',
  'gemini',
  'github',
  'google-chat',
  'graphql',
  'hackernews',
  'hubspot',
  'imap',
  'instagram',
  'intercom',
  'jira',
  'jotform',
  'json',
  'linear',
  'linkedin',
  'mailchimp',
  'mastodon',
  'math',
  'metabase',
  'mistral',
  'ms-todo',
  'mysql',
  'notion',
  'ntfy',
  'onedrive',
  'openai',
  'openrouter',
  'outlook',
  'outlook-calendar',
  'pdf',
  'perplexity',
  'pipedrive',
  'postgres',
  'power-bi',
  'qrcode',
  'resend',
  's3',
  'salesforce',
  'sendgrid',
  'servicenow',
  'ses',
  'sftp',
  'sharepoint',
  'shopify',
  'slides',
  'smtp',
  'snowflake',
  'sns',
  'sqs',
  'stripe',
  'supabase',
  'surveymonkey',
  'tally',
  'tasks',
  'teams',
  'telegram',
  'todoist',
  'trello',
  'twilio',
  'twitter',
  'typeform',
  'whatsapp',
  'wordpress',
  'xml',
  'youtube',
  'zendesk',
  'zoho-crm',
  'zoom',
];

// Non-brand slugs: rendered client-side as lucide glyphs, never an app logo.
const OMIT_UTILITY = new Set([
  'http',
  'text',
  'date',
  'json',
  'csv',
  'crypto',
  'math',
  'pdf',
  'qrcode',
  'xml',
  'rss',
  'smtp',
  'sftp',
  'data-mapper',
  'graphql',
  'imap',
]);

// Primary: our app slug -> Iconify `logos` icon name. The `-icon` variants are the
// square marks that fit a tile; the bare name is usually the wide wordmark.
const LOGOS_MAP = {
  slack: 'slack-icon',
  gmail: 'google-gmail',
  airtable: 'airtable',
  asana: 'asana',
  'azure-openai': 'microsoft-azure', // Azure OpenAI is an Azure service
  calendar: 'google-calendar',
  claude: 'claude',
  customerio: 'customerio-icon',
  datadog: 'datadog',
  discord: 'discord-icon',
  drip: 'drip',
  drive: 'google-drive',
  dropbox: 'dropbox',
  'facebook-pages': 'facebook',
  figma: 'figma',
  gcs: 'google-cloud', // Google Cloud Storage
  gemini: 'google-gemini',
  github: 'github-icon',
  'google-chat': 'google-gsuite',
  hackernews: 'ycombinator', // Hacker News is a Y Combinator property
  hubspot: 'hubspot',
  instagram: 'instagram',
  intercom: 'intercom',
  jira: 'jira',
  linear: 'linear',
  linkedin: 'linkedin-icon',
  mailchimp: 'mailchimp',
  mastodon: 'mastodon',
  metabase: 'metabase',
  mistral: 'mistral-ai',
  mysql: 'mysql',
  notion: 'notion-icon',
  onedrive: 'microsoft-onedrive',
  openai: 'openai-icon',
  perplexity: 'perplexity',
  pipedrive: 'pipedrive',
  'power-bi': 'microsoft-power-bi',
  s3: 'aws-s3',
  salesforce: 'salesforce',
  sendgrid: 'sendgrid-icon',
  ses: 'aws-ses',
  shopify: 'shopify',
  snowflake: 'snowflake',
  sns: 'aws-sns',
  sqs: 'aws-sqs',
  stripe: 'stripe',
  supabase: 'supabase',
  teams: 'microsoft-teams',
  telegram: 'telegram',
  todoist: 'todoist',
  trello: 'trello',
  twilio: 'twilio-icon',
  twitter: 'twitter',
  typeform: 'typeform',
  whatsapp: 'whatsapp',
  wordpress: 'wordpress',
  youtube: 'youtube',
  zendesk: 'zendesk',
  'zoho-crm': 'zoho',
  zoom: 'zoom',
};

// Fallback: our app slug -> simple-icons export slug, for brands `logos` lacks.
const SI_MAP = {
  sheets: 'googlesheets',
  docs: 'googledocs',
  forms: 'googleforms',
  slides: 'googleslides',
  tasks: 'googletasks',
  bigquery: 'googlebigquery',
  baserow: 'baserow',
  binance: 'binance',
  calendly: 'calendly',
  clickup: 'clickup',
  clockify: 'clockify',
  convertkit: 'kit', // ConvertKit rebranded to Kit
  elevenlabs: 'elevenlabs',
  ntfy: 'ntfy',
  openrouter: 'openrouter',
  postgres: 'postgresql',
  resend: 'resend',
  surveymonkey: 'surveymonkey',
};

/** simple-icons export key for a slug: `si` + slug with first char uppercased. */
const siExportKey = (slug) => `si${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;

/** Full-colour inline SVG for an Iconify `logos` icon, sized by viewBox for CSS control. */
function logosSvg(name) {
  const icon = logosSet.icons[name];
  if (!icon) throw new Error(`@iconify-json/logos lacks icon "${name}" in this version`);
  const w = icon.width ?? logosSet.width ?? 24;
  const h = icon.height ?? logosSet.height ?? 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${icon.body}</svg>`;
}

/** Single brand-colour inline SVG for a simple-icons slug (its own `#hex`). */
function siSvg(slug) {
  const icon = simpleIcons[siExportKey(slug)];
  if (!icon) throw new Error(`simple-icons lacks slug "${slug}" (${siExportKey(slug)}) in this version`);
  return `<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#${icon.hex}"><path d="${icon.path}"/></svg>`;
}

// ── Build ──────────────────────────────────────────────────────────────────
const out = {};
const brandSlugs = ALL_SOURCE_SLUGS.filter((s) => !OMIT_UTILITY.has(s));
const bySource = { logos: [], si: [], monogram: [] };
for (const slug of brandSlugs) {
  if (LOGOS_MAP[slug]) {
    out[slug] = logosSvg(LOGOS_MAP[slug]);
    bySource.logos.push(slug);
  } else if (SI_MAP[slug]) {
    out[slug] = siSvg(SI_MAP[slug]);
    bySource.si.push(slug);
  } else {
    bySource.monogram.push(slug); // no self-hosted source → client monogram tile
  }
}

// Deterministic, sorted output.
const sorted = Object.fromEntries(
  Object.keys(out)
    .sort()
    .map((k) => [k, out[k]]),
);
writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);

// ── Report + guards ──────────────────────────────────────────────────────────
const omittedUtility = ALL_SOURCE_SLUGS.filter((s) => OMIT_UTILITY.has(s));

// Every source slug is accounted for (logos xor si xor utility xor monogram).
const accounted =
  bySource.logos.length + bySource.si.length + omittedUtility.length + bySource.monogram.length;
if (accounted !== ALL_SOURCE_SLUGS.length) {
  throw new Error(`Accounted ${accounted} != ${ALL_SOURCE_SLUGS.length} source slugs`);
}
// No MAPPING strays outside the shipped slug set.
for (const [name, map] of [
  ['LOGOS_MAP', LOGOS_MAP],
  ['SI_MAP', SI_MAP],
]) {
  const stray = Object.keys(map).filter((s) => !ALL_SOURCE_SLUGS.includes(s));
  if (stray.length) throw new Error(`${name} has slugs not in ALL_SOURCE_SLUGS: ${stray.join(', ')}`);
}
// Output sanity: pure inline SVG, no CDN residue, no active content.
const values = Object.values(sorted);
if (!values.every((v) => v.startsWith('<svg'))) throw new Error('Non-<svg value in output');
const blob = JSON.stringify(sorted);
if (/activepieces|cdn\.activepieces/i.test(blob)) throw new Error('CDN residue in output');
if (/<script|onload=|onerror=|javascript:/i.test(blob)) throw new Error('Active content in an SVG value');

console.log(`Wrote ${OUT}`);
console.log(`Full-colour (Iconify logos): ${bySource.logos.length}`);
console.log(`Brand-colour (simple-icons): ${bySource.si.length} — ${bySource.si.join(', ')}`);
console.log(`Utility/non-brand → lucide (${omittedUtility.length}): ${omittedUtility.join(', ')}`);
console.log(
  `Monogram tile — no self-hosted source (${bySource.monogram.length}): ${bySource.monogram.join(', ')}`,
);
console.log(`Accounted: ${accounted} / ${ALL_SOURCE_SLUGS.length}`);
