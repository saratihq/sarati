import { redirectToOverview, type RetiredTabRouteProps } from "@/lib/retiredTabRoute";

export default async function Page(props: RetiredTabRouteProps) {
  await redirectToOverview(props);
}
