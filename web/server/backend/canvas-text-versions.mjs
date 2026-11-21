import {createHash} from "node:crypto";
import {canvasTextContentPatch,readAssetDraft,readEpisodeDraft,readStoryboardDraft,validStoryboardDraftReferences} from "../canvas-text-content.mjs";
import {validateDramaPipelineSnapshot} from "./drama-pipeline.mjs";
import {validCanvasNodeId} from "../canvas-node-id.mjs";
import {writeTransaction,assertNoRawCredentials,stableJson} from "./repository.mjs";
import {reconcileSourceParagraphs} from "./drama-source-paragraphs.mjs";
import {dramaDependencies} from "./drama-dependencies.mjs";
import {normalizeEpisodeEvents} from "../drama-episode-links.mjs";
import {removedDramaAssetUsages} from "./drama-asset-usage.mjs";
import {hydrateCreativeDocument} from "./creative-payloads.mjs";

export const textVersionNodeTypes=new Set(["text","drama:source","drama:assets","drama:episodes","drama:storyboard"]);
const fail=(code,statusCode=400)=>Object.assign(Error(code),{code,statusCode});
const digest=content=>createHash("sha256").update(content).digest("hex");
const sources=new Set(["manual","restore-backup","confirmation"]);

export function extractTextVersions(document){
 if(!Array.isArray(document?.nodes))return {document,entries:[],hasInline:false};
 let hasInline=false;
 const entries=[];
 const nodes=document.nodes.map(node=>{
  if(!textVersionNodeTypes.has(node?.type)||!Object.hasOwn(node.metadata??{},"textVersions"))return node;
  hasInline=true;
  const {textVersions,...metadata}=node.metadata;
  if(!Array.isArray(textVersions))throw fail("invalid_text_versions");
  textVersions.forEach(version=>entries.push({...version,nodeId:node.id}));
  return {...node,metadata};
 });
 return {document:{...document,nodes},entries,hasInline};
}

export function insertTextVersions(db,projectId,entries,{legacy=false}={}){
 const insert=db.prepare(`INSERT INTO canvas_text_versions
  (project_id,node_id,id,created_at,source,note,content,digest,preview,provenance_json)
  VALUES(?,?,?,?,?,?,?,?,?,?)`);
 const counts=new Map();
 for(const entry of entries){
  const {nodeId,id,createdAt,source,note,content}=entry;
  const count=(counts.get(nodeId)??0)+(source==="confirmation"?0:1);
  if(count>50||!validCanvasNodeId(nodeId)||typeof id!=="string"||!id||id.length>128||
     typeof createdAt!=="string"||!sources.has(source)||typeof content!=="string"||
     (!legacy&&Buffer.byteLength(JSON.stringify(content))>4*1024*1024)||
     (note!=null&&(typeof note!=="string"||note.length>100)))throw fail("invalid_text_versions");
  counts.set(nodeId,count);
  const provenance=entry.provenance??{};
  if(!provenance||typeof provenance!=="object"||Array.isArray(provenance))throw fail("invalid_text_versions");
  assertNoRawCredentials(provenance);
  const serialized=JSON.stringify(provenance);
  if(Buffer.byteLength(serialized)>4*1024*1024)throw fail("invalid_text_versions");
  insert.run(projectId,nodeId,id,createdAt,source,note??null,content,digest(content),content.slice(0,220),serialized);
 }
}

export function migrateTextVersions(db){
 db.exec(`CREATE TABLE IF NOT EXISTS canvas_text_versions(
  seq INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,source TEXT NOT NULL,note TEXT,
  content TEXT NOT NULL,digest TEXT NOT NULL,preview TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provenance_json)),UNIQUE(project_id,node_id,id));
  CREATE INDEX IF NOT EXISTS canvas_text_versions_order ON canvas_text_versions(project_id,node_id,seq DESC);
  CREATE TABLE IF NOT EXISTS canvas_text_version_operations(
   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,node_id TEXT NOT NULL,
   id TEXT NOT NULL, fingerprint TEXT NOT NULL, graph_revision INTEGER,
   PRIMARY KEY(project_id,node_id,id));
  CREATE INDEX IF NOT EXISTS canvas_text_version_revision ON canvas_text_version_operations(project_id,graph_revision DESC);`);
 const update=db.prepare("UPDATE projects SET document_json=? WHERE id=?");
 for(const {id} of db.prepare("SELECT id FROM projects WHERE instr(document_json,'textVersions')>0").all()){
  const row=db.prepare("SELECT document_json FROM projects WHERE id=?").get(id);
  const {document,entries}=extractTextVersions(JSON.parse(row.document_json));
  insertTextVersions(db,id,entries.reverse(),{legacy:true});
  update.run(JSON.stringify(document),id);
 }
}

