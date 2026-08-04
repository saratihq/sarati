import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server output for container/Railway deploys (smaller runtime,
  // no need to ship node_modules). `next start` continues to work locally.
  output: "standalone",
};

export default nextConfig;
