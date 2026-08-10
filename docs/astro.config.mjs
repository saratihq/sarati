import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.sarati.io',
  integrations: [
    starlight({
      title: 'Sarati',
      description:
        'Build automations on a canvas. Branch, review and merge them like code. Run them on an engine that survives a restart.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/saratihq/sarati' },
      ],
      editLink: {
        baseUrl: 'https://github.com/saratihq/sarati/edit/main/docs/',
      },
      customCss: ['./src/styles/docs.css'],
      // Installed by hand: Cloudflare's automatic injection never reaches a Worker's responses,
      // so the zone-level Web Analytics setting alone measures nothing here.
      head: [
        {
          tag: 'script',
          attrs: {
            type: 'module',
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            'data-cf-beacon': '{"token": "599dff5b1fa943b9b2362cbe0c323b40"}',
          },
        },
      ],
      components: {
        // The website's two-state sun/moon toggle, in place of the three-option select.
        ThemeSelect: './src/components/ThemeSelect.astro',
        // Adds the way back to the product site, which the default title has no room for.
        SiteTitle: './src/components/SiteTitle.astro',
      },
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Install', slug: 'start/install' },
            { label: 'Your first workflow', slug: 'start/first-workflow' },
            { label: 'How Sarati works', slug: 'start/how-it-works' },
          ],
        },
        {
          label: 'Build',
          items: [
            { label: 'The canvas', slug: 'build/canvas' },
            { label: 'Triggers', slug: 'build/triggers' },
            { label: 'Steps', slug: 'build/steps' },
            { label: 'Connections', slug: 'build/connections' },
            { label: 'Data between steps', slug: 'build/data' },
            { label: 'Test as you build', slug: 'build/testing' },
          ],
        },
        {
          label: 'Version control',
          items: [
            { label: 'Branches', slug: 'version-control/branches' },
            { label: 'Save, version, publish', slug: 'version-control/save-version-publish' },
            { label: 'Compare versions', slug: 'version-control/compare' },
            { label: 'Reviews', slug: 'version-control/reviews' },
            { label: 'Merge conflicts', slug: 'version-control/conflicts' },
          ],
        },
        {
          label: 'Run',
          items: [
            { label: 'Environments', slug: 'run/environments' },
            { label: 'Runs', slug: 'run/runs' },
            { label: 'Approvals', slug: 'run/approvals' },
          ],
        },
        {
          label: 'Agents & API',
          items: [
            { label: 'MCP for agents', slug: 'agents/mcp' },
            { label: 'The AI composer', slug: 'agents/ai-composer' },
            { label: 'API keys', slug: 'agents/api-keys' },
          ],
        },
        {
          label: 'Operate',
          items: [
            { label: 'Configuration', slug: 'operate/configuration' },
            { label: 'Users and organizations', slug: 'operate/users' },
            { label: 'Upgrades and backups', slug: 'operate/upgrades' },
            { label: 'Troubleshooting', slug: 'operate/troubleshooting' },
          ],
        },
      ],
    }),
  ],
});
