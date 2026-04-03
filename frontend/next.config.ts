import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "http://localhost:3000",
    "http://192.168.50.106",
    "http://100.120.202.82",
    // 允許所有 192.168.x.x 和 100.x.x.x (Tailscale) 存取
    "http://192.168.*",
    "http://100.*",
  ],
};

export default nextConfig;
