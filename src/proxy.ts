import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic auth redirect only: no cookie → /login. Real session validation
 * happens server-side in requireUser(); this just avoids rendering app pages
 * for obviously signed-out visitors.
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.has("pf_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Webhooks, agent and MCP endpoints authenticate themselves and must never redirect.
  matcher: ["/((?!login|api/|_next/|favicon.ico).*)"],
};
