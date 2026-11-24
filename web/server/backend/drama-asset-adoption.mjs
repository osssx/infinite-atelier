import {randomUUID} from "node:crypto";
import {readAssetDraft,readStoryboardDraft,validStoryboardDraftReferences} from "../canvas-text-content.mjs";
import {validateDramaPipelineSnapshot} from "./drama-pipeline.mjs";
import {stableJson,writeTransaction} from "./repository.mjs";

const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});
const uuid=prefix=>prefix+"_"+randomUUID();
const norm=value=>String(value??"").trim().toLocaleLowerCase();
const union=(a,b)=>[...new Set([...a,...b])];
/** Process reviewed choices as one transaction. Confirmed assets and historical
 * Config/shot revisions are immutable: only current asset + linked board drafts
 * are rewritten. Unknown/missing/ambiguous variant matches fail closed.
 */
export function adoptDramaAssetCandidates({db,getProject,validateDocument,emitEvent},
 projectId,{nodeId,candidateId,decisions}){
 return writeTransaction(db,()=>{
  const project=getProject(db,projectId),document=project.document;
  const node=document.nodes.find(item=>item.id===nodeId&&item.type==="drama:assets");
  if(!node)throw fail("drama_asset_not_found",404);
  const candidate=node.metadata?.dramaAssetCandidate;
  // Match the editor's draft preference, including the legacy content-only
  // asset nodes. A genuinely changed draft still invalidates the candidate.
  const currentBaseline=node.metadata?.dramaDraft||node.metadata?.dramaConfirmed||node.metadata?.content||"";
  if(!candidate||candidate.id!==candidateId||candidate.baseline!==currentBaseline)
   throw fail("drama_asset_candidate_conflict",409);
  // A newly created asset node has no prior draft; its first reviewed
  // generation must be able to establish an empty asset collection.
  // Only the exact empty baseline is accepted; malformed nonempty drafts fail closed.
  const current=candidate.baseline===""?{assets:[]}:readAssetDraft(candidate.baseline);
  const suggested=readAssetDraft(stableJson({assets:candidate.assets}));
  if(!current||!suggested||!decisions||typeof decisions!=="object"||Array.isArray(decisions))
   throw fail("drama_asset_candidate_invalid",422);
  const known=new Set(suggested.assets.map(asset=>asset.id));
  if(Object.keys(decisions).some(key=>!known.has(key)))
   throw fail("drama_asset_candidate_invalid",422);
  const assets=structuredClone(current.assets);
  const ids=new Set(assets.flatMap(asset=>[asset.id,...(asset.variants??[]).map(item=>item.id)]));
  const reserve=prefix=>{let next=uuid(prefix);while(ids.has(next))next=uuid(prefix);ids.add(next);return next;};
  const assetIds={},variantIds={},aliases=[];
  for(const original of suggested.assets){
   const decision=decisions[original.id]??{action:"skip"};
   if(!["skip","new","reuse","variant"].includes(decision.action))throw fail("drama_asset_candidate_invalid",422);
   if(decision.action==="skip")continue;
   if(decision.action==="new"){
    const id=reserve("asset"),variants=(original.variants??[]).map(variant=>{
     const next=reserve("variant");variantIds[variant.id]=next;
     return {...variant,id:next};
    });
    assets.push({...original,id,variants});
    assetIds[original.id]=id;
   }else{
    const target=assets.find(item=>item.id===decision.targetId&&item.kind===original.kind);
    if(!target)throw fail("drama_asset_candidate_target_invalid",422);
    assetIds[original.id]=target.id;
    target.sourceRefs=union(target.sourceRefs,original.sourceRefs);
    if(decision.action==="variant"){
     if(target.kind==="prop")throw fail("drama_asset_candidate_target_invalid",422);
     const pending=(original.variants?.length?original.variants:[{
      id:original.id,name:original.name,description:original.description,
     }]);
     target.variants??=[];
     for(const variant of pending){
      const next=reserve("variant");
      target.variants.push({...variant,id:next});
      variantIds[variant.id]=next;
     }
    }else{
     for(const variant of original.variants??[]){
      const matches=(target.variants??[]).filter(item=>norm(item.name)===norm(variant.name));
      if(matches.length===1)variantIds[variant.id]=matches[0].id;
      else if(matches.length===0){
       // A candidate may propose a new outfit even when the user chose "reuse".
       // Its use in an existing shot must be handled explicitly through "variant".
       aliases.push(variant.id);
      }else throw fail("drama_asset_candidate_variant_ambiguous",409);
     }
    }
   }
  }
  const assetMapping=new Map(Object.entries(assetIds)),variantMapping=new Map(Object.entries(variantIds));
  const priorAssetIds=new Set(current.assets.map(item=>item.id));
  const priorVariantIds=new Set(current.assets.flatMap(item=>(item.variants??[]).map(variant=>variant.id)));
  for(const [from,to] of assetMapping)if(priorAssetIds.has(from)&&from!==to)throw fail("drama_asset_candidate_identity_conflict");
  for(const [from,to] of variantMapping)if(priorVariantIds.has(from)&&from!==to)throw fail("drama_asset_candidate_identity_conflict");
  const mapped=(id,map)=>map.get(id)??id;
  const boards=document.connections.filter(edge=>edge.fromNodeId===nodeId).flatMap(edge=>
   document.nodes.filter(item=>item.id===edge.toNodeId&&item.type==="drama:storyboard"));
  const targetBodies=[];
  for(const board of boards){
   // A storyboard may be connected before any shots exist. It has no draft
   // references to remap and must not block adopting the first assets.
   // Keep malformed nonempty storyboard bodies as real conflicts.
   const boardBody=board.metadata?.dramaDraft||board.metadata?.dramaConfirmed||board.metadata?.content||"";
   if(!boardBody.trim())continue;
   const parsed=readStoryboardDraft(boardBody);
   if(!parsed)throw fail("drama_asset_candidate_conflict",409);
   const shots=parsed.shots.map(shot=>({...shot,
    characterVariantIds:[...new Set(shot.characterVariantIds.map(id=>mapped(mapped(id,variantMapping),assetMapping)))],
    // JSON drafts omit optional scene fields. Never add explicit undefined:
    // stableJson rejects it and the endpoint would otherwise return internal_error.
    ...(shot.sceneId===undefined?{}:{sceneId:mapped(shot.sceneId,assetMapping)}),
    ...(shot.sceneVariantId===undefined?{}:{sceneVariantId:mapped(shot.sceneVariantId,variantMapping)}),
    propIds:shot.propIds.map(id=>mapped(id,assetMapping)),
    keyPropIds:shot.keyPropIds.map(id=>mapped(id,assetMapping)),
   }));
   // Do not silently accept a candidate whose variant cannot be matched.
   if(shots.some(shot=>aliases.some(id=>shot.characterVariantIds.includes(id)||shot.sceneVariantId===id)))
    throw fail("drama_asset_candidate_variant_unmapped",409);
   targetBodies.push({board,content:stableJson({...parsed,shots})});
  }
  const references=(node.metadata?.dramaAssetReferences??[]).map(ref=>({
   ...ref,assetId:mapped(ref.assetId,assetMapping),
   ...(ref.variantId?{variantId:mapped(ref.variantId,variantMapping)}:{}),
  }));
  const slots=new Map();
  for(const ref of references){
   const key=ref.variantId??ref.assetId;
   if(slots.has(key)&&stableJson(slots.get(key))!==stableJson(ref))
    throw fail("drama_asset_candidate_reference_conflict",409);
   slots.set(key,ref);
  }
   const mergedReferences=[...slots.values()];   const checkedAssets=validateDramaPipelineSnapshot({version:1,revision:1,stage:"assets",
    assets,references:mergedReferences,shots:[]});
   if(!checkedAssets.valid)throw fail("drama_asset_candidate_invalid",422);
   node.metadata={...node.metadata,dramaDraft:stableJson({assets}),dramaAssetReferences:mergedReferences};
   for(const {board,content} of targetBodies){
    const checked=validateDramaPipelineSnapshot({version:1,revision:1,stage:"storyboard",
     assets,references:mergedReferences,shots:readStoryboardDraft(content).shots});
    if(!checked.valid||!validStoryboardDraftReferences(board,content,document.nodes,document.connections))
     throw fail("drama_asset_candidate_invalid",422);
    board.metadata={...board.metadata,dramaDraft:content};
   }
   delete node.metadata.dramaAssetCandidate;
  db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
   .run(validateDocument(document),project.revision+1,projectId);
  emitEvent(db,{id:projectId,revision:project.revision+1,kind:"updated"});
  return {...project,revision:project.revision+1,mapping:{assetIds,variantIds}};
 });
}
