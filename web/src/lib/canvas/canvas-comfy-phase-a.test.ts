import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { prepareCanvasPortConnection, validateCanvasPortConnections } from "./canvas-port-connections";
import { prepareCanvasExternalInputSnapshot, resolveCanvasInputValue } from "./canvas-external-input-snapshot";
import { COMFY_WORKFLOW_MOCK_TYPE, getCanvasPortAnchor, getCanvasPortOffset, MOCK_COMFY_PORTS, pickCanvasDropHandle } from "./canvas-ports";
import { connectionControlPoints, connectionControlHull } from "./canvas-connection-culling";
import { cullConnections } from "./canvas-connection-culling";
import { buildOverviewConnectionPaths } from "./canvas-overview-connections";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasPortDescriptor, type ConnectionHandle } from "@/types/canvas";

beforeAll(() => registerBuiltinNodes());
const n = (id: string, type: string, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, title: id, position: { x: 10, y: 20 }, width: 360, height: 265, metadata,
});
const h = (nodeId: string, handleType: "source" | "target", portId?: string): ConnectionHandle => ({ nodeId, handleType, portId });
const link = (a: ConnectionHandle, b: ConnectionHandle, nodes: CanvasNodeData[], connections: CanvasConnection[]) =>
    prepareCanvasPortConnection(a, b, nodes, connections);

