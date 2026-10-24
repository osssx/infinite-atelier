import type { CanvasNodeData, CanvasConnection } from "@/types/canvas";
import { prepareCanvasExternalInputSnapshot } from "@/lib/canvas/canvas-external-input-snapshot";
import { getImageBlob } from "@/services/image-storage";
import type { ComfyWorkflowTemplate } from "./template-schema";

export type ComfyRunArtifact = {
    artifactId:string;runId:string;workflowNodeId:string;portId:string;
    kind:"image"|"video"|"audio"|"text";index:number;filename?:string;
    metadata?:{width?:number;height?:number;durationMs?:number;fps?:number;sampleRate?:number;channels?:number};
    mimeType:string;sha256:string;byteSize:number;url:string;
};
export type ComfyRunState = {
    runId:string;status:string;promptId?:string|null;error?:string|null;
    workflowNodeId:string;artifacts:ComfyRunArtifact[];
};
/** Only an explicit 4xx API rejection proves that no GPU run was accepted. */
export function isComfySubmissionRejected(error:unknown):boolean {
    return error instanceof Error && "httpStatus" in error &&
        [400,404,413,415,422].includes((error as Error & {httpStatus:number}).httpStatus);
}
/** File/media inputs never fall back to a filename embedded in the imported API graph. */
export function missingComfyMediaInputs(template:ComfyWorkflowTemplate,workflowNodeId:string,
    connections:readonly CanvasConnection[]) {
    return template.ports.filter(port=>port.direction==="target" && port.inputBinding?.mode==="media-file" &&
        !connections.some(edge=>edge.toNodeId===workflowNodeId && edge.toPortId===port.id));
}
async function comfyRequest<T>(path:string,init?:RequestInit):Promise<T> {
    let response:Response;
    try {
        response=await fetch("/api/comfy"+path,{...init,cache:"no-store"});
    } catch {
        throw new Error("无法连接 ComfyUI 网关，请确认 ark-gateway（默认 127.0.0.1:8787）已启动且前端开发代理可访问。");
    }
    const contentType=response.headers.get("content-type")??"";
    if(!contentType.toLowerCase().includes("application/json")) {
        if([500,502,503,504].includes(response.status))
            throw new Error("ComfyUI 网关不可用（HTTP "+response.status+"）。请先启动 ark-gateway（默认 127.0.0.1:8787），并检查 Vite 代理的 GATEWAY_TOKEN 配置。");
        throw new Error("ComfyUI API 返回非 JSON 响应（HTTP "+response.status+"，"+(contentType||"无 Content-Type")+"）。请确认请求到达 /api/comfy 网关，而非前端页面或其它服务。");
    }
    const data:unknown=await response.json().catch(()=>null);
    if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("ComfyUI API 返回无效 JSON（HTTP "+response.status+"）");
    if(!response.ok) {
        const reason="error" in data && typeof data.error==="string"?data.error:"Comfy HTTP "+response.status;
        if(reason.startsWith("comfy_missing_class:"))
            throw new Error("ComfyUI 尚未安装工作流依赖节点："+reason.slice("comfy_missing_class:".length)+"。请在 ComfyUI 中安装相应节点后重试。");
        if(response.status===401||response.status===403)throw new Error("ComfyUI 网关鉴权失败（HTTP "+response.status+"），请确保网关与 Vite 配置相同 GATEWAY_TOKEN。"+reason);
        const missing=reason.match(/^(?:media_input_requires_connection|untrusted_template_file):(.+)$/);
        const model=reason.match(/^comfy_model_(missing|ambiguous):([^:]+):(.+)$/);
        const description=model
            ? model[1]==="missing"
                ? "ComfyUI 当前实例没有找到 LoRA 模型："+model[3]+"。请检查模型目录及 ComfyUI 的模型列表，或在工作流模板中选择已安装的 LoRA。"
                : "ComfyUI 中有多个同名 LoRA："+model[3]+"。请在工作流模板中明确选择包含目录的完整模型路径。"
            : missing
                ? "缺少工作流媒体输入 "+missing[1]+"：请将图片/媒体节点连接到该输入端口。不能直接使用模板中的示例文件名。"
                : reason;
        throw Object.assign(new Error(description),{httpStatus:response.status});
    }
    return data as T;
}

