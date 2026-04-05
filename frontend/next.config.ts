import type { NextConfig } from "next";
const { getAllowedDevOrigins } = require("./lib/tailscale-origins");

const nextConfig: NextConfig = {
  // Automatically includes localhost + all tailscale peer IPs from your account
  // This allows development access from all devices in your tailscale network
  allowedDevOrigins: getAllowedDevOrigins(),
};

export default nextConfig;