function readNode(db,projectId,nodeId){
 const row=db.prepare("SELECT document_json,revision FROM projects WHERE id=? AND deleted_at IS NULL").get(projectId);
 if(!row)throw fail("project_not_found",404);
 const document=hydrateCreativeDocument(db,projectId,JSON.parse(row.document_json));
 const node=document.nodes.find(item=>item.id===nodeId&&textVersionNodeTypes.has(item.type));
 if(!node)throw fail("text_node_not_found",404);
 return {node,document,revision:row.revision};
}
const fields="id,created_at AS createdAt,source,note,digest,preview";
export function readTextVersions(db,projectId,nodeId,id){
 readNode(db,projectId,nodeId);
 if(id===undefined)return {versions:db.prepare(`SELECT ${fields} FROM canvas_text_versions WHERE project_id=? AND node_id=? ORDER BY seq DESC`).all(projectId,nodeId)};
 const version=db.prepare(`SELECT ${fields},content,provenance_json FROM canvas_text_versions WHERE project_id=? AND node_id=? AND id=?`).get(projectId,nodeId,id);
 if(!version)throw fail("text_version_not_found",404);
 const {provenance_json,...summary}=version;
 return {version:{...summary,provenance:JSON.parse(provenance_json)}};
}

export function readDramaRevisionScope(db,projectId,nodeId,{versionId,episodeId,sequenceId,offset=0,limit=50,summaryOnly=false,draft=false}={}){
 const {node,document}=readNode(db,projectId,nodeId);
 const selected=versionId??node.metadata?.dramaConfirmedVersionId;
 const version=draft?{id:null,content:currentContent(node),provenance:{}}:selected?readTextVersions(db,projectId,nodeId,selected).version:
  {id:null,content:node.metadata?.dramaConfirmed??"",provenance:{}};
 let entries;
 if(node.type==="drama:storyboard")entries=version.content.trim()?readStoryboardDraft(version.content)?.shots:[];
 else if(node.type==="drama:episodes")entries=readEpisodeDraft(version.content)?.episodes;
 else if(node.type==="drama:assets")entries=readAssetDraft(version.content)?.assets;
 else if(node.type==="drama:source")entries=version.provenance?.paragraphs??reconcileSourceParagraphs(version.content);
 if(!entries)throw fail("drama_draft_invalid",422);
 const filtered=entries.filter(item=>(!episodeId||item.episodeId===episodeId||item.id===episodeId)&&
  (!sequenceId||item.sequenceId===sequenceId));
 const groups=node.type==="drama:storyboard"?[...new Set(entries.map(item=>item.episodeId))].map(id=>({
  episodeId:id,total:entries.filter(item=>item.episodeId===id).length,
  sequenceIds:[...new Set(entries.filter(item=>item.episodeId===id&&item.sequenceId).map(item=>item.sequenceId))],
 })):[];
 const page=summaryOnly?[]:filtered.slice(offset,offset+limit);
 const parents=document.nodes.filter(parent=>document.connections.some(edge=>edge.fromNodeId===parent.id&&edge.toNodeId===nodeId));
 const referenceChoices=parents.filter(parent=>parent.type==="drama:assets")
  .flatMap(parent=>readAssetDraft(parent.metadata?.dramaConfirmed??"")?.assets??[])
  .map(asset=>({id:asset.id,kind:asset.kind,name:asset.name,variants:(asset.variants??[]).map(variant=>({id:variant.id,name:variant.name}))}));
 return {versionId:version.id,total:filtered.length,offset,limit,groups,entries:page,
  referenceChoices,entryDigests:page.map(item=>({id:item.id,digest:digest(stableJson(item))}))};
}