const pendingKey=(projectId:string,nodeId:string)=>"comfy_pending_v2:"+projectId+":"+nodeId;
export function hasPendingComfyRun(projectId:string,nodeId:string) {
    return Boolean(localStorage.getItem(pendingKey(projectId,nodeId)));
}
/** Resubmits the identical, previously frozen request and idempotency key, never a new key. */
export async function recoverPendingComfyRun(projectId:string,nodeId:string):Promise<ComfyRunState> {
    const key=pendingKey(projectId,nodeId);
    const payload=localStorage.getItem(key);
    if(!payload)throw new Error("没有需要恢复的提交快照");
    try {
        const result=await comfyRequest<ComfyRunState>("/runs",{
            method:"POST",headers:{"content-type":"application/json"},body:payload
        });
        localStorage.removeItem(key);
        return result;
    }catch(error) {
        // A definitive validation rejection cannot be recovered. Do not strand the user in
        // submission_unknown. Network failures, timeouts and 5xx MUST retain this snapshot.
        if(isComfySubmissionRejected(error))localStorage.removeItem(key);
        throw error;
    }
}
export type ComfyInstance = {id:string;url:string;reachable:boolean;classTypes:string[]};
export const COMFY_GATEWAY_UPGRADE_MESSAGE =
    "当前运行的 ComfyUI 网关版本过旧，不支持实例编辑。请在终端停止旧的 npm run dev:comfy（或 ark-gateway），然后在 web 目录重新运行 npm run dev:comfy；仅刷新网页无法更新后台进程。";
