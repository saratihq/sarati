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
      components: {
        // The website's two-state sun/moon toggle, in place of the three-option select.
        ThemeSelect: './src/components/ThemeSelect.astro',
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
            { label: 'API keys', slug: 'agents/api-keys' },
          ],
        },
      ],
    }),
  ],
});
