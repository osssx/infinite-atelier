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
 const ids=new Set(document.nodes.filter(node=>["drama:storyboard","drama:episodes"].includes(node.type)).map(node=>node.id));
 return db.prepare(`SELECT id,node_id AS nodeId,episode_id AS episodeId,fingerprint,state,frozen,candidate,error
  FROM drama_runs WHERE project_id=? ORDER BY rowid`).all(projectId).filter(row=>ids.has(row.nodeId)).map(row=>({
   ...row,state:row.state==="running"?"interrupted":row.state,
   frozen:JSON.parse(row.frozen),candidate:row.candidate?JSON.parse(row.candidate):null,
  }));
}

export function importDramaRuns(db,projectId,document,runs){
 if(runs===undefined)return;
 const ids=new Set(document.nodes.filter(node=>["drama:storyboard","drama:episodes"].includes(node.type)).map(node=>node.id));
 const validId=value=>typeof value==="string"&&value.length>0&&value.length<=128;
 if(!Array.isArray(runs))throw fail("archive_invalid_drama_runs",422);
 const insert=db.prepare("INSERT INTO drama_runs VALUES(?,?,?,?,?,?,?,?,?)");
 const seen=new Set();
 for(const row of runs){
  const episodeRun=row?.frozen?.input?.stage==="episodes";
  const target=document.nodes.find(node=>node.id===row?.nodeId);
  if(episodeRun&&(target?.type!=="drama:episodes"||row.frozen.input.scope?.episodeId!==row.episodeId||
     !Number.isInteger(row.frozen.input.targetEpisodes)||row.frozen.input.targetEpisodes<1||row.frozen.input.targetEpisodes>100||
     (row.candidate&&(!readEpisodeDraft(stableJson(row.candidate))||
       row.candidate.episodes.length!==row.frozen.input.targetEpisodes||
       row.episodeId!=="*"&&row.candidate.episodes.some(episode=>episode.id!==row.episodeId)))))
   throw fail("archive_invalid_drama_runs",422);
  if(!episodeRun&&target?.type!=="drama:storyboard")throw fail("archive_invalid_drama_runs",422);
  if(!row||!validId(row.id)||seen.has(row.id)||!ids.has(row.nodeId)||!validId(row.episodeId)||
   !/^[a-f0-9]{64}$/.test(row.fingerprint)||!["interrupted","ready","failed","adopted","cancelled"].includes(row.state)||
   !row.frozen?.input||(row.frozen.input.stage!=="episodes"&&row.frozen.input.episode?.id!==row.episodeId)||!Array.isArray(row.frozen.baseline)||
   (row.error!==null&&typeof row.error!=="string")||
   (["ready","adopted"].includes(row.state)&&(!row.candidate||
    !(row.frozen.input.stage==="episodes"?readEpisodeDraft(stableJson(row.candidate))?.episodes.length:
      readStoryboardDraft(stableJson(row.candidate))?.shots.every(shot=>shot.episodeId===row.episodeId)))))
   throw fail("archive_invalid_drama_runs",422);
  seen.add(row.id);
  insert.run(projectId,row.id,row.nodeId,row.episodeId,row.fingerprint,stableJson(row.frozen),row.state,
   row.candidate?stableJson(row.candidate):null,row.error);
 }
}

