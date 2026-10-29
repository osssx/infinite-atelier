import { createHash } from "node:crypto";
import { prepareCapture } from "./capture-adapters.mjs";
import {validCanvasNodeId} from "../canvas-node-id.mjs";

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
            if(has(port,"choices")){
                if(b?.mode!=="literal"||!["STRING","INT","FLOAT"].includes(port.valueKind)||
                    !Array.isArray(port.choices)||port.choices.length<1||port.choices.length>64)
                    fail("template_enum_kind_invalid");
                const seen=new Set();
                for(const option of port.choices){
                    if(!object(option)||typeof option.label!=="string"||!option.label.trim()||
                        option.label.length>90||/[|\r\n]/.test(option.label)||
                        (port.valueKind==="STRING"&&/[\r\n]/.test(option.value))||
                        !matchValue(port.valueKind,option.value))
                        fail("template_enum_value_invalid");
                    const key=typeof option.value+":"+String(option.value);
                    if(seen.has(key))fail("template_enum_duplicate_value");
                    seen.add(key);
                }
                if(has(port,"defaultValue")&&!port.choices.some(o=>Object.is(o.value,port.defaultValue)))
                    fail("template_enum_default_invalid");
            }
            if (!b || !["literal","media-file","socket"].includes(b.mode) || !Array.isArray(b.targets) || !b.targets.length) fail("template_input_binding_invalid");
            if (port.absentPolicy?.mode === "auto-prune" &&
                (port.required || !["IMAGE","VIDEO","AUDIO"].includes(port.valueKind) ||
                    !["socket","media-file"].includes(b.mode) || has(port,"defaultValue")))
                fail("template_auto_prune_invalid");
            for (const t of b.targets) {
                if (!has(apiGraph,t.nodeId) || !has(apiGraph[t.nodeId].inputs,t.inputName)) fail("template_binding_missing");
                const key = t.nodeId + "\0" + t.inputName;
                if (claims.has(key)) fail("template_duplicate_claim");
                claims.add(key);
            }
        } else {
            if(has(port,"choices"))fail("template_enum_output_invalid");
            if(!port.outputBinding || !has(apiGraph,port.outputBinding.nodeId) ||
                !Number.isInteger(port.outputBinding.outputIndex) || port.outputBinding.outputIndex<0)fail("template_output_invalid");
            if(!port.capture || !["none","image","video","audio","text"].includes(port.capture.kind))fail("template_capture_invalid");
            if(port.capture.kind!=="none" && ({image:"IMAGE",video:"VIDEO",audio:"AUDIO",text:"STRING"})[port.capture.kind]!==port.valueKind)
                fail("template_capture_kind_mismatch");
            if(port.capture.kind!=="none" && !["SaveImage","SaveVideo","SaveAudio","SaveText"].includes(port.capture.adapterId))
                fail("capture_adapter_unsupported");
        }
    }
    const {id,revision,...payload} = template;
    if (sha256(canonical({name:payload.name,apiGraph:payload.apiGraph,ports:payload.ports,requirements:payload.requirements})) !== revision) fail("template_revision_mismatch");
    const graphBytes = Buffer.byteLength(canonical(apiGraph));
    if (graphBytes > 2_000_000) fail("template_graph_too_large");
    validateGraph(apiGraph);
    return template;
}

