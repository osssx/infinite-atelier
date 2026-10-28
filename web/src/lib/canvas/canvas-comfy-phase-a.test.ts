import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { prepareCanvasPortConnection, reconcileComfyArtifactConnections, validateCanvasPortConnections } from "./canvas-port-connections";
import { prepareCanvasExternalInputSnapshot, resolveCanvasInputValue } from "./canvas-external-input-snapshot";
import { COMFY_WORKFLOW_MOCK_TYPE, CANVAS_PORT_EDGE_PADDING, CANVAS_PORT_MIN_PITCH, getCanvasPortAnchor, getCanvasPortHitSize, getCanvasPortOffset, getCanvasVisiblePorts, getCanvasNodePorts, getMinimumCanvasPortNodeHeight, MOCK_COMFY_PORTS, pickCanvasDropHandle } from "./canvas-ports";
import { applyNodeConfigPatch } from "./canvas-node-factory";
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


describe("durable Comfy IMAGE output to materialized Image nodes",()=>{
    const workflow=n("wf",COMFY_WORKFLOW_MOCK_TYPE,{
        comfyPorts:[{id:"generated",label:"Result",direction:"source",valueKind:"IMAGE"}],
    });
    const image=(id:string,artifactId=id):CanvasNodeData=>n(id,CanvasNodeType.Image,{
        content:"blob:mock",comfyArtifact:{runId:"run-1",artifactId,workflowNodeId:"wf",portId:"generated",kind:"image",index:0},
    });
    it("connects two generated images from exactly the bound IMAGE output socket",()=>{
        const nodes=[workflow,image("img-1"),image("img-2")];
        const edges=reconcileComfyArtifactConnections(nodes,[],(()=>{let counter=0;return ()=>"edge-"+(++counter);})());
        expect(edges).toEqual([
            {id:"edge-1",fromNodeId:"wf",fromPortId:"generated",toNodeId:"img-1",toPortId:"comfy-artifact"},
            {id:"edge-2",fromNodeId:"wf",fromPortId:"generated",toNodeId:"img-2",toPortId:"comfy-artifact"},
        ]);
        expect(validateCanvasPortConnections(nodes,edges)).toEqual([]);
        expect(reconcileComfyArtifactConnections(nodes,edges,()=>{throw Error("duplicate")}))
            .toEqual(edges);
        expect(getCanvasPortAnchor(workflow,"source","generated").x).toBe(workflow.position.x+workflow.width);
        expect(getCanvasPortAnchor(nodes[1],"target","comfy-artifact").x).toBe(nodes[1].position.x);
    });
    it("refuses unowned images, invalid output port, and duplicate producers",()=>{
        const wrong=n("other",CanvasNodeType.Image,{content:"a"});
        const nodes=[workflow,image("img"),wrong];
        expect(link(h("wf","source","generated"),h("other","target"),nodes,[]).error).toBe("legacy_target_not_supported");
        expect(link(h("wf","source","missing"),h("img","target"),nodes,[]).error).toBe("legacy_target_not_supported");
        const attached=reconcileComfyArtifactConnections(nodes,[],()=> "linked");
        expect(attached).toHaveLength(1);
        expect(link(h("wf","source","generated"),h("img","target"),nodes,attached).error).toBe("duplicate");
        const foreign=n("foreign",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:[
            {id:"generated",label:"Result",direction:"source",valueKind:"IMAGE"}
        ]});
        expect(link(h("foreign","source","generated"),h("img","target"),[...nodes,foreign],[]).error).toBe("legacy_target_not_supported");
    });
    it("reconciles generated outputs after canvas hydration without changing metadata",()=>{
        const nodes=[workflow,image("img1"),image("img2")];
        const old=[{id:"unrelated",fromNodeId:"t",toNodeId:"s"}];
        const repaired=reconcileComfyArtifactConnections(nodes,old,(()=>{let id=0;return ()=>"new-"+(++id);})());
        expect(repaired).toHaveLength(3);
        expect(repaired[0]).toEqual(old[0]);
        expect(reconcileComfyArtifactConnections(nodes,repaired,()=>{throw Error("should not create")}))
            .toHaveLength(3);
    });
});

