import {canvasApi,type CanvasBackendProject} from "@/features/backend-sync/canvas-api";
import {commitAssistantCanvasGraphWithSaveBarrier,ensureCreativeNodesLoaded} from "@/stores/canvas/use-canvas-sqlite-store";
import type {DramaAsset} from "./canvas-drama-pipeline";

export type AssetEntryPatch={name?:string;description?:string};
function canonical(value:unknown):string{
 return JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
}
export function sameAssetEntry(a:DramaAsset,b:DramaAsset){return canonical(a)===canonical(b);}

/** Read a digest inside the save barrier, but only accept it if it matches
 * the complete entry the editor originally displayed. Never rebase a stale
 * edit onto a newly fetched digest. The server still checks that digest. */
export async function saveAssetEntry(projectId:string,nodeId:string,baseline:DramaAsset,changes:AssetEntryPatch,variantId?:string){
 const base=`/api/v1/projects/${encodeURIComponent(projectId)}/drama-pipeline`;
 const operationId=crypto.randomUUID();
 await commitAssistantCanvasGraphWithSaveBarrier(projectId,async({assertCurrent})=>{
  const scope=await canvasApi<{entries:DramaAsset[];entryDigests:{id:string;digest:string}[]}>(
   `${base}/revision-scope?nodeId=${encodeURIComponent(nodeId)}&draft=true&entryId=${encodeURIComponent(baseline.id)}&limit=1`,"GET");
  const remote=scope.entries.find(a=>a.id===baseline.id);
  const digest=scope.entryDigests.find(e=>e.id===baseline.id)?.digest;
  if(!remote||!digest||!sameAssetEntry(remote,baseline))throw Error("drama_candidate_conflict：资产内容已更新，请重新加载");
  assertCurrent();
  return canvasApi<CanvasBackendProject>(`${base}/entry-draft`,"PATCH",{
   nodeId,kind:"assets",entryId:baseline.id,expectedDigest:digest,operationId,changes,...(variantId?{variantId}:{})
  });
 },{keepCreativePointers:true,invalidateCreativeNodeId:nodeId});
 await ensureCreativeNodesLoaded(projectId,[nodeId]);
}
