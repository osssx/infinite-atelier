// @vitest-environment happy-dom
import { act, createElement, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("./preset-catalog", () => ({
  listComfyPresetCatalog: vi.fn(async () => []),
  loadComfyPresetCatalogTemplates: vi.fn(async () => ({ templates: {}, failures: [] })),
}));
vi.mock("./template-registry", () => ({ getComfyTemplate: vi.fn(() => new Promise(() => {})) }));

import { useComfyMediaPresetControl } from "./comfy-media-preset-control";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasNodeData } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let callbackCount = 0;

const node: CanvasNodeData = {
  id: "config-1", type: "config", title: "Config", position: { x: 0, y: 0 }, width: 320, height: 200,
  metadata: {},
};

function Harness({ onOptions, revision }: { onOptions: Mock<() => void>; revision: number }) {
  const [, setOptions] = useState<{ value: string; label: string; disabled?: boolean }[]>([]);
  const defaultPreset = { templateId: "preset-1", templateRevision: "1" };
  const onChange = useCallback(() => {}, []);
  const onPickerOptionsChange = useCallback((options: { value: string; label: string; disabled?: boolean }[]) => {
    onOptions();
    callbackCount += 1;
    if (callbackCount > 20) throw new Error("picker option callback entered an update loop");
    setOptions(options);
  }, [onOptions]);
  useComfyMediaPresetControl({
    node, nodes: [node], connections: [], config: {} as AiConfig, theme: canvasThemes.dark,
    capability: "image", defaultPreset, onChange,
    // Models the Config panel callback before its equality guard: every emission causes a parent update.
    onPickerOptionsChange,
  });
  return createElement("div", { "data-revision": revision });
}

describe("Comfy media preset control DOM stability", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
  });

  it("settles after catalog loading and stays stable across Config node rerenders", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onOptions = vi.fn();
    callbackCount = 0;
    await act(async () => { root?.render(createElement(Harness, { onOptions, revision: 0 })); });
    const settledCalls = callbackCount;
    expect(settledCalls).toBeLessThanOrEqual(4);
    await act(async () => { root?.render(createElement(Harness, { onOptions, revision: 1 })); });
    expect(onOptions).toHaveBeenCalledTimes(settledCalls);
    host.remove();
  });
});
