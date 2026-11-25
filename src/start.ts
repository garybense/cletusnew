import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

function expectedOrigins(request: Request): Set<string> {
  const out = new Set<string>();
  try {
    out.add(new URL(request.url).origin);
  } catch {
    /* ignore */
  }
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (host) {
    if (proto) out.add(`${proto}://${host}`);
    out.add(`https://${host}`);
    out.add(`http://${host}`);
  }
  return out;
}

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  secFetchSite: ["same-origin", "none"],
  origin: (origin, ctx) => expectedOrigins(ctx.request).has(origin),
  referer: (referer, ctx) => {
    try {
      return expectedOrigins(ctx.request).has(new URL(referer).origin);
    } catch {
      return false;
    }
  },
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
