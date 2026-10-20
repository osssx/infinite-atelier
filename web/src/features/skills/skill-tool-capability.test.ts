import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { clearSkillToolCapabilityCache, isSkillToolsKnownUnsupported, rememberSupportedSkillTools, rememberUnsupportedSkillTools } from "./skill-tool-capability";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

beforeEach(() => clearSkillToolCapabilityCache());
describe("P4 in-session text-model tool capability cache", () => {
    const config = { ...defaultConfig, apiKey: "private-api-key", model: "text-model",
        baseUrl: "https://host.example.com/v1", apiFormat: "openai" as const };

    it("skips the next failed capability probe, then expires unsupported after 30 minutes", () => {
        expect(isSkillToolsKnownUnsupported(config, 1000)).toBe(false);
        rememberUnsupportedSkillTools(config, 1000);
        expect(isSkillToolsKnownUnsupported(config, 1000)).toBe(true);
        expect(isSkillToolsKnownUnsupported(config, 1000 + 30 * 60 * 1000 - 1)).toBe(true);
        expect(isSkillToolsKnownUnsupported(config, 1000 + 30 * 60 * 1000)).toBe(false);
    });
    it("isolates endpoint, model and API format; successful calls remove stale negatives", () => {
        rememberUnsupportedSkillTools(config, 1000);
        expect(isSkillToolsKnownUnsupported({ ...config, model: "other" }, 1001)).toBe(false);
        expect(isSkillToolsKnownUnsupported({ ...config, baseUrl: "https://other.example.com/v1" }, 1001)).toBe(false);
        expect(isSkillToolsKnownUnsupported({ ...config, apiFormat: "gemini" }, 1001)).toBe(false);
        expect(isSkillToolsKnownUnsupported(config, 1001)).toBe(true);
        rememberSupportedSkillTools(config);
        expect(isSkillToolsKnownUnsupported(config, 1001)).toBe(false);
    });
    it("normalizes trailing slashes and capitalization but never stores cache in browser storage", () => {
        rememberUnsupportedSkillTools(config, 1000);
        expect(isSkillToolsKnownUnsupported({ ...config, baseUrl: "HTTPS://HOST.EXAMPLE.COM/v1/" }, 1001)).toBe(true);
        const storage = vi.fn();
        vi.stubGlobal("localStorage", { setItem: storage });
        rememberUnsupportedSkillTools(config, 1000);
        expect(storage).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});