export async function listComfyInstances():Promise<ComfyInstance[]> {
    const value=await comfyRequest<{apiVersion?:number;instanceManagement?:boolean;instances:ComfyInstance[]}>("/instances");
    if(value.instanceManagement!==true || !Array.isArray(value.instances) ||
        value.instances.some(item=>typeof item.id!=="string" || typeof item.url!=="string")) {
        throw new Error(COMFY_GATEWAY_UPGRADE_MESSAGE);
    }
    return value.instances;
}
export async function saveComfyInstance(id:string,url:string,oldId?:string) {
    try {
        return await comfyRequest<{instance:{id:string;url:string}}>(oldId?"/instances/"+encodeURIComponent(oldId):"/instances",{
            method:oldId?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,url})
        });
    } catch(error) {
        if(error instanceof Error && /comfy_route_not_found/.test(error.message))
            throw new Error(COMFY_GATEWAY_UPGRADE_MESSAGE);
        throw error;
    }
}
export async function deleteComfyInstance(id:string) {
    try {
        return await comfyRequest<{deleted:string}>("/instances/"+encodeURIComponent(id),{method:"DELETE"});
    } catch(error) {
        if(error instanceof Error && /comfy_route_not_found/.test(error.message))
            throw new Error(COMFY_GATEWAY_UPGRADE_MESSAGE);
        throw error;
    }
}
export async function registerComfyTemplate(template:ComfyWorkflowTemplate,instanceId:string) {
    return comfyRequest<{result:string;instanceId:string}>("/templates",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({template,instanceId})
    });
}
export async function getComfyRun(runId:string) {
    return comfyRequest<ComfyRunState>("/runs/"+encodeURIComponent(runId));
}
export async function cancelComfyRun(runId:string) {
    return comfyRequest<ComfyRunState>("/runs/"+encodeURIComponent(runId)+"/cancel",{method:"POST"});
}
export async function startComfyWorkflowRun(args:{
    projectId:string;workflowNode:CanvasNodeData;nodes:readonly CanvasNodeData[];
    connections:readonly CanvasConnection[];template:ComfyWorkflowTemplate;instanceId:string;
    outputPortIds:readonly string[];
}):Promise<ComfyRunState> {
    const {projectId,workflowNode,template,instanceId,outputPortIds}=args;
    if(outputPortIds.length<1 || outputPortIds.length>16 || new Set(outputPortIds).size!==outputPortIds.length ||
        outputPortIds.some(id=>!template.ports.some(port=>port.id===id && port.direction==="source" && port.capture?.kind!=="none" && !!port.capture?.adapterId)))
        throw new Error("必须选择至少一个有效的产物输出端口，最多 16 个");
    const binding=workflowNode.metadata?.comfyWorkflow;
    if(!binding || binding.templateId!==template.id || binding.templateRevision!==template.revision)throw new Error("工作流模板版本不匹配");
    if(hasPendingComfyRun(projectId,workflowNode.id))throw new Error("存在未确认的提交，请先使用“恢复待确认提交”以相同 key 查询/恢复，避免重复 GPU 执行");
    const missingMedia=missingComfyMediaInputs(template,workflowNode.id,args.connections);
    if(missingMedia.length)throw new Error("请先连接媒体输入："+missingMedia.map(port=>port.label+" ("+port.id+")").join("、")+"。请从画布图片节点的输出端口连到工作流输入端口，模板中的示例文件不能直接使用。");
    const incoming=args.connections.filter(edge=>edge.toNodeId===workflowNode.id);
    if (incoming.some(edge=>!edge.fromPortId||!edge.toPortId))throw new Error("工作流只能使用显式端口连线");
    const externalNodes=args.nodes.filter(n=>n.id!==workflowNode.id);
    if(incoming.some(edge=>!externalNodes.some(n=>n.id===edge.fromNodeId && ["text","image"].includes(n.type))))
        throw new Error("首版仅支持 Text / Image 外部输入，不能连接另一个工作流");
    // Freeze the entire canvas-derived view before the first async upload.
    const prepared=prepareCanvasExternalInputSnapshot(args.nodes,incoming);
    const frozen={
        schemaVersion:2,projectId,canvasRevision:String(Date.now()),instanceId,
        rootOutputs:outputPortIds.map(portId=>({nodeId:workflowNode.id,portId})),
        nodes:[{id:workflowNode.id,templateId:template.id,templateRevision:template.revision,
            inputOverrides:structuredClone(binding.inputOverrides??{})}],
        edges:incoming.map(edge=>({
            fromNodeId:edge.fromNodeId,fromPortId:edge.fromPortId!,toNodeId:edge.toNodeId,toPortId:edge.toPortId!
        })),
        runOptions:{},idempotencyKey:crypto.randomUUID()
    };
    await registerComfyTemplate(template,instanceId);
    const externalInputs=[];
    for(const value of prepared) {
        if(value.kind==="scalar"){
            externalInputs.push({...value});
            continue;
        }
        if(value.valueKind!=="IMAGE")throw new Error("首版不支持视频或音频输入");
        let blob:Blob|null=null;
        if(value.storageKey)blob=await getImageBlob(value.storageKey);
        if(!blob && value.url && (value.url.startsWith("blob:")||value.url.startsWith("data:"))) {
            const result=await fetch(value.url);
            if(result.ok)blob=await result.blob();
        }
        if(!blob)throw new Error("图片源未找到本地可上传的 Blob，请重新导入图片");
        const mime=blob.type||value.mimeType||"";
        if(!["image/png","image/jpeg","image/webp"].includes(mime))throw new Error("ComfyUI 仅接受 PNG/JPEG/WebP 图片");
        const staged=await comfyRequest<{assetId:string;sha256:string}>("/inputs",{
            method:"POST",headers:{"content-type":mime},body:blob
        });
        externalInputs.push({kind:"asset",sourceNodeId:value.sourceNodeId,sourcePortId:value.sourcePortId,
            valueKind:"IMAGE",assetId:staged.assetId,sha256:staged.sha256});
    }
    // Persist exactly what the backend receives before the first /runs POST.
    // A lost response can be retried without regenerating seed, uploads or idempotencyKey.
    localStorage.setItem(pendingKey(projectId,workflowNode.id),JSON.stringify({...frozen,externalInputs}));
    return recoverPendingComfyRun(projectId,workflowNode.id);
}