function gather(document,nodeId,episodeId,scope={}){
 const node=document.nodes.find(item=>item.id===nodeId&&["drama:storyboard","drama:episodes"].includes(item.type));
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
 if(node.type==="drama:episodes"){
  if(scope.sequenceId||scope.shotId)throw fail("drama_episode_scope_invalid",422);
  const source=upstream(node,"drama:source");
  const story=source.parent.metadata?.dramaConfirmed;
  if(!story?.trim())throw fail("drama_upstream_unconfirmed");
  const draft=node.metadata?.dramaDraft||node.metadata?.dramaConfirmed||"";
  const parsed=draft?readEpisodeDraft(draft):{episodes:[]};
  if(!parsed)throw fail("drama_draft_invalid",422);
  const contains=episode=>episodeId==="*"||episode.id===episodeId;
  const baseline=parsed.episodes.filter(contains);
  if(episodeId!=="*"&&baseline.length!==1)throw fail("drama_episode_not_found",404);
  return {node,parsed,baseline,contains,input:{stage:"episodes",story,scope:{episodeId},
   targetEpisodes:episodeId==="*"?Math.max(1,Math.min(100,Number(node.metadata?.targetEpisodes)||1)):1,
   paragraphs:source.parent.metadata?.dramaSourceParagraphs??[],edges:[source.edge.id]},
   revisions:[{nodeId:source.parent.id,revisionId:source.parent.metadata?.dramaConfirmedVersionId??null}]};
 }
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
 const paragraphs=source.parent.metadata?.dramaSourceParagraphs??[];
 const input={story,episode,scope,assets:plan.assets,paragraphs,
  artDirection:source.parent.metadata?.dramaConfirmedVisual?.artDirection??source.parent.metadata?.dramaArtDirection??{},
  visualStyle:source.parent.metadata?.dramaConfirmedVisual?.visualStyle??source.parent.metadata?.dramaFilmStyle??"",
  edges:[assets,episodes,source,episodeSource].map(item=>item.edge.id)};
 const revisions=[assets,episodes,source].map(({parent})=>({
  nodeId:parent.id,revisionId:parent.metadata?.dramaConfirmedVersionId??null,
 }));
 return {node,input,revisions,parsed,baseline,contains};
}

