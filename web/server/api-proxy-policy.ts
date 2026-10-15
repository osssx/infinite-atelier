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
