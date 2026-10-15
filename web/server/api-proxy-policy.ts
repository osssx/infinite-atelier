import { lookup, resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

type Address = { address: string; family: number };
type Resolver = {
    lookup: (hostname: string) => Promise<Address[]>;
    resolve4: (hostname: string) => Promise<string[]>;
    resolve6: (hostname: string) => Promise<string[]>;
};

function isPublicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 168 || b === 88)) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
            (a === 203 && b === 0) || a >= 224);
    }
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice("::ffff:".length));
    return isIP(value) === 6 && value.startsWith("2") && !value.startsWith("2001:db8:") && !value.startsWith("2001:10:");
}

const systemResolver: Resolver = {
    lookup: hostname => lookup(hostname, { all: true, verbatim: true }),
    resolve4,
    resolve6,
};

export function isLoopbackAddress(address: string): boolean {
    const value = address.toLowerCase().replace(/^\[|\]$/g, "");
    if (value.startsWith("::ffff:")) return isLoopbackAddress(value.slice(7));
    return value === "::1" || (isIP(value) === 4 && value.startsWith("127."));
}

export function trustedLocalOrigin(raw: string): string {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) ||
        !(url.hostname === "localhost" || isLoopbackAddress(url.hostname)) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw new Error("API_PROXY_TRUSTED_LOCAL_ORIGINS must contain loopback HTTP(S) origins without paths");
    return url.origin;
}

export function isLocalProxyCaller(caller: { remoteAddress: string; host?: string; origin?: string; fetchSite?: string }): boolean {
    if (!isLoopbackAddress(caller.remoteAddress) || !caller.host) return false;
    if (caller.fetchSite && !["same-origin", "none"].includes(caller.fetchSite)) return false;
    if (!caller.origin && !caller.fetchSite) return false;
    try {
        const host = new URL(`http://${caller.host}`);
        if (!(host.hostname === "localhost" || isLoopbackAddress(host.hostname))) return false;
        if (!caller.origin) return true;
        const origin = new URL(caller.origin);
        return ["http:", "https:"].includes(origin.protocol) && origin.origin === caller.origin && origin.host === host.host;
    } catch { return false; }
}

export async function validateProxyTarget(raw: string, policy: { allowedHosts?: Set<string>; trustedLocalOrigins: Set<string> }, resolver: Resolver = systemResolver) {
    const target = new URL(raw);
    if (target.username || target.password || target.hash) throw new Error("API target cannot contain credentials or a fragment");
    if (policy.trustedLocalOrigins.has(target.origin)) {
        trustedLocalOrigin(target.origin);
        const hostname = target.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver.lookup(hostname);
        if (!addresses.length || addresses.some(({ address }) => !isLoopbackAddress(address))) throw new Error("trusted local API resolves outside loopback");
        return { target, addresses };
    }
    if (target.protocol !== "https:" || isIP(target.hostname.replace(/^\[|\]$/g, "")))
        throw new Error("Public API targets require an HTTPS hostname; configure API_PROXY_TRUSTED_LOCAL_ORIGINS for a local API");
    if (policy.allowedHosts && !policy.allowedHosts.has(target.hostname.toLowerCase())) throw new Error("target host is not allowed by VITE_API_PROXY_ALLOWED_HOSTS");
    return { target, addresses: await resolvePublicProxyAddresses(target.hostname, resolver) };
}

export async function resolvePublicProxyAddresses(hostname: string, resolver: Resolver = systemResolver): Promise<Address[]> {
    let addresses = await resolver.lookup(hostname);
    // TUN proxies may synthesize RFC 2544 addresses for the OS resolver. Query
    // DNS directly, then validate and pin the real addresses instead of allowing
    // connections to that reserved range.
    if (addresses.length && addresses.every(({ address }) => /^198\.(?:18|19)\./.test(address))) {
        const records = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
        addresses = records.flatMap((result, index) => result.status === "fulfilled"
            ? result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })) : []);
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
        throw new Error("target resolves to a non-public address");
    return addresses;
}
