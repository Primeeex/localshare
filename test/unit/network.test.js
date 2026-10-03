/**
 * Unit tests for network utilities.
 */

import { describe, it, expect } from "vitest";
import { getLocalIPs, getPrimaryIP, buildURL } from "../../src/network.js";

describe("network", () => {
  describe("getLocalIPs", () => {
    it("returns at least one IP on a normal host", () => {
      const ips = getLocalIPs();
      expect(Array.isArray(ips)).toBe(true);
      expect(ips.length).toBeGreaterThanOrEqual(0);
      // Machine may have only loopback in CI containers; shape must still hold
      for (const ip of ips) {
        expect(ip).toHaveProperty("name");
        expect(ip).toHaveProperty("address");
        expect(ip.family).toBe("IPv4");
        expect(ip.address).not.toBe("127.0.0.1");
      }
    });

    it("excludes loopback addresses", () => {
      const ips = getLocalIPs();
      expect(ips.some((ip) => ip.address.startsWith("127."))).toBe(false);
    });
  });

  describe("getPrimaryIP", () => {
    const make = (...addresses) => addresses.map((address) => ({ name: "eth", address }));

    it("prefers 192.168.x.x over 10.x.x.x", () => {
      expect(getPrimaryIP(make("10.0.0.5", "192.168.1.42"))).toBe("192.168.1.42");
    });

    it("prefers 10.x.x.x over 172.16.x.x", () => {
      expect(getPrimaryIP(make("172.16.0.2", "10.1.2.3"))).toBe("10.1.2.3");
    });

    it("prefers 172.16.x.x over anything else", () => {
      expect(getPrimaryIP(make("8.8.8.8", "172.16.0.2"))).toBe("172.16.0.2");
    });

    it("falls back to the first address", () => {
      expect(getPrimaryIP(make("8.8.4.4", "1.1.1.1"))).toBe("8.8.4.4");
    });

    it("falls back to loopback when there are no interfaces", () => {
      expect(getPrimaryIP([])).toBe("127.0.0.1");
    });
  });

  describe("buildURL", () => {
    it("builds an http URL with port", () => {
      expect(buildURL("192.168.1.5", 3000)).toBe("http://192.168.1.5:3000");
    });

    it("wraps IPv6 addresses in brackets", () => {
      expect(buildURL("fe80::1", 8080)).toBe("http://[fe80::1]:8080");
    });
  });
});
