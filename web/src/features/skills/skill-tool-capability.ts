import type { AiConfig } from "@/stores/use-config-store";

/**
 * Only cache explicit tool-schema incompatibility, never an arbitrary API error.
 * Session-memory only: no credentials or provider details written to disk.
 * An expiry gives providers a chance to recover after upgrades.
 */
const UNSUPPORTED_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 128;
const unsupported = new Map<string, number>();
function key(config: AiConfig): string {
    return JSON.stringify([
        config.apiFormat,
        config.baseUrl.trim().toLowerCase().replace(/\/+$/, ""),
        config.model.trim(),
        // Channel-mode switches are isolated without keeping API credentials.
        config.channelMode,
    ]);
}
export function isSkillToolsKnownUnsupported(config: AiConfig, now = Date.now()): boolean {
    const id = key(config);
    const expiry = unsupported.get(id);
    if (expiry === undefined) return false;
    if (expiry <= now) {
        unsupported.delete(id);
        return false;
    }
    return true;
}
export function rememberUnsupportedSkillTools(config: AiConfig, now = Date.now()) {
    const id = key(config);
    unsupported.delete(id);
    if (unsupported.size >= MAX_ENTRIES) unsupported.delete(unsupported.keys().next().value!);
    unsupported.set(id, now + UNSUPPORTED_TTL_MS);
}
export function rememberSupportedSkillTools(config: AiConfig) {
    unsupported.delete(key(config));
}
/** Explicitly clear when model capability settings change, or in tests. */
export function clearSkillToolCapabilityCache() {
    unsupported.clear();
}
