import { describe, expect, it, vi } from "vitest";
import { resolvePublicProxyAddresses } from "../../server/api-proxy-policy";

function resolver(addresses: Array<{ address: string; family: number }>) {
    return { lookup: vi.fn().mockResolvedValue(addresses), resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) };
}

describe("development API proxy DNS policy", () => {
    it("keeps validated public lookup addresses for the pinned connection", async () => {
        const dns = resolver([{ address: "35.186.247.105", family: 4 }]);
        expect(await resolvePublicProxyAddresses("relay.example", dns)).toEqual([{ address: "35.186.247.105", family: 4 }]);
        expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it("resolves a TUN Fake-IP to public DNS records without connecting to the reserved address", async () => {
        const dns = resolver([{ address: "198.18.1.11", family: 4 }]);
        dns.resolve4.mockResolvedValue(["35.186.247.105"]);
        dns.resolve6.mockRejectedValue(new Error("ENODATA"));
        expect(await resolvePublicProxyAddresses("relay.example", dns)).toEqual([{ address: "35.186.247.105", family: 4 }]);
    });

    it("rejects private DNS results behind a Fake-IP", async () => {
        const dns = resolver([{ address: "198.19.1.11", family: 4 }]);
        dns.resolve4.mockResolvedValue(["127.0.0.1"]);
        await expect(resolvePublicProxyAddresses("relay.example", dns)).rejects.toThrow("non-public address");
    });

    it("fails closed when direct DNS resolution is unavailable", async () => {
        const dns = resolver([{ address: "198.18.1.11", family: 4 }]);
        dns.resolve4.mockRejectedValue(new Error("ETIMEOUT"));
        dns.resolve6.mockRejectedValue(new Error("ETIMEOUT"));
        await expect(resolvePublicProxyAddresses("relay.example", dns)).rejects.toThrow("non-public address");
    });

    it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"])("continues rejecting private address %s", async address => {
        const dns = resolver([{ address, family: address.includes(":") ? 6 : 4 }]);
        await expect(resolvePublicProxyAddresses("relay.example", dns)).rejects.toThrow("non-public address");
        expect(dns.resolve4).not.toHaveBeenCalled();
    });
});