describe("Phase A: port-aware canvas connection contract", () => {
    const aPorts: CanvasPortDescriptor[] = [
        { id: "first", label: "A", direction: "source", valueKind: "IMAGE" },
        { id: "second", label: "B", direction: "source", valueKind: "IMAGE" },
    ];
    const bPorts: CanvasPortDescriptor[] = [
        { id: "one", label: "1", direction: "target", valueKind: "IMAGE" },
        { id: "two", label: "2", direction: "target", valueKind: "IMAGE" },
        { id: "three", label: "3", direction: "target", valueKind: "IMAGE" },
    ];
    const nodes = [
        n("a", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: aPorts }),
        n("b", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: bPorts }),
        n("c", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: aPorts }),
    ];
    it("A-01: two edges between same node pair, distinct target ports; second source rejected", () => {
        const one = link(h("a", "source", "first"), h("b", "target", "one"), nodes, []);
        expect(one.connection).toMatchObject({ fromPortId: "first", toPortId: "one" });
        const existing: CanvasConnection[] = [{ id: "one", ...one.connection! }];
        const two = link(h("a", "source", "second"), h("b", "target", "two"), nodes, existing);
        expect(two.connection?.toPortId).toBe("two");
        expect(link(h("c", "source", "first"), h("b", "target", "one"), nodes, existing).error).toBe("multiple_sources_for_input");
        expect(link(h("a", "source", "first"), h("b", "target", "one"), nodes, existing).error).toBe("duplicate");
    });
    it("A-02: a source socket can fan out to three distinct inputs", () => {
        let edges: CanvasConnection[] = [];
        for (const [i, port] of ["one", "two", "three"].entries()) {
            const result = link(h("a", "source", "first"), h("b", "target", port), nodes, edges);
            expect(result.error).toBeUndefined();
            edges = [...edges, { id: String(i), ...result.connection! }];
        }
        expect(edges).toHaveLength(3);
        expect(new Set(edges.map((c) => c.fromPortId)).size).toBe(1);
    });
    it("A-03: malformed imported double sources are rejected before execution", () => {
        const edges: CanvasConnection[] = [
            { id: "e1", fromNodeId: "a", fromPortId: "first", toNodeId: "b", toPortId: "one" },
            { id: "e2", fromNodeId: "c", fromPortId: "first", toNodeId: "b", toPortId: "one" },
        ];
        expect(validateCanvasPortConnections(nodes, edges)).toEqual([{ connectionId: "e2", error: "multiple_sources_for_input" }]);
    });
    it("rejects cycles, wrong types and incomplete typed inputs", () => {
        const cycNodes = [
            n("a", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: [...aPorts, { id: "recv", label: "Recv", direction: "target", valueKind: "IMAGE" }] }),
            n("b", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: [...bPorts, { id: "send", label: "Send", direction: "source", valueKind: "IMAGE" }] }),
        ];
        const existing: CanvasConnection[] = [{ id: "edge", fromNodeId: "a", fromPortId: "first", toNodeId: "b", toPortId: "one" }];
        expect(link(h("b", "source", "send"), h("a", "target", "recv"), cycNodes, existing).error).toBe("cycle");
        expect(link(h("a", "source", "first"), h("b", "target", "one"), nodes, []).connection).toBeDefined();
        expect(link(h("a", "source", "first"), h("a", "target", "recv"), cycNodes, []).error).toBe("invalid_handle");
        expect(link(h("a", "source", "first"), h("b", "target", "missing"), nodes, []).error).toBe("missing_port");
        expect(link(h("a", "source", "first"), h("b", "target", "three"), [
            nodes[0], n("b", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: [{ id:"three",label:"Three",direction:"target",valueKind:"STRING" }] }),
        ], []).error).toBe("incompatible_port_type");
    });
    it("legacy edges stay node-pair based; typed edge positions and overview geometry remain aligned", () => {
        const oldNodes = [n("i", CanvasNodeType.Image), n("t", CanvasNodeType.Text)];
        const legacy = link(h("i", "source"), h("t", "target"), oldNodes, []);
        expect(legacy.connection).toEqual({ fromNodeId: "i", toNodeId: "t" });
        expect(link(h("i", "source"), h("t", "target"), oldNodes, [{ id: "e", ...legacy.connection! }]).error).toBe("duplicate");
        const old = connectionControlPoints(oldNodes[0], oldNodes[1]);
        expect(old.startY).toBe(oldNodes[0].position.y + oldNodes[0].height / 2);
        expect(old.endY).toBe(oldNodes[1].position.y + oldNodes[1].height / 2);
        const conn: CanvasConnection = { id: "e", fromNodeId: "a", fromPortId: "second", toNodeId: "b", toPortId: "one" };
        const p = connectionControlPoints(nodes[0], nodes[1], conn);
        expect(p.startY).toBe(getCanvasPortAnchor(nodes[0], "source", "second").y);
        expect(p.endY).toBe(getCanvasPortAnchor(nodes[1], "target", "one").y);
        expect(connectionControlHull(nodes[0], nodes[1], conn).top).toBe(Math.min(p.startY, p.endY));
        const nearest = pickCanvasDropHandle(nodes[1], h("a", "source", "second"), nodes[1].position.y + getCanvasPortOffset(nodes[1], "target", "three"));
        expect(nearest?.portId).toBe("three");
    });
    it("legacy source to typed target uses a virtual resource port; old Config links stay legacy", () => {
        const text = n("text", CanvasNodeType.Text, { content: "a" });
        const mock = n("wf", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: MOCK_COMFY_PORTS });
        const edge = link(h("text", "source"), h("wf", "target", "prompt"), [text, mock], []);
        expect(edge.connection).toMatchObject({ fromPortId:"text", toPortId:"prompt" });
        const config = n("cfg", CanvasNodeType.Config);
        expect(link(h("text", "source"), h("cfg", "target"), [text, config], []).connection).toEqual({ fromNodeId:"text",toNodeId:"cfg" });
    });
});

describe("Phase A: 200 typed-node overview/culling baseline", () => {
    it("retains exact port anchors in 199 batched SVG edges and culling", () => {
        const nodes = Array.from({ length: 200 }, (_, index) => ({
            ...n("w" + index, COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts: MOCK_COMFY_PORTS }),
            position: { x: index * 420, y: (index % 5) * 360 },
        }));
        const edges: CanvasConnection[] = Array.from({ length: 199 }, (_, index) => ({
            id: "e" + index, fromNodeId: "w" + index, fromPortId: "result",
            toNodeId: "w" + (index + 1), toPortId: "image",
        }));
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const overview = buildOverviewConnectionPaths(edges, byId, null, new Set());
        expect(overview.curves).toHaveLength(199);
        const first = connectionControlPoints(nodes[0], nodes[1], edges[0]);
        expect(overview.curves[0]).toMatchObject({ x0:first.startX, y0:first.startY, x3:first.endX, y3:first.endY });
        const culled = cullConnections(edges, byId, { left:-100, top:-100, right:200_000, bottom:10_000 });
        expect(culled).toHaveLength(199);
        expect(validateCanvasPortConnections(nodes, edges)).toEqual([]);
    });
});

