import { describe, expect, it, vi } from "vitest";
import { isLocalProxyCaller, resolvePublicProxyAddresses, trustedLocalOrigin, validateProxyTarget } from "../../server/api-proxy-policy";

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

describe("local canvas API proxy access", () => {
    const caller = { remoteAddress: "::ffff:127.0.0.1", host: "localhost:3000", origin: "http://localhost:3000", fetchSite: "same-origin" };
    it("allows the local same-origin canvas, including browser GET requests without Origin", () => {
        expect(isLocalProxyCaller(caller)).toBe(true);
        expect(isLocalProxyCaller({ ...caller, origin: undefined })).toBe(true);
    });
    it.each([
        { remoteAddress: "192.168.1.2" }, { origin: "https://attacker.example" },
        { fetchSite: "cross-site" }, { host: "attacker.example:3000", origin: "http://attacker.example:3000" },
        { origin: undefined, fetchSite: undefined },
    ])("rejects remote/cross-origin/rebinding caller %j", changes => {
        expect(isLocalProxyCaller({ ...caller, ...changes })).toBe(false);
    });
});

describe("channel target policy", () => {
    const policy = { trustedLocalOrigins: new Set(["http://127.0.0.1:8189"]) };
    it("allows a new public HTTPS provider without adding a hostname", async () => {
        const dns = resolver([{ address: "35.186.247.105", family: 4 }]);
        const result = await validateProxyTarget("https://new-provider.example:8443/custom/v1/models", policy, dns);
        expect(result.target.port).toBe("8443");
        expect(result.addresses).toEqual([{ address: "35.186.247.105", family: 4 }]);
    });
    it("supports optional strict hostname restriction", async () => {
        const dns = resolver([{ address: "35.186.247.105", family: 4 }]);
        await expect(validateProxyTarget("https://other.example/v1/models", { ...policy, allowedHosts: new Set(["allowed.example"]) }, dns)).rejects.toThrow("not allowed");
        expect(dns.lookup).not.toHaveBeenCalled();
    });
    it("allows the explicitly trusted local Router for image and text API paths", async () => {
        const result = await validateProxyTarget("http://127.0.0.1:8189/v1/images/edits", policy);
        expect(result.addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);
    });
    it.each(["http://127.0.0.1:8188/v1/models", "http://public.example/v1/models", "https://127.0.0.1/v1/models", "https://user:secret@public.example/v1/models"])("rejects untrusted address %s", async url => {
        await expect(validateProxyTarget(url, policy)).rejects.toThrow();
    });
    it("rejects a new public provider resolving to an internal address", async () => {
        await expect(validateProxyTarget("https://internal.example/v1/models", policy, resolver([{ address: "10.0.0.5", family: 4 }]))).rejects.toThrow("non-public");
    });
    it("pins trusted localhost to loopback DNS answers only", async () => {
        await expect(validateProxyTarget("http://localhost:8189/v1/models", { trustedLocalOrigins: new Set(["http://localhost:8189"]) }, resolver([{ address: "10.0.0.5", family: 4 }]))).rejects.toThrow("outside loopback");
    });
    it.each(["http://192.168.1.2:8189", "http://localhost:8189/other", "https://user:secret@localhost:8189"])("rejects invalid local trust configuration %s", url => {
        expect(() => trustedLocalOrigin(url)).toThrow();
    });
});
