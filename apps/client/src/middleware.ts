import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_SESSION_COOKIE } from "@/lib/localSession";

// Public routes — reachable without a session. Everything else is protected.
// Mirrors the AuthRoute/ProtectedRoute split in the source App.tsx: auth pages
// and OAuth callbacks are public; the app proper requires a signed-in session.
const PUBLIC_ROUTES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/sso-callback",
  "/integrations/callback",
  "/api/health", // platform liveness probe — must not redirect to /login
];

const isPublicRoute = createRouteMatcher(PUBLIC_ROUTES);
// An invitee on a self-hosted instance has no account yet, so the join page must serve them the
// registration form rather than bounce them to a sign-in they can't complete.
const isLocalPublicRoute = createRouteMatcher([...PUBLIC_ROUTES, "/join(.*)"]);

const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim());

function toLogin(req: NextRequest) {
  const loginUrl = new URL("/login", req.url);
  const returnTo = req.nextUrl.pathname + req.nextUrl.search;
  if (returnTo && returnTo !== "/") loginUrl.searchParams.set("redirect_url", returnTo);
  return NextResponse.redirect(loginUrl);
}

// A UX gate only — presence, never validity: the service verifies the token on every call.
const hasLocalSession = (req: NextRequest) => Boolean(req.cookies.get(LOCAL_SESSION_COOKIE)?.value);

// No Clerk key = a self-hosted instance that signs in with email + password; calling clerkMiddleware
// at all would throw on the missing key.
function localMiddleware(req: NextRequest) {
  if (isLocalPublicRoute(req) || hasLocalSession(req)) return;
  return toLogin(req);
}

const clerkGate = clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req) || hasLocalSession(req)) return;

  // This app uses Clerk *headless* flows with its own /login (not Clerk's hosted
  // portal), so redirect signed-out users to /login ourselves rather than
  // auth.protect() (which rewrites to the hosted Account Portal → a 404 here).
  // Faithful to the source's <ProtectedRoute> → <Navigate to="/login">.
  const { userId } = await auth();
  if (!userId) return toLogin(req);
});

export default clerkConfigured ? clerkGate : localMiddleware;

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
