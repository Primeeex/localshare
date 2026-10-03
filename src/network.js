/**
 * Local network IP detection utilities.
 * @module network
 */

import os from "node:os";

/**
 * Get all local (non-loopback) IP addresses with their interface names.
 * @returns {Array<{name: string, address: string, family: string}>}
 */
export function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses) {
      // WHY: skip loopback and IPv6 link-local for simplicity
      if (addr.internal || addr.family === "IPv6") continue;
      ips.push({ name, address: addr.address, family: "IPv4" });
    }
  }
  return ips;
}

/**
 * Select the primary IP address using heuristic preference:
 * 192.168.x.x (Wi-Fi) > 10.x.x.x (Ethernet) > 172.16.x.x (other) > first remaining.
 * @param {Array<{name: string, address: string}>} ips
 * @returns {string} Primary IP address
 */
export function getPrimaryIP(ips) {
  const wifi = ips.find((ip) => ip.address.startsWith("192.168."));
  if (wifi) return wifi.address;
  const ethernet = ips.find((ip) => ip.address.startsWith("10."));
  if (ethernet) return ethernet.address;
  const other = ips.find((ip) => ip.address.startsWith("172.16."));
  if (other) return other.address;
  return ips[0]?.address ?? "127.0.0.1";
}

/**
 * Build the full URL for a given IP and port.
 * Handles IPv6 by wrapping in brackets.
 * @param {string} ip
 * @param {number} port
 * @returns {string}
 */
export function buildURL(ip, port) {
  const host = ip.includes(":") ? `[${ip}]` : ip;
  return `http://${host}:${port}`;
}
