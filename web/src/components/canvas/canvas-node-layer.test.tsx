// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
vi.mock("./canvas-node-handoff", () => ({ CanvasNodeHandoff: ({ data, showFull }: { data: CanvasNodeData; showFull: boolean }) => showFull ? <video data-full={data.id} /> : <div data-compact={data.id} /> }));
import { NodeLayer } from "./canvas-node-layer";
it("preserves mounted media across 24 nodes and zoom-in pressure, but protects overview", async () => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
 vi.stubGlobal("requestAnimationFrame", () => 1);
 vi.stubGlobal("cancelAnimationFrame", vi.fn());
 const host = document.createElement("div"); const root = createRoot(host);
 const nodes: CanvasNodeData[] = Array.from({length: 72}, (_, i) => ({ id: String(i), type: CanvasNodeType.Video, title: "", width: 200, height: 200, position: {x: i * 200, y: 0} }));
 const props: ComponentProps<typeof NodeLayer> = {
 nodes: nodes.slice(0, 23), canonicalNodes: nodes, wheelZoomActive: false, scale: 1,
 viewportWidth: 1000, viewportHeight: 1000, devicePixelRatio: 1, centerX: 0, centerY: 0,
 pausePromotions: false, shared: {} as ComponentProps<typeof NodeLayer>["shared"],
 selectedNodeIds: new Set(), relatedNodeIds: new Set(), activeNodeId: null,
 connectionTargetNodeId: null, isConnecting: false, panelNodeId: null, isNodeResizing: false,
 isMarqueeActive: false, dropTargetGroupId: null, expandedImageNodeIds: new Set(), showImageInfo: false, groupChildCountById: new Map(),
 };
 try {
 await act(async () => root.render(<NodeLayer {...props} />));
 const video = host.querySelector("video")!; video.currentTime = 7;
 await act(async () => root.render(<NodeLayer {...props} nodes={nodes.slice(0,24)} wheelZoomActive pausePromotions />));
 expect(host.querySelector("video")).toBe(video);
 expect(video.currentTime).toBe(7);
 expect(host.querySelector('[data-compact="23"]')).not.toBeNull();
 await act(async () => root.render(<NodeLayer {...props} nodes={nodes} scale={.35} wheelZoomActive pausePromotions wheelRenderPressure wheelZoomDirection="in" />));
 expect(host.querySelector("video")).toBe(video);
 await act(async () => root.render(<NodeLayer {...props} nodes={nodes} scale={.35} wheelZoomActive pausePromotions wheelRenderPressure wheelZoomDirection="out" selectedNodeIds={new Set(["0"])} />));
 expect(host.querySelector("video")).toBe(video);
 expect(host.querySelectorAll("video")).toHaveLength(1);
 } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