describe("Phase A: frozen external inputs and precedence", () => {
    it("A-04: preserves empty Text, 0 and false using property presence", () => {
        const text = n("text", CanvasNodeType.Text, { content: "", prompt:"fallback" });
        const workflow = n("wf", COMFY_WORKFLOW_MOCK_TYPE);
        const edges: CanvasConnection[] = [{ id:"text-edge",fromNodeId:"text",fromPortId:"text",toNodeId:"wf",toPortId:"prompt" }];
        const frozen = prepareCanvasExternalInputSnapshot([text, workflow], edges);
        expect(frozen).toEqual([{kind:"scalar",sourceNodeId:"text",sourcePortId:"text",valueKind:"STRING",value:""}]);
        text.metadata!.content = "changed after run";
        expect(frozen[0]).toMatchObject({value:""});
        expect(resolveCanvasInputValue("seed", { edge:{value:0}, overrides:{seed:55}, defaults:{seed:8}, template:{seed:4} })).toEqual({source:"edge",value:0});
        expect(resolveCanvasInputValue("flag", { overrides:{flag:false}, defaults:{flag:true}, template:{} })).toEqual({source:"override",value:false});
        expect(resolveCanvasInputValue("text", { overrides:{}, defaults:{text:""}, template:{text:"template"} })).toEqual({source:"default",value:""});
        expect(resolveCanvasInputValue("x", { overrides:{}, defaults:{}, template:{x:"legacy"}, absentPolicy:"disconnect" })).toEqual({source:"disconnect"});
        expect(resolveCanvasInputValue("x", { overrides:{}, defaults:{}, template:{x:"legacy"} })).toEqual({source:"template",value:"legacy"});
    });
    it("asset references must be made durable before submission; shared source snapshots deduplicate", () => {
        const img = n("image", CanvasNodeType.Image, { content:"blob:image",storageKey:"image:primary",mimeType:"image/png" });
        const wf = n("wf", COMFY_WORKFLOW_MOCK_TYPE, { comfyPorts:[
            {id:"one",label:"One",direction:"target",valueKind:"IMAGE"},
            {id:"two",label:"Two",direction:"target",valueKind:"IMAGE"},
        ] });
        const edges: CanvasConnection[] = ["one","two"].map((id) => ({id,fromNodeId:"image",fromPortId:"image",toNodeId:"wf",toPortId:id}));
        expect(prepareCanvasExternalInputSnapshot([img,wf],edges)).toEqual([
            {kind:"asset",sourceNodeId:"image",sourcePortId:"image",valueKind:"IMAGE",storageKey:"image:primary",url:"blob:image",imageId:undefined,mimeType:"image/png"},
        ]);
        img.metadata = { images: [
            {id:"one",status:"success",errorDetails:undefined,content:"img:1",storageKey:"image:1",naturalWidth:2,naturalHeight:2,bytes:4,mimeType:"image/png"},
            {id:"two",status:"success",errorDetails:undefined,content:"img:2",storageKey:"image:2",naturalWidth:2,naturalHeight:2,bytes:4,mimeType:"image/png"},
        ] };
        expect(() => prepareCanvasExternalInputSnapshot([img,wf],edges)).toThrow("primary_image_not_selected");
        img.metadata.primaryImageId = "two";
        expect(prepareCanvasExternalInputSnapshot([img,wf],edges)[0]).toMatchObject({ storageKey:"image:2",imageId:"two" });
    });
});
