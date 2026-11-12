/** Recover already-produced, fully inlined text artifacts when a follow-up
 * model cannot materialize them. No Skill names, artifact paths or JSON formats
 * are special-cased. Only additive canvas text nodes are allowed.
 */
export type AssistantSkillArtifact={
 path:string;mime?:string;byte_length?:number;content?:string;blob_id?:string
};
export type AssistantSkillRunResult={
 status:string;exit_code?:number|null;artifacts?:AssistantSkillArtifact[]
};
export function createSkillTextArtifactActions(run:AssistantSkillRunResult){
 if(run.status!=="completed"||run.exit_code!=null&&run.exit_code!==0)return [];
 const seen=new Set<string>();
 return (run.artifacts??[]).filter(artifact=>{
  if(!artifact||typeof artifact.path!=="string"||
   !/^text\/(?:plain|markdown|csv|json|xml)$/i.test(artifact.mime??"")||
   typeof artifact.content!=="string"||!artifact.content.trim()||
   artifact.content.length>16*1024||
   artifact.byte_length!==undefined&&new TextEncoder().encode(artifact.content).length!==artifact.byte_length||
   seen.has(artifact.path))return false;
  seen.add(artifact.path);
  return true;
 }).slice(0,4).map((artifact,index)=>({
  type:"create_node" as const,
  ref:"skill-output-"+index,
  nodeType:"text" as const,
  title:"Skill 产物 · "+artifact.path.split("/").at(-1)!.slice(0,66),
  // Keep the exact executed output. Never regenerate/reformat it with a model.
  content:artifact.content!
 }));
}