// V3 dynamic inputs serialize as dotted leaf keys; their declaration is in /object_info.
// AUTOGROW has no parent value: "values.a" exists, "values" does not.
// Only accept schema-declared names / prefixes, never arbitrary dotted inputs.
function autogrowSlots(selector) {
    if(selector?.[0]!=="COMFY_AUTOGROW_V3")return null;
    const template=selector[1]?.template;
    const min=template?.min;
    const names=Array.isArray(template?.names) ? template.names :
        typeof template?.prefix==="string" && Number.isInteger(template.max) && template.max>=1 && template.max<=100
            ? Array.from({length:template.max},(_,i)=>template.prefix+i) : null;
    if(!Number.isInteger(min) || min<0 || !names || names.length>100 || min>names.length ||
        names.some(name=>!validId(name)) || new Set(names).size!==names.length)
        fail("comfy_autogrow_schema_invalid");
    return {names,min};
}
function hasDeclaredInput(node,schema,input) {
    const direct=schema?.input?.required?.[input] ?? schema?.input?.optional?.[input];
    if(direct)return direct[0]!=="COMFY_AUTOGROW_V3";
    const dot=input.indexOf(".");
    if(dot<=0)return false;
    const root=input.slice(0,dot),suffix=input.slice(dot+1);
    const selector=schema?.input?.required?.[root] ?? schema?.input?.optional?.[root];
    if(selector?.[0]==="COMFY_AUTOGROW_V3")return autogrowSlots(selector).names.includes(suffix);
    if(selector?.[0]!=="COMFY_DYNAMICCOMBO_V3" || typeof node.inputs[root]!=="string")return false;
    const option=selector[1]?.options?.find(o=>o.key===node.inputs[root]);
    return Boolean(option && (has(option.inputs?.required??{},suffix) || has(option.inputs?.optional??{},suffix)));
}
/** Resolve readable aspect-ratio shortcuts against this ComfyUI instance's live
 * COMBO choices. Do not invent labels or widen acceptance of unrelated strings.
 */
function normalizeComfyEnumInputs(graph, info, trustedStagedFields) {
    if(!info)return;
    for(const [nodeId,node] of Object.entries(graph)) {
        const schema=info[node.class_type]?.input;
        for(const [key,value] of Object.entries(node.inputs)) {
            if(typeof value!=="string")continue;
            // /object_info was fetched before staged media arrived. Only a
            // precisely bound field replaced with an authenticated CAS filename
            // may bypass a stale upload-widget enum; never other template fields.
            if(trustedStagedFields.has(nodeId+"\0"+key))continue;
            const declaration=schema?.required?.[key] ?? schema?.optional?.[key];
            const values=Array.isArray(declaration?.[0]) ? declaration[0] :
                declaration?.[0]==="COMBO" && Array.isArray(declaration?.[1]?.options)
                    ? declaration[1].options : null;
            const choices=Array.isArray(values)&&values.every(choice=>typeof choice==="string")?values:null;
            if(!choices)continue;
            if(choices.includes(value))continue;
            // Comfy's resource widgets require the installed path exactly. Re-imported
            // templates can retain stale directory names; resolve only if the model
            // filename identifies exactly one installed resource (never fuzzy matching).
            if(node.class_type==="LoraLoaderModelOnly" && key==="lora_name" &&
                /\.safetensors$/i.test(value)) {
                const norm=s=>s.replaceAll("\\","/").toLowerCase();
                const fullMatches=choices.filter(choice=>norm(choice)===norm(value));
                const basename=s=>norm(s).split("/").at(-1);
                const matches=fullMatches.length ? fullMatches :
                    choices.filter(choice=>basename(choice)===basename(value));
                if(matches.length===1){node.inputs[key]=matches[0];continue;}
                const error=matches.length>1?"comfy_model_ambiguous:":"comfy_model_missing:";
                fail(error+node.class_type+"."+key+":"+value);
            }
            const candidates=/^\d{1,3}:\d{1,3}$/.test(value)
                ? choices.filter(choice=>choice.startsWith(value+" (")) : [];
            if(candidates.length===1) node.inputs[key]=candidates[0];
            else fail("comfy_option_invalid:"+node.class_type+"."+key+":"+value);
        }
    }
}
export function validateGraph(graph, info) {
    const visiting = new Set(), seen = new Set();
    function visit(id) {
        if (visiting.has(id)) fail("comfy_graph_cycle");
        if (seen.has(id)) return;
        const node = graph[id];
        if (!node) fail("comfy_graph_dangling");
        const schema = info?.[node.class_type];
        if (info && !schema) fail("comfy_missing_class:" + node.class_type);
        visiting.add(id);
        for (const [input,v] of Object.entries(node.inputs)) {
            if (schema && !hasDeclaredInput(node,schema,input)) fail("comfy_unknown_input:" + input);
            if (isLink(v)) {
                if (v[1] < 0 || !has(graph,v[0])) fail("comfy_graph_dangling");
                const out = info?.[graph[v[0]].class_type]?.output;
                if (out && v[1] >= out.length) fail("comfy_output_index_out_of_range");
                visit(v[0]);
            }
        }
        if (schema?.input?.required) for (const [name,selector] of Object.entries(schema.input.required)) {
            const autogrow=autogrowSlots(selector);
            if(autogrow) {
                for(const slot of autogrow.names.slice(0,autogrow.min))
                    if(!has(node.inputs,name+"."+slot))fail("comfy_required_input_missing:"+name+"."+slot);
            } else if(!has(node.inputs,name))fail("comfy_required_input_missing:"+name);
        }
        visiting.delete(id);seen.add(id);
    }
    for (const id of Object.keys(graph)) visit(id);
}

