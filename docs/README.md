# docs.sarati.io

The public documentation. Astro + Starlight, plain Markdown in `src/content/docs/`.

Deliberately **outside the pnpm workspace**: it carries its own lockfile so an Astro upgrade can
never touch what the product installs, and the root `pnpm check` stays as fast as it is. CI builds
it separately ([`.github/workflows/docs.yml`](../.github/workflows/docs.yml)).

## Change a page

Edit the Markdown and open a pull request. Nothing to install for a prose change.

## Run it

```bash
cd docs && pnpm install --ignore-workspace
pnpm dev            # http://localhost:4321
```

```bash
pnpm check          # types + build — what CI runs
```

## Where things live

| | |
|---|---|
| `src/content/docs/` | Every page. The file path is the URL. |
| `astro.config.mjs` | The sidebar. A new page needs an entry here. |
| `src/styles/docs.css` | The accent colour, for both themes. |

## The rule

**Every instruction in here has been run against a real instance.** Not "should work" — actually
run, in order, from the state a new user is in. If a step is wrong or a screen does not match, fix
the page or fix the product.

Both themes ship, so anything visual has to read correctly in each.
