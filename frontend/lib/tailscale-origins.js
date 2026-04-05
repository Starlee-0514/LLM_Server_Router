/**
 * Tailscale allowed origins utility
 * Dynamically fetches all tailscale IPs from the current account
 * and generates allowed dev origins for Next.js
 */

const { execSync } = require("child_process");
const os = require("os");

/**
 * Get all tailscale IPs (self + peers) from the current account
 * @returns {string[]} Array of tailscale IPs (100.x.x.x)
 */
function getTailscaleIPs() {
  try {
    const output = execSync("tailscale status --json", { encoding: "utf-8" });
    const status = JSON.parse(output);

    const ips = [];

    // Include self IP (this is the IP remote clients connect FROM)
    if (status.Self?.TailscaleIPs) {
      const selfIPv4 = status.Self.TailscaleIPs.find((ip) => ip.includes("."));
      if (selfIPv4) ips.push(selfIPv4);
    }

    // Include all peer IPs
    if (status.Peer) {
      Object.values(status.Peer)
        .filter((peer) => peer.TailscaleIPs && peer.TailscaleIPs.length > 0)
        .forEach((peer) => {
          const ipv4 = peer.TailscaleIPs.find((ip) => ip.includes("."));
          if (ipv4) ips.push(ipv4);
        });
    }

    console.log(`[Tailscale] Found ${ips.length} IPs (self + peers):`, ips);
    return ips;
  } catch (error) {
    console.warn(
      "[Tailscale] Could not fetch tailscale IPs:",
      error.message
    );
    return [];
  }
}

/**
 * Get all local network IPv4 addresses (e.g. 192.168.x.x)
 * @returns {string[]} Array of local IPs
 */
function getLocalNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  console.log(`[Network] Found ${ips.length} local IPs:`, ips);
  return ips;
}

/**
 * Get allowed dev origins for Next.js HMR
 * Includes localhost and all tailscale IPs
 * @returns {string[]} Array of allowed origins
 */
function getAllowedDevOrigins() {
  const baseOrigins = [
    "localhost",
    "127.0.0.1",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];

  // In production, only allow localhost
  if (process.env.NODE_ENV === "production") {
    return baseOrigins.filter((origin) => origin.includes("localhost"));
  }

  // In development, add all tailscale IPs + local network IPs
  const tailscaleIPs = getTailscaleIPs();
  const localIPs = getLocalNetworkIPs();
  const allIPs = [...new Set([...tailscaleIPs, ...localIPs])];
  const remoteOrigins = allIPs.flatMap((ip) => [ip, `http://${ip}`]);

  return [...baseOrigins, ...remoteOrigins];
}

module.exports = {
  getTailscaleIPs,
  getAllowedDevOrigins,
};