export function patchDramaShotDraft(db,projectId,nodeId,command,validateDocument,emitEvent){
 return writeTransaction(db,()=>{
  const {node,document,revision}=readNode(db,projectId,nodeId);
  if(node.type!=="drama:storyboard")throw fail("drama_draft_invalid",422);
  const fingerprint=digest(stableJson(command));
  const receipt=db.prepare("SELECT fingerprint FROM canvas_text_version_operations WHERE project_id=? AND node_id=? AND id=?")
   .get(projectId,nodeId,command.operationId);
  if(receipt){if(receipt.fingerprint!==fingerprint)throw fail("text_version_operation_conflict",409);return;}
  const parsed=readStoryboardDraft(currentContent(node));
  const shot=parsed?.shots.find(item=>item.id===command.shotId);
  if(!shot||digest(stableJson(shot))!==command.expectedDigest)throw fail("drama_candidate_conflict",409);
  const updated={...shot,...command.changes};
  for(const key of ["sceneId","sceneVariantId","sequenceId","durationSec"])if(updated[key]===null)delete updated[key];
  if(!readStoryboardDraft(JSON.stringify({shots:[updated]})))throw fail("drama_draft_invalid",422);
  const body=JSON.stringify({...parsed,shots:parsed.shots.map(item=>item.id===shot.id?updated:item)});
  if(!validStoryboardDraftReferences(node,body,document.nodes,document.connections))throw fail("drama_draft_invalid",422);
  node.metadata={...node.metadata,dramaDraft:body};
  db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?").run(validateDocument(document),revision+1,projectId);
  db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
   .run(projectId,nodeId,command.operationId,fingerprint,revision+1);
  emitEvent(db,{id:projectId,revision:revision+1,kind:"updated"});
 });
}

function currentContent(node){
 const m=node.metadata;
 if(node.type==="text")return m?.content??"";
 if(node.type==="drama:source")return m?.dramaDraft??m?.content??m?.dramaConfirmed??"";
 return m?.dramaDraft||m?.dramaConfirmed||m?.content||"";
}

function validateDramaConfirmation(node,content,document){
 if(node.type!=="drama:storyboard"&&node.type!=="drama:assets")return;
 const parents=document.nodes.filter(parent=>document.connections.some(edge=>edge.fromNodeId===parent.id&&edge.toNodeId===node.id));
 const confirmed=(type,parse)=>{
  const matches=parents.filter(parent=>parent.type===type);
  return matches.length===1?parse(matches[0].metadata?.dramaConfirmed??""):null;
 };
 const assetDraft=node.type==="drama:assets"?readAssetDraft(content):confirmed("drama:assets",readAssetDraft);
 const shots=node.type==="drama:storyboard"?readStoryboardDraft(content).shots:[];
 const episodes=node.type==="drama:storyboard"?confirmed("drama:episodes",readEpisodeDraft):null;
 if(!assetDraft||(shots.length&&(!episodes||shots.some(shot=>!episodes.episodes.some(episode=>episode.id===shot.episodeId&&
   (shot.sequenceId===undefined||episode.sequences?.some(sequence=>sequence.id===shot.sequenceId)))))))
  throw fail("drama_draft_invalid",422);
 const result=validateDramaPipelineSnapshot({version:1,revision:1,stage:node.type.slice(6),
  assets:assetDraft.assets,references:node.type==="drama:assets"?node.metadata?.dramaAssetReferences??[]:[],shots});
 if(!result.valid)throw fail("drama_draft_invalid",422);
 if(node.type==="drama:assets"){
  const usages=removedDramaAssetUsages(document,node.id,assetDraft.assets);
  if(usages.length)throw Object.assign(fail("drama_asset_in_use",409),{usages});
 }
}