describe("typed Comfy outputs attach only to the matching generated resource",()=>{
    const kinds=[
        {kind:"image" as const,type:CanvasNodeType.Image,port:"i",socket:"IMAGE" as const},
        {kind:"video" as const,type:CanvasNodeType.Video,port:"v",socket:"VIDEO" as const},
        {kind:"audio" as const,type:CanvasNodeType.Audio,port:"a",socket:"AUDIO" as const},
        {kind:"text" as const,type:CanvasNodeType.Text,port:"t",socket:"STRING" as const},
    ];
    const wf=n("workflow",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:kinds.map(item=>({
        id:item.port,label:item.port,direction:"source" as const,valueKind:item.socket
    }))});
    const targets=kinds.map((item,index)=>n("item-"+index,item.type,{comfyArtifact:{
        runId:"run-v2",artifactId:"artifact-"+index,workflowNodeId:"workflow",
        portId:item.port,kind:item.kind,index
    }}));
    it("connects all four kinds and is idempotent",()=>{
        const nodes=[wf,...targets];
        const edges=reconcileComfyArtifactConnections(nodes,[],(()=>{let i=0;return ()=>"typed-"+(++i);})());
        expect(edges).toHaveLength(4);
        expect(validateCanvasPortConnections(nodes,edges)).toEqual([]);
        expect(reconcileComfyArtifactConnections(nodes,edges,()=>{throw Error("already materialized");})).toEqual(edges);
    });
    it("rejects media-kind mismatch and missing new-contract index",()=>{
        const invalid={...targets[1],metadata:{...targets[1].metadata,comfyArtifact:{
            ...targets[1].metadata!.comfyArtifact!,kind:"image" as const
        }}};
        const nodes=[wf,invalid];
        expect(reconcileComfyArtifactConnections(nodes,[],()=> "not-used")).toHaveLength(0);
        expect(prepareCanvasPortConnection(
            {nodeId:wf.id,handleType:"source",portId:"v"},
            {nodeId:invalid.id,handleType:"target"},nodes,[]).error).toBe("legacy_target_not_supported");
    });
});

