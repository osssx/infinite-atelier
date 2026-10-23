import { createHash } from "node:crypto";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fail = (code, status = 422) => { throw Object.assign(new Error(code), { code, status }); };
export function canonical(value) {
    const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
            const o = Object.create(null);
            for (const key of Object.keys(v).sort()) {
                if (["__proto__", "prototype", "constructor"].includes(key)) fail("unsafe_json_key");
                if (v[key] !== undefined) o[key] = walk(v[key]);
            }
            return o;
        }
        if (typeof v === "number" && !Number.isFinite(v)) fail("invalid_number");
        if (v === undefined || typeof v === "function") fail("invalid_json_value");
        return v;
    };
    return JSON.stringify(walk(value));
}
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const validId = (id) => typeof id === "string" && /^[\w:.-]{1,128}$/.test(id);
const validSha = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const isLink = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const matchValue = (kind, v) => ({
    STRING: () => typeof v === "string" && v.length <= 16000,
    INT: () => Number.isSafeInteger(v),
    FLOAT: () => typeof v === "number" && Number.isFinite(v),
    BOOLEAN: () => typeof v === "boolean",
    JSON: () => v !== undefined && canonical(v).length <= 65536,
})[kind]?.() === true;
const nodeKey = (id, internal) => `w_${id}__${internal}`;

export function verifyTemplate(template) {
    if (!object(template) || !validId(template.id) || !validSha(template.revision)) fail("template_identity_invalid");
    const {name, apiGraph, ports, requirements} = template;
    if (typeof name !== "string" || !name.trim() || !object(apiGraph) || !Array.isArray(ports) || !object(requirements)) fail("template_invalid");
    if (!Object.keys(apiGraph).length || Object.keys(apiGraph).length > 500 || ports.length > 64) fail("template_limits");
    const classes = [...new Set(Object.values(apiGraph).map(n => n?.class_type))].sort();
    if (!Array.isArray(requirements.classTypes) || canonical(classes) !== canonical(requirements.classTypes)) fail("template_requirements_invalid");
    const ids = new Set(), claims = new Set();
    for (const [id, node] of Object.entries(apiGraph)) {
        if (!validId(id) || !validId(node?.class_type) || !object(node?.inputs)) fail("template_graph_invalid");
        for (const [input, value] of Object.entries(node.inputs)) {
            if (!validId(input)) fail("template_input_invalid");
            if (isLink(value) && (!has(apiGraph, value[0]) || value[1] < 0)) fail("template_dangling_link");
        }
    }
    for (const port of ports) {
        if (!validId(port?.id) || ids.has(port.id) || !["target","source"].includes(port.direction) || typeof port.valueKind !== "string") fail("template_port_invalid");
        ids.add(port.id);
        if (port.direction === "target") {
            const b = port.inputBinding;
            if (!b || !["literal","media-file","socket"].includes(b.mode) || !Array.isArray(b.targets) || !b.targets.length) fail("template_input_binding_invalid");
            for (const t of b.targets) {
                if (!has(apiGraph,t.nodeId) || !has(apiGraph[t.nodeId].inputs,t.inputName)) fail("template_binding_missing");
                const key = t.nodeId + "\0" + t.inputName;
                if (claims.has(key)) fail("template_duplicate_claim");
                claims.add(key);
            }
        } else if (!port.outputBinding || !has(apiGraph,port.outputBinding.nodeId) || !Number.isInteger(port.outputBinding.outputIndex) || port.outputBinding.outputIndex < 0) fail("template_output_invalid");
    }
    const {id,revision,...payload} = template;
    if (sha256(canonical({name:payload.name,apiGraph:payload.apiGraph,ports:payload.ports,requirements:payload.requirements})) !== revision) fail("template_revision_mismatch");
    const graphBytes = Buffer.byteLength(canonical(apiGraph));
    if (graphBytes > 2_000_000) fail("template_graph_too_large");
    validateGraph(apiGraph);
    return template;
}

export function validateGraph(graph, info, allowClasses) {
    const visiting = new Set(), seen = new Set();
    function visit(id) {
        if (visiting.has(id)) fail("comfy_graph_cycle");
        if (seen.has(id)) return;
        const node = graph[id];
        if (!node) fail("comfy_graph_dangling");
        if (allowClasses && !allowClasses.has(node.class_type)) fail("comfy_class_not_allowlisted:" + node.class_type);
        const schema = info?.[node.class_type];
        if (info && !schema) fail("comfy_missing_class:" + node.class_type);
        visiting.add(id);
        for (const [input,v] of Object.entries(node.inputs)) {
            const spec = schema?.input;
            if (schema && !has(spec?.required ?? {},input) && !has(spec?.optional ?? {},input)) fail("comfy_unknown_input:" + input);
            if (isLink(v)) {
                if (v[1] < 0 || !has(graph,v[0])) fail("comfy_graph_dangling");
                const out = info?.[graph[v[0]].class_type]?.output;
                if (out && v[1] >= out.length) fail("comfy_output_index_out_of_range");
                visit(v[0]);
            }
        }
        if (schema?.input?.required) for (const name of Object.keys(schema.input.required)) {
            if (!has(node.inputs,name)) fail("comfy_required_input_missing:" + name);
        }
        visiting.delete(id);seen.add(id);
    }
    for (const id of Object.keys(graph)) visit(id);
}