export function validateSingleRequest(req) {
    if(!object(req) || req.schemaVersion!==2)fail("unsupported_schema_version",400);
    if (!validId(req.projectId) || !validId(req.instanceId) ||
        typeof req.canvasRevision !== "string" || req.canvasRevision.length > 128 ||
        !validId(req.idempotencyKey) || !Array.isArray(req.nodes) || req.nodes.length !== 1 ||
        !Array.isArray(req.rootOutputs) || req.rootOutputs.length<1 || req.rootOutputs.length>16 ||
        !Array.isArray(req.edges) || req.edges.length > 64 || !Array.isArray(req.externalInputs) || req.externalInputs.length > 64)
        fail("single_workflow_request_required",400);
    if (Buffer.byteLength(canonical(req)) > 1_000_000) fail("run_request_too_large",413);
    const node=req.nodes[0], roots=req.rootOutputs;
    if (!validCanvasNodeId(node.id) || !validId(node.templateId) || !validSha(node.templateRevision) ||
        !object(node.inputOverrides) || roots.some(root=>root.nodeId!==node.id || !validId(root.portId)) ||
        new Set(roots.map(root=>root.portId)).size!==roots.length)fail("run_node_invalid");
    if (!object(req.runOptions) || Object.keys(req.runOptions).length) fail("run_options_unsupported");
    const inputs = new Map(), targetEdges = new Map();
    for (const x of req.externalInputs) {
        if (!object(x) || !validCanvasNodeId(x.sourceNodeId) || !validId(x.sourcePortId) ||
            x.sourceNodeId === node.id || !["text","image","video","audio"].includes(x.sourcePortId) ||
            !["scalar","asset"].includes(x.kind)) fail("external_input_invalid");
        if (x.kind === "scalar" && (x.sourcePortId !== "text" || x.valueKind !== "STRING" || !matchValue("STRING",x.value))) fail("external_scalar_invalid");
        if (x.kind === "asset" && (({image:"IMAGE",video:"VIDEO",audio:"AUDIO"})[x.sourcePortId] !== x.valueKind || !validId(x.assetId) || !validSha(x.sha256))) fail("external_asset_invalid");
        const key = x.sourceNodeId+"\0"+x.sourcePortId;
        if (inputs.has(key)) fail("duplicate_external_source");
        inputs.set(key,x);
    }
    const used = new Set();
    for (const e of req.edges) {
        if (!object(e) || !validCanvasNodeId(e.fromNodeId) || !validId(e.fromPortId) ||
            e.toNodeId !== node.id || !validId(e.toPortId) || e.fromNodeId === node.id) fail("only_external_source_edges_allowed");
        const source=e.fromNodeId+"\0"+e.fromPortId;
        if (!inputs.has(source)) fail("missing_external_snapshot");
        if (targetEdges.has(e.toPortId)) fail("multiple_sources_for_input");
        targetEdges.set(e.toPortId,inputs.get(source));used.add(source);
    }
    if (used.size !== inputs.size) fail("unreferenced_external_input");
    return {node,roots,targetEdges};
}