describe("ComfyUI scalar sockets hidden on canvas without altering template bindings", () => {
    const ports:CanvasPortDescriptor[]=[
        {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING",required:true},
        {id:"frame",label:"Frame",direction:"target",valueKind:"IMAGE"},
        {id:"steps",label:"Steps",direction:"target",valueKind:"INT",required:true},
        {id:"guidance",label:"Guidance",direction:"target",valueKind:"FLOAT"},
        {id:"enabled",label:"Enabled",direction:"target",valueKind:"BOOLEAN"},
        {id:"audio",label:"Audio",direction:"target",valueKind:"AUDIO"},
        {id:"output",label:"Output",direction:"source",valueKind:"VIDEO"}
    ];
    it("only renders connectable TEXT/media inputs and all outputs; keeps full metadata",()=>{
        const wf=n("wf",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:ports});
        expect(getCanvasVisiblePorts(wf).map(p=>p.id)).toEqual(["prompt","frame","audio","output"]);
        expect(getCanvasNodePorts(wf)).toEqual(ports);
        expect(wf.metadata?.comfyPorts).toEqual(ports);
        expect(getCanvasPortHitSize(wf,"target")).toBe(28);
        expect(getCanvasPortOffset(wf,"target","prompt")).toBe(CANVAS_PORT_EDGE_PADDING);
        expect(getCanvasPortOffset(wf,"target","audio")).toBe(wf.height-CANVAS_PORT_EDGE_PADDING);
        expect(pickCanvasDropHandle(wf,h("text","source","text"),wf.position.y+wf.height/2)?.portId).toBe("frame");
        expect(getCanvasVisiblePorts(n("text",CanvasNodeType.Text))).toEqual([]);
    });
    it("shows STRING enum sockets, but hides INT, FLOAT and BOOLEAN even with candidate settings",()=>{
        // The template owns choices; the canvas caches only port identity/type.
        const templateInputs=[
            {id:"model",label:"Model",direction:"target" as const,valueKind:"STRING" as const,
                choices:[{label:"Fast",value:"fast"},{label:"Quality",value:"quality"}]},
            {id:"strength",label:"Strength",direction:"target" as const,valueKind:"FLOAT" as const,
                choices:[{label:"Low",value:0.5},{label:"High",value:1.0}]},
            {id:"steps",label:"Steps",direction:"target" as const,valueKind:"INT" as const,
                choices:[{label:"Fast",value:8},{label:"Slow",value:20}]},
            {id:"enabled",label:"Enabled",direction:"target" as const,valueKind:"BOOLEAN" as const},
            {id:"prompt",label:"Prompt",direction:"target" as const,valueKind:"STRING" as const},
            {id:"video",label:"Video",direction:"source" as const,valueKind:"VIDEO" as const},
        ];
        const canvasPorts=templateInputs.map(({id,label,direction,valueKind})=>({id,label,direction,valueKind}));
        const wf=n("enum-wf",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:canvasPorts});
        expect(getCanvasVisiblePorts(wf).map(p=>p.id)).toEqual(["model","prompt","video"]);
        expect(getCanvasNodePorts(wf)).toEqual(canvasPorts);
        expect(getCanvasPortOffset(wf,"target","model")).toBe(CANVAS_PORT_EDGE_PADDING);
        const text=n("text",CanvasNodeType.Text,{content:"fast"});
        expect(link(h("text","source"),h("enum-wf","target","model"),[text,wf],[]).connection)
            .toMatchObject({toPortId:"model"});
        expect(getCanvasVisiblePorts(wf).every(p=>p.direction!=="target"||
            !["INT","FLOAT","BOOLEAN"].includes(p.valueKind))).toBe(true);
    });
    it("binding many scalar fields does not grow node just for hidden sockets",()=>{
        const many:CanvasPortDescriptor[]=[
            ...Array.from({length:18},(_,i)=>({id:"scalar-"+i,label:"Scalar",direction:"target" as const,
                valueKind:(i%2?"BOOLEAN":"INT") as "INT"|"BOOLEAN"})),
            {id:"prompt",label:"Prompt",direction:"target",valueKind:"STRING"},
            {id:"out",label:"Output",direction:"source",valueKind:"VIDEO"}
        ];
        const bound=applyNodeConfigPatch(n("wf",COMFY_WORKFLOW_MOCK_TYPE),{comfyPorts:many});
        expect(bound.height).toBe(265);
        expect(getCanvasVisiblePorts(bound).map(p=>p.id)).toEqual(["prompt","out"]);
        expect(bound.metadata?.comfyPorts).toHaveLength(many.length);
    });
    it("does not invalidate already-saved INT links if the source and target are declared",()=>{
        const wf=n("wf",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:ports});
        const producer=n("producer",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:[
            {id:"value",label:"Value",direction:"source",valueKind:"INT"}
        ]});
        const edge:CanvasConnection={id:"legacy-scalar",fromNodeId:"producer",fromPortId:"value",
            toNodeId:"wf",toPortId:"steps"};
        expect(getCanvasVisiblePorts(wf).some(p=>p.id==="steps")).toBe(false);
        expect(validateCanvasPortConnections([producer,wf],[edge])).toEqual([]);
        expect(getCanvasPortAnchor(wf,"target","steps").y).toBe(wf.position.y+wf.height/2);
        expect(pickCanvasDropHandle(wf,h("producer","source","value"),wf.position.y+wf.height/2)?.portId).not.toBe("steps");
    });
});

