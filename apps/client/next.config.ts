import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server output for container/Railway deploys (smaller runtime,
  // no need to ship node_modules). `next start` continues to work locally.
  output: "standalone",
  // The single sign-on callback URL carries the provider's one-time code.
  async headers() {
    return [
      {
        source: "/auth/oidc/callback",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // A vendored font never changes in place: new bytes go in a new version directory.
        source: "/fonts/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