export function fingerprintRequest(req) {
    // Identity of a staged asset is temporary; the verified content digest is not.
    const stable = JSON.parse(canonical(req));
    delete stable.idempotencyKey;
    delete stable.canvasRevision;
    for (const x of stable.externalInputs) if (x.kind === "asset") delete x.assetId;
    stable.rootOutputs.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    stable.edges.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    stable.externalInputs.sort((a,b)=>canonical(a).localeCompare(canonical(b)));
    return sha256(canonical(stable));
}

/**
 * Missing optional media must be omitted from the actual Comfy prompt. For socket
 * bindings this is the bound input itself. For file-backed LoadImage/Audio/Video
 * chains, cut references at declared optional consumers, then let normal
 * reachability pruning discard the file loader and any unused processing nodes.
 * Never remove an /object_info required field on a live node.
 */
function pruneAbsentMediaPort(graph, port, canvasNodeId, info) {
    if (!info) fail("comfy_auto_prune_object_info_required:"+port.id);
    const fields = port.inputBinding.targets;
    const pending = [];
    for (const field of fields) {
        const id=nodeKey(canvasNodeId,field.nodeId),n=graph[id];
        if(!n || !has(n.inputs,field.inputName))fail("comfy_auto_prune_target_missing:"+port.id);
        const schema=info[n.class_type]?.input;
        if(!schema)fail("comfy_auto_prune_schema_missing:"+n.class_type);
        if(has(schema.optional??{},field.inputName)) {
            delete n.inputs[field.inputName];
        } else if(port.inputBinding.mode==="media-file" &&
            has(schema.required??{},field.inputName) &&
            info[n.class_type]?.output?.includes(port.valueKind)) {
            // Loader's file widget is required. Remove it by disconnecting
            // its optional downstream consumers, never by submitting an empty filename.
            pending.push(id);
        } else {
            fail("comfy_auto_prune_required_input:"+n.class_type+"."+field.inputName);
        }
    }
    const visited=new Set();
    while(pending.length) {
        const source=pending.pop();
        if(visited.has(source))continue;
        visited.add(source);
        for(const [consumerId,consumer] of Object.entries(graph)) {
            for(const [input,value] of Object.entries(consumer.inputs)) {
                if(!isLink(value)||value[0]!==source)continue;
                const schema=info[consumer.class_type]?.input;
                if(!schema)fail("comfy_auto_prune_schema_missing:"+consumer.class_type);
                if(has(schema.optional??{},input)) {
                    delete consumer.inputs[input];
                } else if(has(schema.required??{},input)) {
                    // An intermediate required processing node may be abandoned
                    // when its entire branch becomes unreachable. If it remains
                    // reachable the compiler will fail rather than silently omit it.
                    pending.push(consumerId);
                } else {
                    fail("comfy_auto_prune_unknown_input:"+consumer.class_type+"."+input);
                }
            }
        }
    }
}

