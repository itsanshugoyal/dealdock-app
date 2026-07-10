import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@dealdock/core", "@dealdock/ai", "@dealdock/messaging"],
};

export default nextConfig;