export function mutateTextVersions(db,projectId,nodeId,command,validateDocument,emitEvent){
 const {operationId,action,expectedRevision,versionId,mode,note}=command;
 const fingerprint=digest(JSON.stringify([action,expectedRevision,versionId,mode,note]));
 return writeTransaction(db,()=>{
  const {node,document,revision}=readNode(db,projectId,nodeId);
  const graphAction=action==="confirm"||action==="restore";
  const receipt=db.prepare("SELECT fingerprint,graph_revision FROM canvas_text_version_operations WHERE project_id=? AND node_id=? AND id=?").get(projectId,nodeId,operationId);
  const graph=(rev)=>({id:projectId,revision:rev,document,deletedAt:null});
  if(receipt){
   if(receipt.fingerprint!==fingerprint)throw fail("text_version_operation_conflict",409);
   return graphAction?graph(revision):{ok:true};
  }
  if(action!=="delete"&&expectedRevision!==revision)throw fail("project_revision_conflict",409);
  const content=currentContent(node);
  const versions=db.prepare("SELECT id,digest,source FROM canvas_text_versions WHERE project_id=? AND node_id=? ORDER BY seq DESC").all(projectId,nodeId);
  const add=(value,source,versionNote,provenance={})=>{
   if(source!=="confirmation"&&versions.filter(version=>version.source!=="confirmation").length>=50)
    throw fail("text_version_limit",409);
   insertTextVersions(db,projectId,[{nodeId,id:operationId,createdAt:new Date().toISOString(),source,note:versionNote,content:value,provenance}]);
  };
  let patch;
  if(action==="save"){
   if(!content.trim()||versions[0]?.digest===digest(content))throw fail("text_version_save_not_allowed",409);
   add(content,"manual",note);
  }else if(action==="delete"){
   if(versionId===node.metadata?.dramaConfirmedVersionId||versionId===node.metadata?.dramaAssetReferenceRevisionId||document.nodes.some(item=>
    item.metadata?.dramaVideoSource?.nodeId===nodeId&&item.metadata.dramaVideoSource.revisionId===versionId||
    item.metadata?.dramaInputDependencies?.some(dependency=>dependency.nodeId===nodeId&&(dependency.revisionId===versionId||dependency.mediaRevisionId===versionId)))||
    db.prepare(`SELECT 1 FROM canvas_text_versions AS version, json_each(version.provenance_json,'$.inputDependencies') AS dependency
      WHERE version.project_id=? AND json_extract(dependency.value,'$.nodeId')=?
      AND (json_extract(dependency.value,'$.revisionId')=? OR json_extract(dependency.value,'$.mediaRevisionId')=?) LIMIT 1`).get(projectId,nodeId,versionId,versionId)||
    db.prepare(`SELECT 1 FROM drama_runs AS run, json_each(run.frozen,'$.revisions') AS revision
      WHERE run.project_id=? AND json_extract(revision.value,'$.nodeId')=?
      AND json_extract(revision.value,'$.revisionId')=? LIMIT 1`).get(projectId,nodeId,versionId))
    throw fail("text_version_in_use",409);
   db.prepare("DELETE FROM canvas_text_versions WHERE project_id=? AND node_id=? AND id=?").run(projectId,nodeId,versionId);
  }else if(action==="restore"){
   const target=db.prepare("SELECT content FROM canvas_text_versions WHERE project_id=? AND node_id=? AND id=?").get(projectId,nodeId,versionId);
   if(!target)throw fail("text_version_not_found",404);
   if(!target.content.trim()||!canvasTextContentPatch(node.type,target.content))throw fail("text_version_invalid_restore");
   if(content!==target.content){
    const unbacked=content.trim()&&!versions.some(version=>version.digest===digest(content));
    if(unbacked&&mode==="direct")throw fail("text_version_backup_required",409);
    if(unbacked&&mode==="backup")add(content,"restore-backup",note);
    patch=node.type==="text"?{content:target.content}:node.type==="drama:source"?
     {content:target.content,dramaDraft:target.content}:{dramaDraft:target.content};
   }
  }else if(action==="confirm"){
    let normalized=content.trim()&&node.type!=="text"&&canvasTextContentPatch(node.type,content);
    if(!normalized)throw fail("drama_draft_invalid");
    if(node.type==="drama:episodes"){
     const draft=readEpisodeDraft(normalized.dramaDraft),earlier=readEpisodeDraft(node.metadata?.dramaConfirmed??"");
     normalized={dramaDraft:stableJson({episodes:draft.episodes.map(episode=>
      normalizeEpisodeEvents(episode,earlier?.episodes.find(item=>item.id===episode.id)??episode))})};
    }
    const next=normalized.dramaDraft;   const previous=node.metadata?.dramaConfirmed??"";
   const dependencies=dramaDependencies(document,nodeId);
   const dependenciesChanged=stableJson(dependencies)!==stableJson(node.metadata?.dramaInputDependencies??[]);
   const priorId=node.metadata?.dramaAssetReferenceRevisionId??node.metadata?.dramaConfirmedVersionId;
   const priorRecord=priorId&&db.prepare("SELECT provenance_json FROM canvas_text_versions WHERE project_id=? AND node_id=? AND id=?")
    .get(projectId,nodeId,priorId);
   const prior=priorRecord?JSON.parse(priorRecord.provenance_json):{};
   const references=node.metadata?.dramaAssetReferences??[];
   const referencesChanged=node.type==="drama:assets"&&stableJson(references)!==stableJson(prior.references??[]);
   const artChanged=node.type==="drama:source"&&(stableJson(node.metadata?.dramaArtDirection??{})!==stableJson(prior.artDirection??{})||
    (node.metadata?.dramaFilmStyle??"")!==(prior.visualStyle??""));
   const definitionChanged=previous!==next||!node.metadata?.dramaConfirmedVersionId||dependenciesChanged||artChanged;
   if(definitionChanged||referencesChanged){
    validateDramaConfirmation(node,next,document);
    if(previous.trim()&&previous!==next&&!node.metadata?.dramaConfirmedVersionId&&
       !versions.some(version=>version.digest===digest(previous))){
     insertTextVersions(db,projectId,[{nodeId,id:`legacy:${digest(previous)}`,createdAt:new Date().toISOString(),
      source:"confirmation",note:null,content:previous}]);
    }
    patch={...normalized,dramaConfirmed:next,dramaStage:node.type.slice(6),dramaConfirmedVersionId:operationId};
    if(node.type==="drama:assets"){
     patch.dramaAssetReferenceRevisionId=operationId;
     patch.dramaAssetReferenceEntries=references.map(reference=>({id:reference.variantId??reference.assetId,digest:digest(stableJson(reference))}));
     if(!definitionChanged)patch.dramaConfirmedVersionId=node.metadata.dramaConfirmedVersionId;
    }
    patch.dramaInputDependencies=dependencies;
    if(node.type==="drama:source"){
     patch.dramaSourceParagraphs=reconcileSourceParagraphs(next,node.metadata?.dramaSourceParagraphs??[]);
     patch.dramaConfirmedVisual={artDirection:node.metadata?.dramaArtDirection??{},visualStyle:node.metadata?.dramaFilmStyle??""};
    }
    add(next,"confirmation",undefined,{inputDependencies:dependencies,
     ...(patch.dramaSourceParagraphs?{paragraphs:patch.dramaSourceParagraphs}:{}),
     ...(node.type==="drama:source"?{artDirection:node.metadata?.dramaArtDirection??{},visualStyle:node.metadata?.dramaFilmStyle??""}:{}),
     ...(node.type==="drama:assets"?{references,kind:definitionChanged?"definition":"references"}: {})});
   }else if(content!==next){
    patch=normalized;
   }
  }
  const nextRevision=patch?revision+1:revision;
  if(patch){
   node.metadata={...node.metadata,...patch};
   const json=validateDocument(document);
   db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?").run(json,nextRevision,projectId);
   emitEvent(db,{id:projectId,revision:nextRevision,kind:"updated"});
  }
  db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)").run(projectId,nodeId,operationId,fingerprint,patch?nextRevision:null);
  return graphAction?graph(nextRevision):{ok:true};
 });
}
