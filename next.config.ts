import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const useEmulators = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

// Firebase Auth and Firestore endpoints the browser talks to.
const connectSources = [
  "'self'",
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://firestore.googleapis.com",
  ...(useEmulators ? ["http://127.0.0.1:9099", "http://127.0.0.1:8080"] : []),
  ...(isDev ? ["ws://localhost:*", "ws://127.0.0.1:*"] : []),
];

// Static policy without nonces. Nonces require every page to render per
// request, which would give up the prerendered shell. 'unsafe-inline' for
// scripts is the cost; everything else is locked down. Reviewed in Milestone
// 10 and kept: the app renders no user or model text as HTML (no
// dangerouslySetInnerHTML anywhere), loads no third-party script, and
// connect-src limits where a script could send data.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src ${connectSources.join(" ")}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev || useEmulators ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
