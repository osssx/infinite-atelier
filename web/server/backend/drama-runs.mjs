import {createHash,randomUUID} from "node:crypto";
import {readAssetDraft,readEpisodeDraft,readStoryboardDraft} from "../canvas-text-content.mjs";
import {validateDramaPipelineSnapshot} from "./drama-pipeline.mjs";
import {writeTransaction,stableJson} from "./repository.mjs";
import {normalizeOpenAiCompatBaseUrl} from "./openai-compat-endpoints.mjs";
import {planDramaShotDiff,mergeDramaSelectedShots} from "./drama-run-diff.mjs";
import {normalizeEpisodeEvents} from "../drama-episode-links.mjs";
import {episodeCandidateRevision,validEpisodeCandidate,assertEpisodeCandidateRevision,editEpisodeCandidate,removeEpisodeCandidate} from "./drama-episode-candidate.mjs";
import {planEpisodeAdoption,selectEpisodeAdoption,validEpisodeAdoptionRecord} from "./drama-episode-adoption.mjs";

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
     (row.candidate!=null&&(!validEpisodeCandidate(row.candidate,row.frozen.input,row.episodeId)||
      !validEpisodeAdoptionRecord(row.candidate.adoption,row.candidate,row.frozen.baseline??[],row.state)||
      episodeCandidateRevision(row.candidate)>0&&!["ready","adopted","discarded"].includes(row.state)))))
   throw fail("archive_invalid_drama_runs",422);
  if(!episodeRun&&target?.type!=="drama:storyboard")throw fail("archive_invalid_drama_runs",422);
  if(!row||!validId(row.id)||seen.has(row.id)||!ids.has(row.nodeId)||!validId(row.episodeId)||
   !/^[a-f0-9]{64}$/.test(row.fingerprint)||!["interrupted","ready","failed","adopted","cancelled",...(episodeRun?["discarded"]:[])].includes(row.state)||
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
 const view=row=>{
  const candidate=row.candidate?JSON.parse(row.candidate):null;
  if(Array.isArray(candidate?.episodes)&&candidate.revision===undefined)candidate.revision=0;
  return {id:row.id,nodeId:row.node_id,episodeId:row.episode_id,status:row.state,candidate,error:row.error};
 };
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
     usedIds.add(id);return normalizeEpisodeEvents({...episode,id},existing??episode);
    });
    db.prepare("UPDATE drama_runs SET state='ready',candidate=? WHERE project_id=? AND id=? AND state='running'")
     .run(stableJson({episodes,revision:0}),projectId,requestId);
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
    const inspect=answer=>{
     const parsed=readStoryboardDraft(answer);
     if(!parsed?.shots.length)return {parsed:null,reason:"只返回合法 JSON 对象，shots 必须是非空数组，每镜包含 characterVariantIds、propIds、keyPropIds 数组。"};
     const errors=[];
     if(shotId&&parsed.shots.length!==1)errors.push({code:"shot_scope_count_invalid"});
     if(parsed.shots.some(shot=>shot.episodeId!==episodeId))
      errors.push({code:"shot_episode_mismatch",expectedEpisodeId:episodeId});
     if(parsed.shots.some(shot=>currentSequence&&shot.sequenceId!==currentSequence||
       shot.sequenceId!==undefined&&!frozen.input.episode.sequences?.some(sequence=>sequence.id===shot.sequenceId)))
      errors.push({code:"shot_sequence_mismatch",expectedSequenceId:currentSequence??null});
     errors.push(...validateDramaPipelineSnapshot({version:1,revision:1,stage:"storyboard",
      assets:frozen.input.assets,references:[],shots:parsed.shots}).errors);
     if(!errors.length)return {parsed};
     const permitted={
      characters:frozen.input.assets.filter(asset=>asset.kind==="character").flatMap(asset=>(asset.variants??[]).map(item=>item.id)),
      scenes:frozen.input.assets.filter(asset=>asset.kind==="scene").map(asset=>({
       id:asset.id,variantIds:(asset.variants??[]).map(item=>item.id)})),
      props:frozen.input.assets.filter(asset=>asset.kind==="prop").map(asset=>asset.id),
     };
     return {parsed:null,reason:"只修复以下不合法的镜头字段，不改变镜头叙事内容。错误："+JSON.stringify(errors.slice(0,24))+
      "。已确认合法资产 ID："+JSON.stringify(permitted)+
      "。禁止创造其他角色造型、场景或道具 ID；没有已确认道具时 propIds 和 keyPropIds 必须是空数组；episodeId 必须为 "+episodeId+
      (currentSequence?"；sequenceId 必须为 "+currentSequence:"")+
      "。保留已合法的镜头 ID、镜头顺序和文本；输出完整的 shots JSON 对象。"};
    };
    let checked=inspect(answer);
    if(!checked.parsed&&typeof answer==="string"&&answer.length<=32000){
     answer=await generate(frozen.config,input,baseline,controller.signal,{response:answer,reason:checked.reason});
     if(controller.signal.aborted)return get(projectId,requestId);
     checked=inspect(answer);
    }
    if(!checked.parsed)throw fail("drama_candidate_invalid",422);
    const existingIds=new Set(frozen.baseline.map(shot=>shot.id));
    const shots=checked.parsed.shots.map(shot=>{
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
  // Candidate-only writes intentionally do not update the project document,
  // canvas revision, confirmed versions or downstream dependencies.
  function episodeRow(projectId,id){
   const project=getProject(db,projectId),row=find(projectId,id);
   if(!row)throw fail("drama_run_not_found",404);
   const frozen=JSON.parse(row.frozen);
   if(frozen.input.stage!=="episodes"||!project.document.nodes.some(node=>node.id===row.node_id&&node.type==="drama:episodes"))
    throw fail("drama_episode_scope_invalid",422);
   return {row,frozen,candidate:row.candidate?JSON.parse(row.candidate):null};
  }
  function readEpisodeOptimizationScope(projectId,id,episodeId,expectedRevision){
   const {row,frozen,candidate}=episodeRow(projectId,id);
   if(row.state!=="ready"||!candidate)throw fail("drama_candidate_not_ready");
   assertEpisodeCandidateRevision(candidate,expectedRevision);
   const episode=candidate.episodes.find(item=>item.id===episodeId);
   if(!episode)throw fail("drama_episode_candidate_not_found",404);
   const index=candidate.episodes.findIndex(item=>item.id===episodeId);
   return {episode,input:frozen.input,neighbors:{previous:candidate.episodes[index-1],next:candidate.episodes[index+1]}};
  }
  function mutateEpisodeCandidate(projectId,id,episodeId,expectedRevision,mutate){
   return writeTransaction(db,()=>{
    const {row,frozen,candidate}=episodeRow(projectId,id);
    if(row.state!=="ready"||!candidate)throw fail("drama_candidate_not_ready");
    assertEpisodeCandidateRevision(candidate,expectedRevision);
    const next=mutate(candidate,episodeId);
    if(!validEpisodeCandidate(next,frozen.input,row.episode_id))throw fail("drama_candidate_edit_invalid",422);
    if(next!==candidate)db.prepare("UPDATE drama_runs SET candidate=? WHERE project_id=? AND id=? AND state='ready'")
     .run(stableJson(next),projectId,id);
    return get(projectId,id);
   });
  }
  function patchEpisode(projectId,id,episodeId,{expectedRevision,changes,wholeEpisode=false}={}){
   return mutateEpisodeCandidate(projectId,id,episodeId,expectedRevision,(candidate,entryId)=>editEpisodeCandidate(candidate,entryId,changes,wholeEpisode));
  }
  function deleteEpisode(projectId,id,episodeId,expectedRevision){
   return mutateEpisodeCandidate(projectId,id,episodeId,expectedRevision,removeEpisodeCandidate);
  }
  function discard(projectId,id,expectedRevision){
   return writeTransaction(db,()=>{
    const {row,candidate}=episodeRow(projectId,id);
    if(row.state==="discarded")return get(projectId,id);
    if(!["ready","failed","interrupted","cancelled"].includes(row.state)||controllers.has(runKey(projectId,id)))
     throw fail("drama_candidate_not_discardable");
    assertEpisodeCandidateRevision(candidate,expectedRevision);
    // Retain a tombstone (and prior candidate for archive integrity), so the
    // original request ID cannot regenerate after an explicit discard.
    db.prepare("UPDATE drama_runs SET state='discarded' WHERE project_id=? AND id=?").run(projectId,id);
    return get(projectId,id);
   });
  }
  function episodeAdoptionPlan(project,row,frozen,candidate,gathered){
   const {input,baseline,parsed,revisions}=gathered;
   return planEpisodeAdoption({document:project.document,nodeId:row.node_id,scope:row.episode_id,current:parsed.episodes,
    baseline:frozen.baseline,candidate,paragraphs:input.paragraphs,sourceChanged:digest(input)!==digest(frozen.input)||
    Array.isArray(frozen.revisions)&&digest(revisions)!==digest(frozen.revisions),inputFence:{input,revisions,baseline}});
  }
  function preview(projectId,id){
   const project=getProject(db,projectId),row=find(projectId,id);
   if(!row)throw fail("drama_run_not_found",404);
   const frozen=JSON.parse(row.frozen),candidate=row.candidate?JSON.parse(row.candidate):null;
   if(frozen.input.stage==="episodes"){
    if(!candidate?.episodes||row.state!=="ready")throw fail("drama_candidate_not_ready");
    const gathered=gather(project.document,row.node_id,row.episode_id,frozen.input.scope);
    const {full,...review}=episodeAdoptionPlan(project,row,frozen,candidate,gathered);
    return {runId:id,status:row.state,stage:"episodes",...review};
   }
   if(!candidate?.shots||row.state==="running")throw fail("drama_candidate_not_ready");
   const {input,baseline}=gather(project.document,row.node_id,row.episode_id,frozen.input.scope);
   const diff=planDramaShotDiff({baseline:frozen.baseline,current:baseline,candidate:candidate.shots,
    adoptedShotIds:candidate.adoptedShotIds,adoptedRemovedShotIds:candidate.adoptedRemovedShotIds});
   const sourceChanged=digest(input)!==digest(frozen.input);
   return {runId:id,status:row.state,sourceChanged,...diff,
    fullAdoptBlocked:sourceChanged||diff.fullAdoptBlocked};
  }
  function adopt(projectId,id,shotIds,expectedRevision,episodeIds,reviewToken){
   return writeTransaction(db,()=>{
    const project=getProject(db,projectId),row=find(projectId,id);
    if(!row)throw fail("drama_run_not_found",404);
    if(row.state==="adopted"){
     if(episodeIds!==undefined||reviewToken!==undefined){
      const saved=JSON.parse(row.candidate??"null"),record=saved?.adoption;
      if(!record||reviewToken!==record.reviewToken||expectedRevision!==episodeCandidateRevision(saved)||
       record.mode!==(episodeIds===undefined?"all":"selected")||
       episodeIds!==undefined&&digest([...episodeIds].sort())!==digest([...record.episodeIds].sort()))
       throw fail("drama_episode_review_conflict");
     }
     return project;
    }
    if(row.state!=="ready")throw fail("drama_candidate_not_ready");
    const frozen=JSON.parse(row.frozen);
    const gathered=gather(project.document,row.node_id,row.episode_id,frozen.input.scope);
    const {node,input,baseline,parsed,contains}=gathered;
    if(digest(input)!==digest(frozen.input))throw fail("drama_candidate_conflict");
    const candidate=JSON.parse(row.candidate);
    if(frozen.input.stage==="episodes"){
     if(shotIds)throw fail("drama_episode_scope_invalid",422);
     // Old clients may adopt untouched candidates, but must not unknowingly
     // adopt a changed candidate they have never reviewed.
     if(expectedRevision!==undefined||episodeCandidateRevision(candidate)>0)
      assertEpisodeCandidateRevision(candidate,expectedRevision);
     if(digest(baseline)!==digest(frozen.baseline))throw fail("drama_candidate_conflict");
     const preserved=parsed.episodes.filter(episode=>!contains(episode));
     if(candidate.episodes.some(episode=>preserved.some(item=>item.id===episode.id)))throw fail("drama_candidate_conflict");
     const plan=episodeAdoptionPlan(project,row,frozen,candidate,gathered);
     if(episodeIds!==undefined||reviewToken!==undefined){
      if(expectedRevision===undefined||reviewToken!==plan.reviewToken)throw fail("drama_episode_review_conflict");
     }
     const episodes=selectEpisodeAdoption(plan,parsed.episodes,episodeIds);
     const reviewedIds=episodeIds??plan.items.filter(item=>item.changed&&!item.blocked||item.reordered).map(item=>item.id);
     const adoption={mode:episodeIds===undefined?"all":"selected",episodeIds:reviewedIds,...(reviewToken?{reviewToken}:{}),
      appliedEpisodeIds:reviewedIds.filter(id=>plan.items.some(item=>item.id===id&&(item.changed||item.reordered)))};
     node.metadata={...node.metadata,dramaDraft:stableJson({...parsed,episodes})};
     const revision=project.revision+1;
     db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?").run(validateDocument(project.document),revision,projectId);
     db.prepare("UPDATE drama_runs SET state='adopted',candidate=? WHERE project_id=? AND id=?").run(stableJson({...candidate,adoption}),projectId,id);
     db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
      .run(projectId,node.id,`drama-run:${id}`,row.fingerprint,revision);
     emitEvent(db,{id:projectId,revision,kind:"updated"});
     return {...project,revision};
    }
    if(episodeIds!==undefined||reviewToken!==undefined)throw fail("drama_episode_scope_invalid",422);
    const allShots=candidate.shots;
    const diff=planDramaShotDiff({baseline:frozen.baseline,current:baseline,candidate:allShots,
     adoptedShotIds:candidate.adoptedShotIds,adoptedRemovedShotIds:candidate.adoptedRemovedShotIds});
    const selected=shotIds?new Set(shotIds):null;
    const allowed=new Set(diff.items.map(item=>item.id));
    if(selected&&(!selected.size||[...selected].some(id=>!allowed.has(id))))
     throw fail("drama_candidate_conflict");
    if(!selected&&diff.fullAdoptBlocked||diff.items.some(item=>(!selected||selected.has(item.id))&&item.conflict))
     throw fail("drama_candidate_conflict");
    const operations=diff.items.filter(item=>(!selected||selected.has(item.id))&&item.changed&&!item.adopted);
    if(!operations.length){
     // A run can be completed after every change was selectively adopted.
     if(!selected)db.prepare("UPDATE drama_runs SET state='adopted' WHERE project_id=? AND id=? AND state='ready'")
      .run(projectId,id);
     return project;
    }
    const changedIds=new Set(operations.map(item=>item.id));
    const shots=allShots.filter(shot=>changedIds.has(shot.id));
    if(shots.some(shot=>shot.episodeId!==row.episode_id||
     (input.scope?.sequenceId&&shot.sequenceId!==input.scope.sequenceId)||
     (input.scope?.shotId&&shot.id!==input.scope.shotId)))throw fail("drama_candidate_conflict");
    const preserved=parsed.shots.filter(shot=>!changedIds.has(shot.id));
    if(shots.some(shot=>preserved.some(existing=>existing.id===shot.id)))
     throw fail("drama_candidate_conflict");
    node.metadata.dramaDraft=stableJson({...parsed,shots:mergeDramaSelectedShots(parsed.shots,changedIds,allShots)});
    const revision=project.revision+1;
    db.prepare("UPDATE projects SET document_json=?,revision=? WHERE id=?")
     .run(validateDocument(project.document),revision,projectId);
    db.prepare("INSERT INTO canvas_text_version_operations VALUES(?,?,?,?,?)")
     .run(projectId,node.id,`drama-run:${id}:${digest(shotIds??[])}`,row.fingerprint,revision);
    const adopted=new Set(candidate.adoptedShotIds??[]);
    const removed=new Set(candidate.adoptedRemovedShotIds??[]);
    for(const item of operations){
     if(item.kind==="deleted")removed.add(item.id);
     else adopted.add(item.id);
    }
    db.prepare("UPDATE drama_runs SET state=?,candidate=? WHERE project_id=? AND id=?")
     .run(selected?"ready":"adopted",stableJson({...candidate,adoptedShotIds:[...adopted],
      adoptedRemovedShotIds:[...removed]}),projectId,id);
    emitEvent(db,{id:projectId,revision,kind:"updated"});
    return {...project,revision};
   });
  }
  function cancel(projectId,id){  get(projectId,id);
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
 return {submit,get,preview,adopt,cancel,retry,patchEpisode,deleteEpisode,discard,readEpisodeOptimizationScope,list(projectId,nodeId){
  getProject(db,projectId);
  return db.prepare(`SELECT id,node_id,episode_id,state,error,
   CASE WHEN candidate IS NULL THEN NULL WHEN json_extract(frozen,'$.input.stage')='episodes' THEN
    json_object('episodes',json('[]'),'episodeCount',json_array_length(candidate,'$.episodes'),
    'revision',COALESCE(json_extract(candidate,'$.revision'),0),'manualChanges',json_extract(candidate,'$.manualChanges'),'adoption',json_extract(candidate,'$.adoption')) ELSE json_object('shots',json('[]'),
    'completedSequenceIds',json_extract(candidate,'$.completedSequenceIds'),
    'adoptedShotIds',json_extract(candidate,'$.adoptedShotIds'),
    'shotCount',json_array_length(candidate,'$.shots')) END AS candidate
   FROM drama_runs WHERE project_id=? AND node_id=? AND state<>'discarded' ORDER BY rowid DESC LIMIT 30`)
   .all(projectId,nodeId).map(view);
 }};
}