export function createDramaRunService({db,getProject,validateDocument,emitEvent,generate}){
 const controllers=new Map();
 const runKey=(projectId,id)=>JSON.stringify([projectId,id]);
 const find=(projectId,id)=>db.prepare("SELECT * FROM drama_runs WHERE project_id=? AND id=?").get(projectId,id);
 const view=row=>({id:row.id,nodeId:row.node_id,episodeId:row.episode_id,status:row.state,
  candidate:row.candidate?JSON.parse(row.candidate):null,error:row.error});
 const get=(projectId,id)=>{
  getProject(db,projectId);
  const row=find(projectId,id);
  if(!row)throw fail("drama_run_not_found",404);
  return view(row);
 };
 async function execute(projectId,requestId,frozen){
  const episodeId=find(projectId,requestId).episode_id;
  const {sequenceId,shotId}=frozen.input.scope??{};
  const controller=new AbortController();
  const key=runKey(projectId,requestId);
  controllers.set(key,controller);
  try{
   if(frozen.input.stage==="episodes"){
    let answer=await generate(frozen.config,frozen.input,frozen.baseline,controller.signal);
    if(controller.signal.aborted)return get(projectId,requestId);
    let parsed=readEpisodeDraft(answer);
    if(!parsed&&typeof answer==="string"&&answer.length<=32000){
     answer=await generate(frozen.config,frozen.input,frozen.baseline,controller.signal,{response:answer});
     if(controller.signal.aborted)return get(projectId,requestId);
     parsed=readEpisodeDraft(answer);
    }
    if(parsed?.episodes.length!==frozen.input.targetEpisodes)throw fail("drama_candidate_invalid",422);
    const usedIds=new Set();
    const episodes=parsed.episodes.map((episode,index)=>{
     const existing=frozen.baseline.find(item=>item.id===episode.id&&!usedIds.has(item.id))??
      frozen.baseline.find((item,offset)=>offset===index&&!usedIds.has(item.id));
     const id=episodeId!=="*"?episodeId:existing?.id??randomUUID();
     usedIds.add(id);return {...episode,id};
    });
    db.prepare("UPDATE drama_runs SET state='ready',candidate=? WHERE project_id=? AND id=? AND state='running'")
     .run(stableJson({episodes}),projectId,requestId);
    return get(projectId,requestId);
   }
   const sequences=!sequenceId&&!shotId?frozen.input.episode.sequences??[]:[];
   const saved=find(projectId,requestId).candidate;
   const checkpoint=saved?JSON.parse(saved):{shots:[],completedSequenceIds:[]};
   const completed=new Set(checkpoint.completedSequenceIds??[]);
   let collected=sequences.length?checkpoint.shots:[];
   const scopes=sequences.length?sequences.map(sequence=>sequence.id):[sequenceId];
   for(const currentSequence of scopes){
    if(completed.has(currentSequence))continue;
    if(controller.signal.aborted)return get(projectId,requestId);
    const input=currentSequence?{...frozen.input,scope:{...frozen.input.scope,sequenceId:currentSequence}}:frozen.input;
    const baseline=currentSequence?frozen.baseline.filter(shot=>shot.sequenceId===currentSequence):frozen.baseline;
    let answer=await generate(frozen.config,input,baseline,controller.signal);
    if(controller.signal.aborted)return get(projectId,requestId);
    let parsed=readStoryboardDraft(answer);
    if(!parsed&&typeof answer==="string"&&answer.length<=32000){
     answer=await generate(frozen.config,input,baseline,controller.signal,{
      response:answer,reason:"Return a valid JSON object with a shots array matching the requested schema. Preserve the supplied content and IDs.",
     });
     if(controller.signal.aborted)return get(projectId,requestId);
     parsed=readStoryboardDraft(answer);
    }
    const existingIds=new Set(frozen.baseline.map(shot=>shot.id));
    if(!parsed?.shots.length||parsed.shots.some(shot=>shot.episodeId!==episodeId||
       (currentSequence&&shot.sequenceId!==currentSequence)||
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
    collected=[...collected,...shots];
    if(currentSequence)completed.add(currentSequence);
    db.prepare("UPDATE drama_runs SET candidate=? WHERE project_id=? AND id=? AND state='running'")
     .run(stableJson({shots:collected,completedSequenceIds:[...completed]}),projectId,requestId);
   }
   if(new Set(collected.map(shot=>shot.id)).size!==collected.length)throw fail("drama_candidate_invalid",422);
   db.prepare("UPDATE drama_runs SET state='ready' WHERE project_id=? AND id=? AND state='running'")
    .run(projectId,requestId);
  }catch(error){
   db.prepare("UPDATE drama_runs SET state='failed',error=? WHERE project_id=? AND id=? AND state='running'")
    .run(error?.code==="drama_candidate_invalid"?error.code:"drama_pipeline_generation_failed",projectId,requestId);
  }finally{controllers.delete(key);}
  return get(projectId,requestId);
 }
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
  return execute(projectId,requestId,frozen);
 }
 function adopt(projectId,id,shotIds){
  return writeTransaction(db,()=>{
   const project=getProject(db,projectId);
   const row=find(projectId,id);
   if(!row)throw fail("drama_run_not_found",404);
   if(row.state==="adopted")return project;
   if(row.state!=="ready")throw fail("drama_candidate_not_ready");
   const frozen=JSON.parse(row.frozen);
   const {node,input,baseline,parsed,contains}=gather(project.document,row.node_id,row.episode_id,frozen.input.scope);
   if(digest(input)!==digest(frozen.input))
    throw fail("drama_candidate_conflict");
   const candidate=JSON.parse(row.candidate);
   if(frozen.input.stage==="episodes"){
    if(shotIds)throw fail("drama_episode_scope_invalid",422);
    if(digest(baseline)!==digest(frozen.baseline))throw fail("drama_candidate_conflict");
    const preserved=parsed.episodes.filter(episode=>!contains(episode));
    if(candidate.episodes.some(episode=>preserved.some(item=>item.id===episode.id)))throw fail("drama_candidate_conflict");
    const replacements=new Map(candidate.episodes.map(episode=>[episode.id,episode]));
    const episodes=row.episode_id==="*"?candidate.episodes:parsed.episodes.map(episode=>replacements.get(episode.id)??episode);
    node.metadata={...node.metadata,dramaDraft:stableJson({...parsed,episodes})};
    const revision=project.revision+1;
    db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?").run(validateDocument(project.document),revision,projectId);
    db.prepare("UPDATE drama_runs SET state='adopted' WHERE project_id=? AND id=?").run(projectId,id);
    db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
     .run(projectId,node.id,`drama-run:${id}`,row.fingerprint,revision);
    emitEvent(db,{id:projectId,revision,kind:"updated"});
    return {...project,revision};
   }
   const allShots=candidate.shots;
   const adoptedIds=new Set(candidate.adoptedShotIds??[]);
   const selected=shotIds?new Set(shotIds):null;
   if(selected&&(!selected.size||[...selected].some(id=>!allShots.some(shot=>shot.id===id))))
    throw fail("drama_candidate_conflict");
   const shots=allShots.filter(shot=>!selected||selected.has(shot.id));
   const expected=frozen.baseline.filter(shot=>!adoptedIds.has(shot.id));
   expected.push(...allShots.filter(shot=>adoptedIds.has(shot.id)));
   const byId=items=>new Map(items.map(item=>[item.id,item]));
   const currentById=byId(baseline),expectedById=byId(expected);
   const checkedIds=selected??new Set([...currentById.keys(),...expectedById.keys()]);
   for(const shotId of checkedIds){
    if(stableJson(currentById.get(shotId)??null)!==stableJson(expectedById.get(shotId)??null))
     throw fail("drama_candidate_conflict");
   }
   if(selected&&shots.every(shot=>adoptedIds.has(shot.id)))return project;
   if(shots.some(shot=>shot.episodeId!==row.episode_id||
    (input.scope?.sequenceId&&shot.sequenceId!==input.scope.sequenceId)||
    (input.scope?.shotId&&shot.id!==input.scope.shotId)))throw fail("drama_candidate_conflict");
   const preserved=parsed.shots.filter(shot=>selected?!selected.has(shot.id):!contains(shot));
   const existingIds=new Set(preserved.map(shot=>shot.id));
   if(shots.some(shot=>existingIds.has(shot.id)))throw fail("drama_candidate_conflict");
   node.metadata.dramaDraft=stableJson({...parsed,shots:[...preserved,...shots]});
   const revision=project.revision+1;
   db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
    .run(validateDocument(project.document),revision,projectId);
   db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
    .run(projectId,node.id,`drama-run:${id}:${digest(shotIds??[])}`,row.fingerprint,revision);
   const adopted=selected?[...new Set([...adoptedIds,...selected])]:allShots.map(shot=>shot.id);
   db.prepare("UPDATE drama_runs SET state=?,candidate=? WHERE project_id=? AND id=?")
    .run(selected?"ready":"adopted",stableJson({...candidate,adoptedShotIds:adopted}),projectId,id);
   emitEvent(db,{id:projectId,revision,kind:"updated"});
   return {...project,revision};
  });
 }
 function cancel(projectId,id){
  get(projectId,id);
  db.prepare("UPDATE drama_runs SET state='cancelled' WHERE project_id=? AND id=? AND state='running'").run(projectId,id);
  controllers.get(runKey(projectId,id))?.abort();
  return get(projectId,id);
 }
 async function retry(projectId,id){
  get(projectId,id);
  if(controllers.has(runKey(projectId,id)))return get(projectId,id);
  const row=find(projectId,id);
  const claimed=db.prepare("UPDATE drama_runs SET state='running',error=NULL WHERE project_id=? AND id=? AND state IN ('failed','interrupted','cancelled')")
   .run(projectId,id);
  if(!claimed.changes)return get(projectId,id);
  return execute(projectId,id,JSON.parse(row.frozen));
 }
 return {submit,get,adopt,cancel,retry,list(projectId,nodeId){
  getProject(db,projectId);
  return db.prepare(`SELECT id,node_id,episode_id,state,error,
   CASE WHEN candidate IS NULL THEN NULL WHEN json_extract(frozen,'$.input.stage')='episodes' THEN
    json_object('episodes',json('[]'),'episodeCount',json_array_length(candidate,'$.episodes')) ELSE json_object('shots',json('[]'),
    'completedSequenceIds',json_extract(candidate,'$.completedSequenceIds'),
    'adoptedShotIds',json_extract(candidate,'$.adoptedShotIds'),
    'shotCount',json_array_length(candidate,'$.shots')) END AS candidate
   FROM drama_runs WHERE project_id=? AND node_id=? ORDER BY rowid DESC LIMIT 30`)
   .all(projectId,nodeId).map(view);
 }};
}