/** One pinned Comfy graph, one /prompt, any selected combination of supported output roots. */
export function compileSingleWorkflow(req, template, opts = {}) {
    const {node,roots,targetEdges} = validateSingleRequest(req);
    verifyTemplate(template);
    if (node.templateId !== template.id || node.templateRevision !== template.revision) fail("template_revision_unavailable");
    const ports = new Map(template.ports.map(p=>[p.id,p]));
    const outputs=roots.map(root=>{
        const output=ports.get(root.portId);
        if(!output || output.direction!=="source" || !output.capture || output.capture.kind==="none")
            fail("capture_output_invalid:"+root.portId);
        return output;
    });
    if (!opts.info?.LoadImage?.output?.includes("IMAGE") &&
        template.ports.some(p=>p.direction==="target"&&p.valueKind==="IMAGE"&&
         p.inputBinding?.mode==="socket"&&targetEdges.has(p.id))) fail("image_loader_missing");
    const graph = Object.create(null);
    for (const [id,n] of Object.entries(template.apiGraph)) {
        const inputs = JSON.parse(canonical(n.inputs));
        for (const [name,v] of Object.entries(inputs)) if (isLink(v)) inputs[name] = [nodeKey(node.id,v[0]),v[1]];
        graph[nodeKey(node.id,id)] = {...n, inputs};
    }
    const decisions = Object.create(null);
    const trustedStagedFields=new Set();
    const absentMediaPorts=[];
    for (const p of template.ports.filter(p=>p.direction==="target")) {
        const binding=p.inputBinding;
        const edge=targetEdges.get(p.id);
        const override=has(node.inputOverrides,p.id);
        const def=has(p,"defaultValue") && binding.mode==="literal";
        const choice = edge ? "edge" : override ? "override" : def ? "default" :
            p.absentPolicy?.mode === "auto-prune" ? "auto-prune" :
            p.absentPolicy?.mode === "disconnect" ? "disconnect" : "template";
        decisions[p.id]=choice;
        if (choice === "auto-prune") {
            pruneAbsentMediaPort(graph,p,node.id,opts.info);
            absentMediaPorts.push(p);
            continue;
        }
        if (choice === "disconnect") {
            for (const t of p.absentPolicy.removeInputs) delete graph[nodeKey(node.id,t.nodeId)]?.inputs[t.inputName];
            for (const rm of p.absentPolicy.removeNodes) delete graph[nodeKey(node.id,rm)];
            continue;
        }
        if (choice === "template") {
            if(p.choices){
                for(const t of binding.targets){
                    const current=graph[nodeKey(node.id,t.nodeId)]?.inputs[t.inputName];
                    if(!p.choices.some(item=>Object.is(item.value,current)))
                        fail("literal_enum_selection_required:"+p.id);
                }
            }
            if (p.required && binding.targets.some(t => graph[nodeKey(node.id,t.nodeId)]?.inputs[t.inputName] === undefined))
                fail("required_input_missing:"+p.id);
            // A template filename is not an uploaded, immutable input. Require a typed canvas edge.
            if (binding.mode === "media-file") fail("media_input_requires_connection:"+p.id);
            continue;
        }
        const v = choice === "edge" ? edge : choice === "override" ? node.inputOverrides[p.id] : p.defaultValue;
        if (choice === "edge" && edge.valueKind !== p.valueKind) fail("source_type_mismatch:"+p.id);
        let resolved;
        if (binding.mode === "literal") {
            resolved = choice === "edge" ? v.value : v;
            if (!matchValue(p.valueKind,resolved) || (choice === "edge" && v.kind !== "scalar")) fail("literal_input_invalid:"+p.id);
            if(choice==="override" && p.choices && !p.choices.some(item=>Object.is(item.value,resolved)))
                fail("literal_enum_value_invalid:"+p.id);
        } else if (binding.mode === "media-file") {
            if (!edge || edge.kind !== "asset" || !["IMAGE","VIDEO","AUDIO"].includes(p.valueKind) ||
                binding.mediaKind !== p.valueKind) fail("media_file_binding_invalid:"+p.id);
            resolved = (opts.mediaFiles??opts.imageFiles)?.[edge.assetId];
            if (!resolved || !/^[A-Za-z0-9_.-]{1,160}$/.test(resolved)) fail("staged_media_not_uploaded");
            for (const t of binding.targets)
                trustedStagedFields.add(nodeKey(node.id,t.nodeId)+"\0"+t.inputName);
        } else if (binding.mode === "socket") {
            if (!edge || edge.kind !== "asset" || p.valueKind !== "IMAGE" ||
                (!binding.replaceInternalLink && binding.targets.some(t=>isLink(template.apiGraph[t.nodeId].inputs[t.inputName])))) fail("socket_bridge_invalid:"+p.id);
            const filename=(opts.mediaFiles??opts.imageFiles)?.[edge.assetId];
            if (!filename || !/^[A-Za-z0-9_.-]{1,160}$/.test(filename)) fail("staged_image_not_uploaded");
            const loaderId=nodeKey(node.id,"loader_"+p.id);
            if (graph[loaderId]) fail("generated_node_collision");
            graph[loaderId]={class_type:"LoadImage",inputs:{image:filename}};
            trustedStagedFields.add(loaderId+"\0image");
            resolved=[loaderId,0];
        } else fail("unsupported_binding_mode");
        for (const t of binding.targets) {
            const target=graph[nodeKey(node.id,t.nodeId)];
            if (!target || !has(target.inputs,t.inputName)) fail("binding_target_missing");
            target.inputs[t.inputName]=resolved;
            if(binding.mode==="media-file" && target.class_type==="LoadImage" && t.inputName==="image")
                trustedStagedFields.add(nodeKey(node.id,t.nodeId)+"\0"+t.inputName);
        }
    }
    for (const targetId of targetEdges.keys()) if (!ports.has(targetId) || ports.get(targetId).direction!=="target") fail("input_port_not_found");
    const captures=[];
    for(const output of outputs) {
        const binding=output.outputBinding, src=nodeKey(node.id,binding.nodeId);
        if(!graph[src])fail("capture_source_missing");
        const actual=opts.info?.[graph[src].class_type]?.output?.[binding.outputIndex];
        if(actual!==output.valueKind && actual!=="*")fail("capture_source_type_invalid");
        captures.push(prepareCapture(graph,output,src,"w_"+node.id+"__",opts.info));
    }
    // Capture root injection is deliberately BEFORE reachability pruning.
    const reachable=new Set();
    const visit=(id)=>{
        if (reachable.has(id)) return;
        const n=graph[id];
        if (!n) fail("graph_dangling_after_disconnection");
        reachable.add(id);
        for (const v of Object.values(n.inputs)) if (isLink(v)) visit(v[0]);
    };
    for(const cap of captures)visit(cap.captureNodeId);
    for (const id of Object.keys(graph)) if (!reachable.has(id)) delete graph[id];
    for (const p of absentMediaPorts) for (const t of p.inputBinding.targets) {
        const remaining=graph[nodeKey(node.id,t.nodeId)];
        if(remaining && has(remaining.inputs,t.inputName))
            fail("comfy_auto_prune_media_still_reachable:"+p.id);
    }
    if(absentMediaPorts.length) for(const p of template.ports) {
        const edge=targetEdges.get(p.id);
        if(!edge || p.direction!=="target" || !["media-file","socket"].includes(p.inputBinding?.mode))continue;
        const expected=p.inputBinding.mode==="media-file"?(opts.mediaFiles??opts.imageFiles)?.[edge.assetId]:
            [nodeKey(node.id,"loader_"+p.id),0];
        for(const t of p.inputBinding.targets) {
            const remaining=graph[nodeKey(node.id,t.nodeId)];
            if(!remaining || !has(remaining.inputs,t.inputName) ||
                canonical(remaining.inputs[t.inputName])!==canonical(expected))
                fail("comfy_supplied_media_pruned:"+p.id);
        }
    }
    normalizeComfyEnumInputs(graph,opts.info,trustedStagedFields);
    validateGraph(graph,opts.info);
    if (Object.keys(graph).length>500) fail("compiled_graph_too_large");
    return {graph,graphHash:sha256(canonical(graph)),captureMap:captures,decisions};
}
