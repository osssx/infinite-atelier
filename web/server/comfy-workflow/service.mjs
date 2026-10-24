import { randomUUID } from "node:crypto";
import { readFileSync,createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extractCapture } from "./capture-adapters.mjs";
import { fileURLToPath } from "node:url";
import { createComfyStore } from "./store.mjs";
import { compileSingleWorkflow, verifyTemplate, validateSingleRequest, fingerprintRequest, canonical, sha256, validateGraph } from "./compiler.mjs";

const statusError = (code,status=422)=>Object.assign(new Error(code),{status,code});
const isImage = (b,mime)=>mime==="image/png" && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    mime==="image/jpeg" && b[0]===255 && b[1]===216 && b[2]===255 ||
    mime==="image/webp" && b.toString("ascii",0,4)==="RIFF" && b.toString("ascii",8,12)==="WEBP";
function configureInstances(env) {
    const source=env.COMFY_INSTANCES_JSON || '[{"id":"comfy-local","url":"http://127.0.0.1:8188"}]';
    const parsed=JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length>16) throw new Error("COMFY_INSTANCES_JSON invalid");
    const instances=new Map();
    for (const item of parsed) {
        if (!/^[\w:-]{1,64}$/.test(item.id||"")) throw new Error("invalid comfy instance id");
        const u=new URL(item.url);
        if (u.protocol!=="http:" || !["127.0.0.1","[::1]"].includes(u.hostname) ||
            !u.port || u.pathname!=="/" || u.username || u.password || u.search || u.hash)
            throw new Error("ComfyUI instance URLs must be exact loopback HTTP origins with explicit port");
        if(instances.has(item.id))throw new Error("duplicate comfy instance ID");
        instances.set(item.id,{id:item.id,url:u.origin});
    }
    return instances;
}

