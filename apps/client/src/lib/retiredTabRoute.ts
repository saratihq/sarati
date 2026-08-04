import { redirect } from "next/navigation";

/** Props Next hands a retired `/workflows/[id]/<tab>` page. */
export interface RetiredTabRouteProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Retired tab routes all land on the one-page overview; the query is preserved so deep links keep working. */
export async function redirectToOverview({ params, searchParams }: RetiredTabRouteProps): Promise<never> {
  const { id } = await params;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else if (value !== undefined) {
      qs.set(key, value);
    }
  }
  const query = qs.toString();
  redirect(`/workflows/${id}/overview${query ? `?${query}` : ""}`);
}
