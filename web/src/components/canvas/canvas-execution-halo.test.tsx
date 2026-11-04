import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasExecutionHalo } from "./canvas-execution-halo";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeImage } from "@/types/canvas";
import { COMFY_WORKFLOW_MOCK_TYPE } from "@/lib/canvas/canvas-ports";
import { setCanvasComfyExecution, setCanvasComfyExecutionScope } from "@/features/comfy-workflow/canvas-execution-visual";
import { beginCanvasTextSubmission, finishCanvasTextSubmission, setCanvasTextExecutionScope } from "@/features/backend-sync/canvas-text-execution-visual";

const node: CanvasNodeData = { id: "halo", type: CanvasNodeType.Image, title: "", position: { x: 0, y: 0 }, width: 400, height: 240 };
const render = (data = node, visible = true) => renderToStaticMarkup(<CanvasExecutionHalo node={data} visible={visible} />);

describe("execution halo lifecycle", () => {
    beforeEach(() => {
        setCanvasComfyExecutionScope(null);
        setCanvasTextExecutionScope(null);
        setCanvasComfyExecutionScope("project");
        setCanvasTextExecutionScope("project");
    });
    it("decorates loading media and batch children, excluding idle, failed, groups and hidden handoff siblings", () => {
        for (const type of [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio]) {
            const loading = { ...node, type, metadata: { status: "loading" as const } };
            expect(render(loading)).toContain('aria-hidden="true"');
            expect(render(loading, false)).toBe("");
        }
        expect(render()).toBe("");
        expect(render({ ...node, metadata: { status: "error" } })).toBe("");
        expect(render({ ...node, type: CanvasNodeType.Group, metadata: { status: "loading" } })).toBe("");
        const image = { status: "loading" } as CanvasNodeImage;
        expect(render({ ...node, metadata: { status: "success", images: [image] } })).toContain("data-canvas-execution-halo");
    });
    it("follows every active Comfy phase and clears for terminal phases and project switches", () => {
        const workflow = { ...node, type: COMFY_WORKFLOW_MOCK_TYPE };
        for (const status of ["submitting", "queued", "preparing", "running", "collecting", "importing", "cancelling"]) {
            setCanvasComfyExecution("project", node.id, { status });
            expect(render(workflow)).toContain("data-canvas-execution-halo");
        }
        for (const status of ["succeeded", "failed", "cancelled", "timed_out", "unavailable"]) {
            setCanvasComfyExecution("project", node.id, { status });
            expect(render(workflow)).toBe("");
        }
        setCanvasComfyExecution("project", node.id, { status: "running" });
        setCanvasComfyExecutionScope("other");
        expect(render(workflow)).toBe("");
    });
    it("retains one halo until all text requests finish and clears on scope change", () => {
        for (const type of [CanvasNodeType.Text, CanvasNodeType.Config,
            CanvasNodeType.Image,CanvasNodeType.Video,CanvasNodeType.Audio]) {
            const text = { ...node, type };
            const kind=type===CanvasNodeType.Image?"image":type===CanvasNodeType.Video?"video":type===CanvasNodeType.Audio?"audio":"text";
            beginCanvasTextSubmission("project", node.id, "first",kind);
            beginCanvasTextSubmission("project", node.id, "second",kind);
            expect(render(text).match(/data-canvas-execution-halo/g)).toHaveLength(1);
            finishCanvasTextSubmission("project", node.id, "first");
            expect(render(text)).not.toBe("");
            finishCanvasTextSubmission("project", node.id, "second");
            expect(render(text)).toBe("");
        }
        beginCanvasTextSubmission("project", node.id, "pending");
        setCanvasTextExecutionScope("other");
        expect(render({ ...node, type: CanvasNodeType.Text })).toBe("");
    });
});