function validInstance(raw) {
    if(!raw || typeof raw.id!=="string" || !/^[\w:-]{1,64}$/.test(raw.id) || typeof raw.url!=="string")throw statusError("invalid_comfy_instance",400);
    let url;
    try { url=new URL(raw.url); }catch {throw statusError("invalid_comfy_instance_url",400);}
    if(url.protocol!=="http:" || !["127.0.0.1","[::1]"].includes(url.hostname) ||
        !url.port || url.pathname!=="/" || url.username || url.password || url.search || url.hash)
        throw statusError("comfy_instance_must_be_exact_loopback_origin",400);
    return {id:raw.id,url:url.origin};
}
async function upstream(instance,path,{method="GET",body,timeoutMs=45000,expectBinary=false,receive}={}) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
        const result=await fetch(instance.url+path,{
            method,body,redirect:"manual",signal:controller.signal,
            headers:body && typeof body==="string"?{"content-type":"application/json"}:undefined
        });
        if (result.status>=300 && result.status<400) throw statusError("comfy_redirect_rejected",502);
        if (!result.ok) {
            if(path==="/prompt" && method==="POST" && [400,422].includes(result.status)) {
                // A received validation rejection is definitive: ComfyUI did NOT queue the graph.
                // Bound untrusted ComfyUI error text; preserve the diagnostic for the user.
                let detail="invalid_prompt";
                try {
                    const chunks=[];let length=0;
                    if(result.body)for await(const chunk of result.body) {
                        length+=chunk.length;
                        if(length>32_768)break;
                        chunks.push(Buffer.from(chunk));
                    }
                    const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    const message=typeof payload?.error?.message==="string"?payload.error.message:
                        typeof payload?.error?.type==="string"?payload.error.type:
                        typeof payload?.error==="string"?payload.error:"invalid_prompt";
                    const problems=Object.entries(payload?.node_errors??{}).flatMap(([node,entry])=>
                        Array.isArray(entry?.errors)?entry.errors.slice(0,2).map(err=>node+":"+(err?.details||err?.message||"invalid")):[]);
                    detail=[message,...problems].join(" | ").replace(/[\r\n]+/g," ").slice(0,1000);
                }catch {}
                throw Object.assign(statusError("comfy_prompt_rejected:"+detail,422),{promptRejected:true});
            }
            throw statusError("comfy_upstream_"+result.status,502);
        }
        if(expectBinary && receive) {
            if(!result.body)throw statusError("comfy_empty_response",502);
            const mime=(result.headers.get("content-type")||"").split(";")[0];
            return {saved:await receive(result.body,mime),mime};
        }
        const max=expectBinary?40_000_000:8_000_000;
        const chunks=[];let size=0;
        if (result.body) for await(const chunk of result.body) {
            size+=chunk.byteLength;
            if(size>max) {controller.abort();throw statusError("comfy_response_too_large",502);}
            chunks.push(Buffer.from(chunk));
        }
        const bytes=Buffer.concat(chunks,size);
        return expectBinary?{bytes,mime:(result.headers.get("content-type")||"").split(";")[0]}:JSON.parse(bytes.toString("utf8"));
    } finally {clearTimeout(timer);}
}
async function requestBytes(req,limit) {
    const chunks=[];let len=0;
    for await(const chunk of req) {
        len+=chunk.length;if(len>limit) throw statusError("payload_too_large",413);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks,len);
}
function send(res,code,obj) {
    res.writeHead(code,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});
    res.end(JSON.stringify(obj));
}
function publicRun(run,store) {
    return {runId:run.id,status:run.status,promptId:run.prompt_id,instanceId:run.request.instanceId,
        workflowNodeId:run.request.nodes[0].id,rootOutputs:run.request.rootOutputs,
        captureMap:run.captureMap,graphHash:run.graph_hash,
        cancelRequested:run.cancelRequested,error:run.error,
        createdAt:run.created_at,updatedAt:run.updated_at,
        artifacts:store.artifacts(run.id).map(a=>({
            artifactId:a.id,runId:run.id,workflowNodeId:a.workflow_node_id,portId:a.port_id,
            kind:a.kind,index:a.item_index,filename:a.id,
            metadata:JSON.parse(a.metadata_json),mimeType:a.mime,sha256:a.sha256,byteSize:a.size,
            url:`/api/comfy/runs/${run.id}/artifacts/${a.id}`
        }))};
}
export function createComfyService({
    env=process.env,root=env.COMFY_DATA_DIR || fileURLToPath(new URL("../../.comfy-workflow-data/",import.meta.url)),
    fetchInfo, upstreamCall=upstream, tickMs=2500, resume=true, principal="local-owner"
}={}) {
    const store=createComfyStore(root,{maxRunBytes:Number(env.COMFY_MAX_RUN_BYTES??4_000_000_000)});
    const instances=store.loadInstances(configureInstances(env));
    // Trust all installed ComfyUI classes, including custom nodes. Validate against live /object_info.
    const activeStates=["queued","preparing","submitting","submission_unknown","running","collecting"];
    if(resume)store.resumeAfterRestart();
    let closed=false,busy=false;
    const infoFor=async(instance)=>fetchInfo?fetchInfo(instance):upstreamCall(instance,"/object_info");
    const instanceFor=(id)=>instances.get(id) || (()=>{throw statusError("comfy_instance_not_allowed",403);})();
    const readState=(id)=>{const run=store.read(id);if(!run||run.principal!==principal)throw statusError("run_not_found",404);return run;};
    async function putImage(run,item,instance) {
        const asset=store.asset(item.assetId);
        if (!asset || asset.sha256!==item.sha256 || asset.mime!== "image/png" && asset.mime!=="image/jpeg" && asset.mime!=="image/webp") throw statusError("asset_reference_invalid");
        const bytes=readFileSync(asset.path);
        if (sha256(bytes)!==asset.sha256) throw statusError("staged_asset_corrupted");
        const filename="atelier_"+item.assetId.replaceAll("-","")+"."+({ "image/png":"png","image/jpeg":"jpg","image/webp":"webp" }[asset.mime]);
        const form=new FormData();
        form.set("image",new Blob([bytes],{type:asset.mime}),filename);
        form.set("type","input");form.set("overwrite","true");
        const response=await upstreamCall(instance,"/upload/image",{method:"POST",body:form,timeoutMs:120000});
        if (response?.name!==filename || response?.type && response.type!=="input" || response?.subfolder) throw statusError("comfy_upload_filename_mismatch",502);
        return filename;
    }
    async function prepareSubmit(run) {
        if (!store.cas(run.id,"queued","preparing")) return;
        try {
            const req=run.request;
            const template=store.getTemplate(req.nodes[0].templateId,req.nodes[0].templateRevision);
            if(!template)throw statusError("template_revision_unavailable");
            const instance=instanceFor(req.instanceId), info=await infoFor(instance);
            const imageFiles={};
            for (const input of req.externalInputs.filter(x=>x.kind==="asset")) imageFiles[input.assetId]=await putImage(run,input,instance);
            const compiled=compileSingleWorkflow(req,template,{info,imageFiles});
            const attemptId=randomUUID(),marker=randomUUID();
            // Transactional barrier: graph, capture map and submission marker land BEFORE /prompt.
            if (!store.cas(run.id,"preparing","submitting",{
                compiled:canonical(compiled.graph),capture_map:canonical(compiled.captureMap),
                graph_hash:compiled.graphHash,image_files:canonical(imageFiles),
                attempt_id:attemptId,submit_marker:marker,submission_started_at:Date.now()
            }))return;
            try {
                const submitted=await upstreamCall(instance,"/prompt",{method:"POST",body:JSON.stringify({
                    prompt:compiled.graph,client_id:attemptId,extra_data:{infinite_atelier_submit_marker:marker}
                }),timeoutMs:45000});
                if(submitted?.error && !submitted?.prompt_id) {
                    const text=typeof submitted.error==="string"?submitted.error:
                        submitted.error?.message||submitted.error?.type||"invalid_prompt";
                    throw Object.assign(statusError("comfy_prompt_rejected:"+String(text).slice(0,500)),{promptRejected:true});
                }
                if (typeof submitted?.prompt_id!=="string" || !/^[\w-]{1,128}$/.test(submitted.prompt_id))
                    throw statusError("comfy_prompt_id_missing",502);
                store.cas(run.id,"submitting","running",{prompt_id:submitted.prompt_id});
            }catch(error) {
                // Only a received 400/422 or explicit Comfy validation payload proves non-submission.
                // A timeout, 5xx, dropped response or malformed success MUST remain uncertain.
                const rejected=error?.promptRejected===true ||
                    ["comfy_upstream_400","comfy_upstream_422"].includes(error?.code);
                store.cas(run.id,"submitting",rejected?"failed":"submission_unknown",{error:String(error)});
            }
        } catch(e) {
            store.cas(run.id,"preparing","failed",{error:String(e)});
        }
    }
    async function collect(run) {
        if(run.next_collect_at && run.next_collect_at>Date.now())return;
        const instance=instanceFor(run.request.instanceId);
        try {
            const history=await upstreamCall(instance,"/history/"+encodeURIComponent(run.prompt_id));
            const entry=history?.[run.prompt_id];
            if (!entry) return; // queued or currently running; recover by polling
            if (entry.status?.status_str==="error" || entry.status?.status_str==="execution_error" ||
                entry.status?.completed===false && entry.status?.status_str==="error") {
                store.cas(run.id,["running","collecting"],"failed",{error:"comfy_execution_failed"});
                return;
            }
            if (entry.status?.completed!==true && entry.status?.status_str!=="success") return;
            if (run.status==="running") store.cas(run.id,"running","collecting");
            const latest=store.read(run.id);
            for(const cap of latest.captureMap) {
                const candidates=extractCapture(entry.outputs?.[cap.captureNodeId],cap);
                if(!candidates.length && cap.required)throw statusError("capture_missing:"+cap.portId);
                for(const [index,item] of candidates.entries()) {
                    // Identity includes the selected output port even when multiple ports reuse one Save node.
                    if(store.artifacts(run.id).some(x=>x.port_id===cap.portId && x.item_key===item.key))continue;
                    if(item.type==="inline") {
                        await store.addArtifact(latest,cap,item.key,index,Buffer.from(item.text,"utf8"),"text/plain");
                    } else {
                        const params=new URLSearchParams({filename:item.filename,subfolder:item.subfolder,type:item.fileType});
                        const result=await upstreamCall(instance,"/view?"+params.toString(),{
                            expectBinary:true,timeoutMs:120000,
                            receive:(stream,mime)=>store.addArtifact(latest,cap,item.key,index,stream,mime,{filename:item.filename})
                        });
                        if(!result?.saved) {
                            if(!result || !(result.bytes || result.stream))throw statusError("capture_download_invalid",502);
                            await store.addArtifact(latest,cap,item.key,index,result.stream??result.bytes,result.mime,{filename:item.filename});
                        }
                    }
                }
            }
            store.cas(run.id,"collecting","succeeded",{error:null,capture_attempts:0,next_collect_at:0});
        }catch(e) {
            const code=e?.code || e?.message || "capture_failed";
            const terminal=/(capture_adapter_unsupported|capture_history_shape_invalid|invalid_media|captured_mime_mismatch|captured_extension_mismatch|unsafe_output_filename|invalid_text_content|capture_empty|quota_exceeded)/.test(code);
            const attempts=(store.read(run.id)?.capture_attempts??0)+1;
            if(terminal || attempts>=8) {
                store.cas(run.id,["running","collecting"],"failed",{
                    error:terminal?String(e):"capture_retry_exhausted:"+String(e),capture_attempts:attempts
                });
            }else {
                // Retry collection only; never submit another GPU graph. A failed first retry is immediate.
                store.cas(run.id,["running","collecting"],"collecting",{
                    error:String(e),capture_attempts:attempts,
                    next_collect_at:Date.now()+(attempts===1?0:Math.min(60_000,1000*(2**(attempts-2))))
                });
            }
        }
    }
    async function tick() {
        if(busy||closed)return;
        busy=true;
        try {
            for(const run of store.listStatuses(["running","collecting"])) await collect(run);
            // Only one GPU run at a time; uncertain network submissions also protect the pool.
            if (store.listStatuses(["submission_unknown","running","collecting","submitting"]).length) return;
            const next=store.listStatuses(["queued"])[0];
            if(next)await prepareSubmit(next);
        } finally {busy=false;}
    }
    const interval=tickMs>0?setInterval(()=>{void tick().catch(e=>console.error("Comfy worker:",e));},tickMs):null;
    interval?.unref();
    async function handle(req,res,url) {
        try {
            const path=url.pathname, method=req.method;
            if(method==="GET" && path==="/api/comfy/instances") {
                const results=[];
                for(const instance of instances.values()) {
                    try {const info=await infoFor(instance);results.push({...instance,reachable:true,classTypes:Object.keys(info)});}
                    catch{results.push({...instance,reachable:false,classTypes:[]});}
                }
                // Browser must detect a gateway process left running from before instance CRUD existed.
                return send(res,200,{apiVersion:2,instanceManagement:true,instances:results});
            }
            // Instance editing is permitted only for the authenticated loopback gateway.
            // Refuse any mutation while a queued / uncertain / executing GPU run might resolve this ID.
            if(["POST","PUT","DELETE"].includes(method) &&
                (path==="/api/comfy/instances" || path.startsWith("/api/comfy/instances/"))) {
                if(store.listStatuses(activeStates).length)
                    throw statusError("comfy_instances_locked_during_pending_runs",409);
                const oldId=path.startsWith("/api/comfy/instances/")?decodeURIComponent(path.slice("/api/comfy/instances/".length)):"";
                if(method==="DELETE") {
                    if(!oldId || !instances.has(oldId))throw statusError("instance_not_found",404);
                    store.deleteInstance(oldId);instances.delete(oldId);
                    return send(res,200,{deleted:oldId});
                }
                if(method==="PUT" && !oldId || method==="POST" && oldId)throw statusError("invalid_instance_route",400);
                const raw=JSON.parse((await requestBytes(req,1024)).toString("utf8"));
                const instance=validInstance(raw);
                store.changeInstance(instance,oldId||undefined);
                if(oldId)instances.delete(oldId);
                instances.set(instance.id,instance);
                return send(res,200,{instance});
            }
            if(method==="POST" && path==="/api/comfy/templates") {
                const input=JSON.parse((await requestBytes(req,2_100_000)).toString("utf8"));
                const template=verifyTemplate(input.template);
                const instance=instanceFor(input.instanceId);
                const info=await infoFor(instance);
                validateGraph(template.apiGraph,info);
                for(const port of template.ports.filter(x=>x.direction==="source")) {
                    const s=template.apiGraph[port.outputBinding.nodeId];
                    if(info[s.class_type]?.output?.[port.outputBinding.outputIndex]!==port.valueKind) throw statusError("template_output_capability_mismatch");
                }
                return send(res,200,{result:store.addTemplate(template),templateId:template.id,revision:template.revision,instanceId:instance.id});
            }
            if(method==="GET" && path==="/api/comfy/templates") {
                return send(res,200,{templates:store.db.prepare("SELECT id,revision FROM templates").all()});
            }
            if(method==="POST" && path==="/api/comfy/inputs") {
                const mime=String(req.headers["content-type"]??"").split(";")[0];
                if (!["image/png","image/jpeg","image/webp"].includes(mime)) throw statusError("only_image_upload_supported",415);
                const buf=await requestBytes(req,20_000_000);
                if (!isImage(buf,mime))throw statusError("image_signature_mismatch",415);
                return send(res,201,store.addAsset(buf,mime));
            }
            if(method==="POST" && (path==="/api/comfy/graphs/validate"||path==="/api/comfy/runs")) {
                const input=JSON.parse((await requestBytes(req,1_100_000)).toString("utf8"));
                validateSingleRequest(input);
                const fingerprint=fingerprintRequest(input);
                if (path==="/api/comfy/runs") {
                    // Idempotent replay must work offline and even after staged asset leases expire.
                    const existing=store.findByKey(principal,input.projectId,input.idempotencyKey);
                    if (existing) {
                        if (existing.fingerprint!==fingerprint)throw statusError("idempotency_key_conflict",409);
                        return send(res,200,publicRun(existing,store));
                    }
                }
                const instance=instanceFor(input.instanceId);
                const template=store.getTemplate(input.nodes[0].templateId,input.nodes[0].templateRevision);
                if(!template)throw statusError("template_revision_unavailable",404);
                verifyTemplate(template);
                for(const item of input.externalInputs.filter(x=>x.kind==="asset")) {
                    const a=store.asset(item.assetId);
                    if(!a || a.sha256!==item.sha256 || Date.now()-a.created_at > 7*86400_000)
                        throw statusError("asset_reference_unavailable");
                }
                // Fail fast on immutable graph errors before acknowledging the durable queued job.
                const info=await infoFor(instance);
                const files=Object.fromEntries(input.externalInputs.filter(x=>x.kind==="asset").map(x=>[x.assetId,"dryrun.png"]));
                const compiled=compileSingleWorkflow(input,template,{info,imageFiles:files});
                if(path==="/api/comfy/graphs/validate") {
                    return send(res,200,{valid:true,graphHash:compiled.graphHash,captureMap:compiled.captureMap,
                        note:"Validated against live ComfyUI capabilities; dryrun.png is a placeholder, not an uploaded file."});
                }
                const {run,existing}=store.addRun(principal,input,fingerprint);
                if(!existing)void tick().catch(e=>console.error("Comfy worker:",e));
                return send(res,existing?200:201,publicRun(run,store));
            }
            const match=path.match(/^\/api\/comfy\/runs\/([\w-]{1,128})(?:\/(cancel|artifacts\/([\w-]{1,128})))?$/);
            if(match) {
                const run=readState(match[1]);
                if (method==="GET" && !match[2]) return send(res,200,publicRun(run,store));
                if(method==="POST" && match[2]==="cancel") {
                    if(["queued","preparing"].includes(run.status)) store.cas(run.id,["queued","preparing"],"cancelled");
                    else if(["submitting","running","collecting","submission_unknown"].includes(run.status))
                        store.cas(run.id,run.status,run.status,{cancel_requested:1});
                    return send(res,200,publicRun(readState(run.id),store));
                }
                if(method==="GET" && match[3]) {
                    const a=store.artifact(run.id,match[3]);
                    if(!a)throw statusError("artifact_not_found",404);
                    const fileStat=await stat(a.path);
                    if(fileStat.size!==a.size)throw statusError("artifact_size_mismatch",500);
                    const size=fileStat.size,range=req.headers.range;
                    const headers={"content-type":a.mime,"cache-control":"private, no-store",
                        "x-content-type-options":"nosniff","accept-ranges":"bytes",
                        "content-disposition":'inline; filename="'+a.id+'"'} ;
                    if(size===0) {
                        if(range)res.writeHead(416,{...headers,"content-range":"bytes */0"});
                        else res.writeHead(200,{...headers,"content-length":0});
                        res.end();return;
                    }
                    let start=0,end=size-1,code=200;
                    if(range) {
                        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
                        if(!match || (!match[1] && !match[2])) {
                            res.writeHead(416,{...headers,"content-range":"bytes */"+size});res.end();return;
                        }
                        if(!match[1]) {
                            const suffix=Number(match[2]);start=suffix>0?Math.max(0,size-suffix):size;
                        } else {
                            start=Number(match[1]);if(match[2])end=Number(match[2]);
                        }
                        if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
                           start>=size || start<0 || end<start) {
                            res.writeHead(416,{...headers,"content-range":"bytes */"+size});res.end();return;
                        }
                        end=Math.min(end,size-1);code=206;
                        headers["content-range"]="bytes "+start+"-"+end+"/"+size;
                    }
                    headers["content-length"]=end-start+1;
                    res.writeHead(code,headers);
                    const stream=createReadStream(a.path,{start,end});
                    stream.on("error",()=>res.destroy());
                    stream.pipe(res);
                    return;
                }
            }
            return send(res,404,{error:"comfy_route_not_found"});
        }catch(e) {return send(res,e?.status||422,{error:e?.code || e?.message || "comfy_request_failed"});}
    }
    const close=()=>{closed=true;if(interval)clearInterval(interval);store.close();};
    return {handle,tick,close,store,instances};
}
