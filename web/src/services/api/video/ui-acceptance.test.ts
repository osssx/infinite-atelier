import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/image-settings-panel", () => ({ ImageSettingsTheme: ({ children }: { children: ReactNode }) => children }));

import { VideoSettingsPanel, videoResolutionLabel } from "@/components/video-settings-panel";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { SEEDANCE_STANDARD, SEEDANCE_FAST } from "./model-capabilities";

function render(config: AiConfig) {
    return renderToStaticMarkup(createElement(VideoSettingsPanel, { config, onConfigChange: () => undefined, theme: Object.values(canvasThemes)[0] }));
}

describe("independent video settings acceptance", () => {
    it("filters unsupported official features when the node uses the local Router adapter", () => {
        const config: AiConfig = { ...defaultConfig, model: `router::${SEEDANCE_STANDARD}`, videoModel: `router::${SEEDANCE_STANDARD}`, channels: [{ id: "router", name: "Seedance2", apiFormat: "volcengine_ark", seedanceAdapter: "router_local", baseUrl: "http://127.0.0.1:8189/api/v3", apiKey: "local", models: [{ name: SEEDANCE_STANDARD, capability: "video", videoPreset: "seedance-2.0", videoCapabilities: { resolutions: ["4k"], durations: [-1], returnLastFrame: true, watermark: true } }] }] };
        const markup = render(config);
        expect(markup).not.toContain(">4k<");
        expect(markup).not.toContain("settingsPanels.video.smart</button>");
        expect(markup).not.toContain("settingsPanels.video.returnLastFrame</span>");
        expect(markup).not.toContain("settingsPanels.video.watermark</span>");
        expect(markup).toContain(">480p<");
        expect(markup).toContain(">768P<");
    });

    it("uses the selected node model when the global video default is OpenAI", () => {
        const config: AiConfig = { ...defaultConfig, model: `ark::${SEEDANCE_STANDARD}`, channels: [...defaultConfig.channels, { id: "ark", name: "Ark", apiFormat: "volcengine_ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", models: [{ name: SEEDANCE_STANDARD, capability: "video" }] }] };
        const markup = render(config);
        expect(markup).toContain("settingsPanels.video.modes.first_last_frame");
        expect(markup).toContain("1080p");
        expect(markup).not.toContain('max="20"');
    });

    it("does not offer 4k for a manually added known Fast model without preset metadata", () => {
        const config: AiConfig = { ...defaultConfig, model: `ark::${SEEDANCE_FAST}`, videoModel: `ark::${SEEDANCE_FAST}`, channels: [{ id: "ark", name: "Ark", apiFormat: "volcengine_ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", models: [{ name: SEEDANCE_FAST, capability: "video" }] }] };
        const markup = render(config);
        expect(markup).not.toContain(">4k<");
        expect(markup).not.toContain(">1080p<");
    });

    it("formats 4k without a p suffix", () => {
        expect(videoResolutionLabel("4k")).toBe("4k");
    });
});