export function validateSingleRequest(req) {
    if (!object(req) || req.schemaVersion !== 1 || !validId(req.projectId) || !validId(req.instanceId) ||
        typeof req.canvasRevision !== "string" || req.canvasRevision.length > 128 ||
        !validId(req.idempotencyKey) || !Array.isArray(req.nodes) || req.nodes.length !== 1 ||
        !Array.isArray(req.rootOutputs) || req.rootOutputs.length !== 1 ||
        !Array.isArray(req.edges) || req.edges.length > 64 || !Array.isArray(req.externalInputs) || req.externalInputs.length > 64)
        fail("single_workflow_request_required",400);
    if (Buffer.byteLength(canonical(req)) > 1_000_000) fail("run_request_too_large",413);
    const node = req.nodes[0], root = req.rootOutputs[0];
    if (!validId(node.id) || !validId(node.templateId) || !validSha(node.templateRevision) ||
        !object(node.inputOverrides) || root.nodeId !== node.id || !validId(root.portId)) fail("run_node_invalid");
    if (!object(req.runOptions) || Object.keys(req.runOptions).some(k => k !== "captureFormat")) fail("run_options_unsupported");
    if (req.runOptions.captureFormat && req.runOptions.captureFormat !== "png") fail("capture_format_unsupported");
    const inputs = new Map(), targetEdges = new Map();
    for (const x of req.externalInputs) {
        if (!object(x) || !validId(x.sourceNodeId) || !validId(x.sourcePortId) ||
            x.sourceNodeId === node.id || !["text","image"].includes(x.sourcePortId) ||
            !["scalar","asset"].includes(x.kind)) fail("external_input_invalid");
        if (x.kind === "scalar" && (x.sourcePortId !== "text" || x.valueKind !== "STRING" || !matchValue("STRING",x.value))) fail("external_scalar_invalid");
        if (x.kind === "asset" && (x.sourcePortId !== "image" || x.valueKind !== "IMAGE" || !validId(x.assetId) || !validSha(x.sha256))) fail("external_asset_invalid");
        const key = x.sourceNodeId+"\0"+x.sourcePortId;
        if (inputs.has(key)) fail("duplicate_external_source");
        inputs.set(key,x);
    }
    const used = new Set();
    for (const e of req.edges) {
        if (!object(e) || !validId(e.fromNodeId) || !validId(e.fromPortId) ||
            e.toNodeId !== node.id || !validId(e.toPortId) || e.fromNodeId === node.id) fail("only_external_source_edges_allowed");
        const source=e.fromNodeId+"\0"+e.fromPortId;
        if (!inputs.has(source)) fail("missing_external_snapshot");
        if (targetEdges.has(e.toPortId)) fail("multiple_sources_for_input");
        targetEdges.set(e.toPortId,inputs.get(source));used.add(source);
    }
    if (used.size !== inputs.size) fail("unreferenced_external_input");
    return {node,root,targetEdges};
}

export function fingerprintRequest(req) {
    // Identity of a staged asset is temporary; the verified content digest is not.
    const stable = JSON.parse(canonical(req));
    delete stable.idempotencyKey;
    delete stable.canvasRevision;
    for (const x of stable.externalInputs) if (x.kind === "asset") delete x.assetId;
    stable.edges.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    stable.externalInputs.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    return sha256(canonical(stable));
}

