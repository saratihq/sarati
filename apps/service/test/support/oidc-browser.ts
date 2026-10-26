/** What the identity provider sent the browser back with. */
export interface Callback {
  code: string | null;
  state: string | null;
  iss: string | null;
  error: string | null;
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function hiddenFields(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/?>/g)].map((m) => [
      m[1]!,
      unescapeHtml(m[2]!),
    ]),
  );
}

/** A browser as far as a provider can tell: one cookie jar, redirects followed by hand, its own sign-in and consent pages submitted — no back door. */
export class OidcBrowser {
  private readonly cookies = new Map<string, string>();

  /** Walk an authorization URL through the provider until it redirects to `redirectUri`, signing in as `login`. */
  async authorize(
    authorizeUrl: string,
    redirectUri: string,
    login: string,
    opts: { deny?: boolean } = {},
  ): Promise<Callback> {
    let url = authorizeUrl;
    for (let hop = 0; hop < 20; hop++) {
      if (url.startsWith(redirectUri)) {
        const params = new URL(url).searchParams;
        return {
          code: params.get('code'),
          state: params.get('state'),
          iss: params.get('iss'),
          error: params.get('error'),
        };
      }
      const res = await this.fetch(url);
      if (res.status >= 300 && res.status < 400) {
        url = new URL(res.headers.get('location') ?? '', url).toString();
        continue;
      }
      const html = await res.text();
      const selfSubmitting = /<form method="post" action="([^"]+)">/.exec(html);
      if (res.status === 200 && selfSubmitting) {
        url = await this.submit(new URL(unescapeHtml(selfSubmitting[1]!), url), hiddenFields(html));
        continue;
      }
      const form = /<form[^>]*action="([^"]+)"[^>]*method="post"/.exec(html);
      const prompt = /name="prompt" value="(\w+)"/.exec(html);
      if (res.status !== 200 || !form || !prompt) {
        throw new Error(`the provider answered ${res.status} at ${url}: ${html.slice(0, 400)}`);
      }
      const action = new URL(unescapeHtml(form[1]!), url);
      if (opts.deny) {
        url = new URL(`${action.pathname}/abort`, url).toString();
        continue;
      }
      const fields: Record<string, string> =
        prompt[1] === 'login' ? { prompt: 'login', login, password: 'any password' } : { prompt: prompt[1]! };
      url = await this.submit(action, fields);
    }
    throw new Error('the provider never redirected back');
  }

  private async submit(action: URL, fields: Record<string, string>): Promise<string> {
    const submitted = await this.fetch(action.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    if (submitted.status < 300 || submitted.status >= 400) {
      throw new Error(
        `the provider answered ${submitted.status} to the form at ${action.pathname}: ${(await submitted.text()).slice(0, 400)}`,
      );
    }
    return new URL(submitted.headers.get('location') ?? '', action).toString();
  }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=.*1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
}