describe("Dense Comfy port hover hitboxes", () => {
    const inputPorts: CanvasPortDescriptor[] = Array.from({ length: 11 }, (_, index) => ({
        id: "input-" + index, label: "Input " + index, direction: "target" as const, valueKind: "IMAGE" as const,
    }));
    const outputPort: CanvasPortDescriptor = {id:"image",label:"Image",direction:"source",valueKind:"IMAGE"};
    const ports = [...inputPorts,outputPort];

    function expectIndependentHitboxes(node: CanvasNodeData) {
        const hit = getCanvasPortHitSize(node, "target");
        const ys = inputPorts.map((port) => getCanvasPortOffset(node, "target", port.id));
        for (let index=0;index<ys.length;index++) {
            // Every circle and its hit region must be independent, including the last few ports.
            const picked = pickCanvasDropHandle(node, h("source", "source", "value"), node.position.y + ys[index]);
            expect(picked?.portId).toBe(inputPorts[index].id);
            expect(getCanvasPortAnchor(node, "target", inputPorts[index].id).y).toBe(node.position.y + ys[index]);
            if (index) expect(ys[index] - ys[index-1]).toBeGreaterThanOrEqual(hit + 1.9);
        }
    }

    it("older saved 265px nodes with 11 ports have non-overlapping hitboxes on every interface", () => {
        const old = n("dense", COMFY_WORKFLOW_MOCK_TYPE, {comfyPorts:ports});
        expect(old.height).toBe(265);
        const hit = getCanvasPortHitSize(old, "target");
        expect(hit).toBeGreaterThan(12);
        expect(hit).toBeLessThan(20); // previously fixed 48px and overlapped almost 3 ports
        expectIndependentHitboxes(old);
    });

    it("binding 11 inputs grows node to ergonomic port spacing, and repeated edits do not shrink it", () => {
        const old = n("dense", COMFY_WORKFLOW_MOCK_TYPE);
        const bound = applyNodeConfigPatch(old, {comfyPorts:ports});
        expect(bound.height).toBe(getMinimumCanvasPortNodeHeight(ports));
        expect(bound.position).toEqual(old.position);
        expect(getCanvasPortHitSize(bound,"target")).toBe(28);
        expectIndependentHitboxes(bound);
        const resized={...bound,height:bound.height+150};
        expect(applyNodeConfigPatch(resized,{comfyPorts:ports}).height).toBe(resized.height);
        expect(bound.height).toBeGreaterThanOrEqual(CANVAS_PORT_EDGE_PADDING * 2 + (inputPorts.length-1)*CANVAS_PORT_MIN_PITCH);
    });

    it("1 typed output is at the exact vertical center of the node, same as legacy single handle", () => {
        const typed = n("typed", COMFY_WORKFLOW_MOCK_TYPE, {comfyPorts: [{id:"out",label:"Output",direction:"source",valueKind:"IMAGE"}]});
        const legacy = n("legacy",CanvasNodeType.Image);
        expect(getCanvasPortOffset(typed,"source","out")).toBe(typed.height/2);
        expect(getCanvasPortAnchor(typed,"source","out").y).toBe(getCanvasPortAnchor(legacy,"source").y);
        expect(pickCanvasDropHandle(typed,h("other","target"),typed.position.y+typed.height/2)?.portId).toBe("out");
    });

    it("2 ports are symmetric about the node's vertical midpoint, with centered hit regions", () => {
        const typed = n("typed", COMFY_WORKFLOW_MOCK_TYPE, {comfyPorts: [
            {id:"a",label:"A",direction:"target",valueKind:"STRING"},
            {id:"b",label:"B",direction:"target",valueKind:"STRING"},
        ]});
        const a = getCanvasPortOffset(typed,"target","a");
        const b = getCanvasPortOffset(typed,"target","b");
        expect((a+b)/2).toBe(typed.height/2);
        expect(a).toBe(CANVAS_PORT_EDGE_PADDING);
        expect(b).toBe(typed.height-CANVAS_PORT_EDGE_PADDING);
        expect(getCanvasPortAnchor(typed,"target","a").y).toBe(typed.position.y+a);
        expect(getCanvasPortAnchor(typed,"target","b").y).toBe(typed.position.y+b);
    });

    it("11 inputs and one output all share the legacy vertical midpoint as the center of their port groups", () => {
        for(const height of [265,getMinimumCanvasPortNodeHeight(ports),520]){
            const typed={...n("centered",COMFY_WORKFLOW_MOCK_TYPE,{comfyPorts:ports}),height};
            const first=getCanvasPortOffset(typed,"target","input-0");
            const last=getCanvasPortOffset(typed,"target","input-10");
            const middle=getCanvasPortOffset(typed,"target","input-5");
            expect((first+last)/2).toBe(typed.height/2);
            expect(middle).toBe(typed.height/2);
            expect(getCanvasPortOffset(typed,"source","image")).toBe(typed.height/2);
            const legacy=n("legacy",CanvasNodeType.Text);
            legacy.height=height;
            expect(getCanvasPortAnchor(typed,"source","image").y).toBe(getCanvasPortAnchor(legacy,"source").y);
            expectIndependentHitboxes(typed);
        }
    });

    it("legacy connector geometry/size and sparse Comfy connectors are unaffected", () => {
        expect(getCanvasPortHitSize(n("legacy",CanvasNodeType.Text),"source")).toBe(28);
        expect(getMinimumCanvasPortNodeHeight(MOCK_COMFY_PORTS)).toBe(160);
        expect(getCanvasPortOffset(n("legacy",CanvasNodeType.Text),"source","missing")).toBe(132.5);
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
