/** The app part of a public `<app>.<name>` type, as a pattern fragment — every app-slug check builds on it. */
export const APP_SLUG = '[a-z][a-z0-9_-]*';

const APP_SLUG_RE = new RegExp(`^${APP_SLUG}$`);

/** Whether `slug` can name an app in a public `<app>.<name>` type. */
export function isAppSlug(slug: string): boolean {
  return APP_SLUG_RE.test(slug);
}
