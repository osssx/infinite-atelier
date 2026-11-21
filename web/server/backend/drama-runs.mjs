import {createHash,randomUUID} from "node:crypto";
import {readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";
import {validateDramaPipelineSnapshot} from "./drama-pipeline.mjs";
import {writeTransaction,stableJson} from "./repository.mjs";
import {normalizeOpenAiCompatBaseUrl} from "./openai-compat-endpoints.mjs";

const digest=value=>createHash("sha256").update(stableJson(value)).digest("hex");
const fail=(code,statusCode=409)=>Object.assign(Error(code),{code,statusCode});

export const DRAMA_RUN_SCHEMA=`CREATE TABLE IF NOT EXISTS drama_runs(
   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
   id TEXT NOT NULL, node_id TEXT NOT NULL, episode_id TEXT NOT NULL,
   fingerprint TEXT NOT NULL, frozen TEXT NOT NULL, state TEXT NOT NULL,
   candidate TEXT, error TEXT, PRIMARY KEY(project_id,id));
   CREATE INDEX IF NOT EXISTS drama_runs_by_node ON drama_runs(project_id,node_id);`;

export function initDramaRuns(db){
 db.exec("UPDATE drama_runs SET state='interrupted' WHERE state='running'");
}

export function exportDramaRuns(db,projectId,document){
 const ids=new Set(document.nodes.filter(node=>node.type==="drama:storyboard").map(node=>node.id));
 return db.prepare(`SELECT id,node_id AS nodeId,episode_id AS episodeId,fingerprint,state,frozen,candidate,error
  FROM drama_runs WHERE project_id=? ORDER BY rowid`).all(projectId).filter(row=>ids.has(row.nodeId)).map(row=>({
   ...row,state:row.state==="running"?"interrupted":row.state,
   frozen:JSON.parse(row.frozen),candidate:row.candidate?JSON.parse(row.candidate):null,
  }));
}

export function importDramaRuns(db,projectId,document,runs){
 if(runs===undefined)return;
 const ids=new Set(document.nodes.filter(node=>node.type==="drama:storyboard").map(node=>node.id));
 const validId=value=>typeof value==="string"&&value.length>0&&value.length<=128;
 if(!Array.isArray(runs))throw fail("archive_invalid_drama_runs",422);
 const insert=db.prepare("INSERT INTO drama_runs VALUES(?,?,?,?,?,?,?,?,?)");
 const seen=new Set();
 for(const row of runs){
  if(!row||!validId(row.id)||seen.has(row.id)||!ids.has(row.nodeId)||!validId(row.episodeId)||
   !/^[a-f0-9]{64}$/.test(row.fingerprint)||!["interrupted","ready","failed","adopted"].includes(row.state)||
   !row.frozen?.input||row.frozen.input.episode?.id!==row.episodeId||!Array.isArray(row.frozen.baseline)||
   (row.error!==null&&typeof row.error!=="string")||
   (["ready","adopted"].includes(row.state)&&(!row.candidate||
    !readStoryboardDraft(stableJson(row.candidate))?.shots.every(shot=>shot.episodeId===row.episodeId))))
   throw fail("archive_invalid_drama_runs",422);
  seen.add(row.id);
  insert.run(projectId,row.id,row.nodeId,row.episodeId,row.fingerprint,stableJson(row.frozen),row.state,
   row.candidate?stableJson(row.candidate):null,row.error);
 }
}

function gather(document,nodeId,episodeId,scope={}){
 const node=document.nodes.find(item=>item.id===nodeId&&item.type==="drama:storyboard");
 if(!node)throw fail("drama_storyboard_not_found",404);
 const upstream=(target,type)=>{
  const matches=document.connections.flatMap(edge=>{
   if(edge.toNodeId!==target.id)return [];
   const parent=document.nodes.find(item=>item.id===edge.fromNodeId&&item.type===type);
   return parent?[{parent,edge}]:[];
  });
  if(matches.length!==1)throw fail("drama_upstream_ambiguous_or_missing");
  return matches[0];
 };
 const assets=upstream(node,"drama:assets"), episodes=upstream(node,"drama:episodes");
 const source=upstream(assets.parent,"drama:source"), episodeSource=upstream(episodes.parent,"drama:source");
 if(source.parent.id!==episodeSource.parent.id)throw fail("drama_story_source_mismatch");
 const plan=readAssetDraft(assets.parent.metadata?.dramaConfirmed??"");
 const episode=readEpisodeDraft(episodes.parent.metadata?.dramaConfirmed??"")?.episodes.find(item=>item.id===episodeId);
 const story=source.parent.metadata?.dramaConfirmed;
 if(!plan||!episode||!story?.trim())throw fail("drama_upstream_unconfirmed");
 const draft=node.metadata?.dramaDraft||node.metadata?.dramaConfirmed||"";
 const parsed=draft?readStoryboardDraft(draft):{shots:[]};
 if(!parsed)throw fail("drama_draft_invalid",422);
 if(scope.sequenceId&&!episode.sequences?.some(sequence=>sequence.id===scope.sequenceId))
  throw fail("drama_sequence_not_found",404);
 const contains=shot=>shot.episodeId===episodeId&&(!scope.sequenceId||shot.sequenceId===scope.sequenceId)&&
  (!scope.shotId||shot.id===scope.shotId);
 const baseline=parsed.shots.filter(contains);
 if(scope.shotId&&baseline.length!==1)throw fail("drama_shot_not_found",404);
 const input={story,episode,scope,assets:plan.assets,edges:[assets,episodes,source,episodeSource].map(item=>item.edge.id)};
 const revisions=[assets,episodes,source].map(({parent})=>({
  nodeId:parent.id,revisionId:parent.metadata?.dramaConfirmedVersionId??null,
 }));
 return {node,input,revisions,parsed,baseline,contains};
}

export function createDramaRunService({db,getProject,validateDocument,emitEvent,generate}){
 const find=(projectId,id)=>db.prepare("SELECT * FROM drama_runs WHERE project_id=? AND id=?").get(projectId,id);
 const view=row=>({id:row.id,nodeId:row.node_id,episodeId:row.episode_id,status:row.state,
  candidate:row.candidate?JSON.parse(row.candidate):null,error:row.error});
 const get=(projectId,id)=>{
  getProject(db,projectId);
  const row=find(projectId,id);
  if(!row)throw fail("drama_run_not_found",404);
  return view(row);
 };
 async function submit(projectId,{requestId,nodeId,episodeId,sequenceId,shotId,channelId,provider,model,baseUrl}){
  const config={channelId,provider,model,
   ...(provider==="openai_compatible"?{baseUrl:normalizeOpenAiCompatBaseUrl(baseUrl)}:{})};
  const scope={...(sequenceId?{sequenceId}:{}),...(shotId?{shotId}:{})};
  const fingerprint=digest({nodeId,episodeId,scope,config});
  const frozen=writeTransaction(db,()=>{
   const project=getProject(db,projectId);
   const existing=find(projectId,requestId);
   if(existing){
    if(existing.fingerprint!==fingerprint)throw fail("drama_run_id_conflict");
    return null;
   }
   const {input,baseline,revisions}=gather(project.document,nodeId,episodeId,scope);
   const frozen={input,baseline,config,revisions};
   db.prepare("INSERT INTO drama_runs VALUES(?,?,?,?,?,?,'running',NULL,NULL)")
    .run(projectId,requestId,nodeId,episodeId,fingerprint,stableJson(frozen));
   return frozen;
  });
  if(!frozen)return get(projectId,requestId);
  try{
   const answer=await generate(frozen.config,frozen.input,frozen.baseline);
   const parsed=readStoryboardDraft(answer);
   const existingIds=new Set(frozen.baseline.map(shot=>shot.id));
   if(!parsed?.shots.length||parsed.shots.some(shot=>shot.episodeId!==episodeId||
      (sequenceId&&shot.sequenceId!==sequenceId)||
      (shot.sequenceId!==undefined&&!frozen.input.episode.sequences?.some(sequence=>sequence.id===shot.sequenceId)))||
      (shotId&&parsed.shots.length!==1))
    throw fail("drama_candidate_invalid",422);
   const shots=parsed.shots.map(shot=>{
    if(!shotId)return {...shot,id:existingIds.has(shot.id)?shot.id:randomUUID()};
    const scoped={...shot,id:shotId,order:frozen.baseline[0].order};
    if(frozen.baseline[0].sequenceId)scoped.sequenceId=frozen.baseline[0].sequenceId;
    else delete scoped.sequenceId;
    return scoped;
   });
   if(!validateDramaPipelineSnapshot({version:1,revision:1,stage:"storyboard",
    assets:frozen.input.assets,references:[],shots}).valid)throw fail("drama_candidate_invalid",422);
   db.prepare("UPDATE drama_runs SET state='ready',candidate=? WHERE project_id=? AND id=?")
    .run(stableJson({shots}),projectId,requestId);
  }catch(error){
   db.prepare("UPDATE drama_runs SET state='failed',error=? WHERE project_id=? AND id=?")
    .run(error?.code==="drama_candidate_invalid"?error.code:"drama_pipeline_generation_failed",projectId,requestId);
  }
  return get(projectId,requestId);
 }
 function adopt(projectId,id){
  return writeTransaction(db,()=>{
   const project=getProject(db,projectId);
   const row=find(projectId,id);
   if(!row)throw fail("drama_run_not_found",404);
   if(row.state==="adopted")return project;
   if(row.state!=="ready")throw fail("drama_candidate_not_ready");
   const frozen=JSON.parse(row.frozen);
   const {node,input,baseline,parsed,contains}=gather(project.document,row.node_id,row.episode_id,frozen.input.scope);
   if(digest(input)!==digest(frozen.input)||digest(baseline)!==digest(frozen.baseline))
    throw fail("drama_candidate_conflict");
   const {shots}=JSON.parse(row.candidate);
   if(shots.some(shot=>shot.episodeId!==row.episode_id||
    (input.scope?.sequenceId&&shot.sequenceId!==input.scope.sequenceId)||
    (input.scope?.shotId&&shot.id!==input.scope.shotId)))throw fail("drama_candidate_conflict");
   const preserved=parsed.shots.filter(shot=>!contains(shot));
   const existingIds=new Set(preserved.map(shot=>shot.id));
   if(shots.some(shot=>existingIds.has(shot.id)))throw fail("drama_candidate_conflict");
   node.metadata.dramaDraft=stableJson({...parsed,shots:[...preserved,...shots]});
   const revision=project.revision+1;
   db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
    .run(validateDocument(project.document),revision,projectId);
   db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
    .run(projectId,node.id,`drama-run:${id}`,row.fingerprint,revision);
   db.prepare("UPDATE drama_runs SET state='adopted' WHERE project_id=? AND id=?").run(projectId,id);
   emitEvent(db,{id:projectId,revision,kind:"updated"});
   return {...project,revision};
  });
 }
 return {submit,get,adopt,list(projectId,nodeId){
  getProject(db,projectId);
  return db.prepare("SELECT * FROM drama_runs WHERE project_id=? AND node_id=? ORDER BY rowid DESC LIMIT 30")
   .all(projectId,nodeId).map(view);
 }};
}