/** Single pinned workflow graph, explicit IMAGE capture and only selected output root. */
export function compileSingleWorkflow(req, template, opts = {}) {
    const {node,root,targetEdges} = validateSingleRequest(req);
    verifyTemplate(template);
    if (node.templateId !== template.id || node.templateRevision !== template.revision) fail("template_revision_unavailable");
    const ports = new Map(template.ports.map(p=>[p.id,p]));
    const output = ports.get(root.portId);
    if (!output || output.direction !== "source" || output.valueKind !== "IMAGE" ||
        output.capture?.kind !== "image" || output.capture.adapterId !== "SaveImage") fail("single_image_capture_required");
    if (!opts.info?.SaveImage?.input?.required?.images) fail("capture_adapter_missing");
    if (!opts.info?.LoadImage?.output?.includes("IMAGE") && req.externalInputs.some(x=>x.kind==="asset")) fail("image_loader_missing");
    const graph = Object.create(null);
    for (const [id,n] of Object.entries(template.apiGraph)) {
        const inputs = JSON.parse(canonical(n.inputs));
        for (const [name,v] of Object.entries(inputs)) if (isLink(v)) inputs[name] = [nodeKey(node.id,v[0]),v[1]];
        graph[nodeKey(node.id,id)] = {...n, inputs};
    }
    const decisions = Object.create(null);
    for (const p of template.ports.filter(p=>p.direction==="target")) {
        const binding=p.inputBinding;
        const edge=targetEdges.get(p.id);
        const override=has(node.inputOverrides,p.id);
        const def=has(p,"defaultValue");
        const choice = edge ? "edge" : override ? "override" : def ? "default" :
            p.absentPolicy?.mode === "disconnect" ? "disconnect" : "template";
        decisions[p.id]=choice;
        if (choice === "disconnect") {
            for (const t of p.absentPolicy.removeInputs) delete graph[nodeKey(node.id,t.nodeId)]?.inputs[t.inputName];
            for (const rm of p.absentPolicy.removeNodes) delete graph[nodeKey(node.id,rm)];
            continue;
        }
        if (choice === "template") {
            if (p.required && binding.targets.some(t => graph[nodeKey(node.id,t.nodeId)]?.inputs[t.inputName] === undefined))
                fail("required_input_missing:"+p.id);
            if (binding.mode === "media-file") fail("untrusted_template_file:"+p.id);
            continue;
        }
        const v = choice === "edge" ? edge : choice === "override" ? node.inputOverrides[p.id] : p.defaultValue;
        if (choice === "edge" && edge.valueKind !== p.valueKind) fail("source_type_mismatch:"+p.id);
        let resolved;
        if (binding.mode === "literal") {
            resolved = choice === "edge" ? v.value : v;
            if (!matchValue(p.valueKind,resolved) || (choice === "edge" && v.kind !== "scalar")) fail("literal_input_invalid:"+p.id);
        } else if (binding.mode === "media-file") {
            if (!edge || edge.kind !== "asset" || p.valueKind !== "IMAGE" || binding.mediaKind !== "IMAGE") fail("media_file_binding_invalid:"+p.id);
            resolved = opts.imageFiles?.[edge.assetId];
            if (!resolved || !/^[A-Za-z0-9_.-]{1,160}$/.test(resolved)) fail("staged_image_not_uploaded");
        } else if (binding.mode === "socket") {
            if (!edge || edge.kind !== "asset" || p.valueKind !== "IMAGE" ||
                (!binding.replaceInternalLink && binding.targets.some(t=>isLink(template.apiGraph[t.nodeId].inputs[t.inputName])))) fail("socket_bridge_invalid:"+p.id);
            const filename=opts.imageFiles?.[edge.assetId];
            if (!filename || !/^[A-Za-z0-9_.-]{1,160}$/.test(filename)) fail("staged_image_not_uploaded");
            const loaderId=nodeKey(node.id,"loader_"+p.id);
            if (graph[loaderId]) fail("generated_node_collision");
            graph[loaderId]={class_type:"LoadImage",inputs:{image:filename}};
            resolved=[loaderId,0];
        } else fail("unsupported_binding_mode");
        for (const t of binding.targets) {
            const target=graph[nodeKey(node.id,t.nodeId)];
            if (!target || !has(target.inputs,t.inputName)) fail("binding_target_missing");
            target.inputs[t.inputName]=resolved;
        }
    }
    for (const targetId of targetEdges.keys()) if (!ports.has(targetId) || ports.get(targetId).direction!=="target") fail("input_port_not_found");
    const binding=output.outputBinding;
    const src=nodeKey(node.id,binding.nodeId);
    if (!graph[src]) fail("capture_source_missing");
    const slot=opts.info[graph[src].class_type]?.output;
    if (!slot || slot[binding.outputIndex] !== "IMAGE") fail("capture_source_type_invalid");
    const captureId=nodeKey(node.id,"capture_"+output.id);
    if (graph[captureId]) fail("generated_node_collision");
    graph[captureId]={class_type:"SaveImage",inputs:{images:[src,binding.outputIndex],filename_prefix:"infinite_atelier"}};
    // Capture root injection is deliberately BEFORE reachability pruning.
    const reachable=new Set();
    const visit=(id)=>{
        if (reachable.has(id)) return;
        const n=graph[id];
        if (!n) fail("graph_dangling_after_disconnection");
        reachable.add(id);
        for (const v of Object.values(n.inputs)) if (isLink(v)) visit(v[0]);
    };
    visit(captureId);
    for (const id of Object.keys(graph)) if (!reachable.has(id)) delete graph[id];
    validateGraph(graph,opts.info,opts.allowClasses);
    if (Object.keys(graph).length>500) fail("compiled_graph_too_large");
    return {graph,graphHash:sha256(canonical(graph)),captureMap:[{workflowNodeId:node.id,portId:output.id,captureNodeId:captureId}],decisions};
}
