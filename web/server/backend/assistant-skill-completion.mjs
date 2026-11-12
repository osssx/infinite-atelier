/** Generic guard against presenting a draft plus instructions to manually run
 * an authorized Skill script as if the requested workflow had completed.
 * No Skill names, script paths or output schemas are hard-coded here.
 * This is a narrow repair signal, NOT a validator of arbitrary SKILL.md.
 */
export function assistantDeferredSkillScript({answer,request,authorizedEntries}){
 if(typeof answer!=="string"||typeof request!=="string"||
  !authorizedEntries.some(entry=>entry.scriptPaths?.length))return false;
 if(/^\s*(?:为什么|为何|解释|检查|调研|设计|如何|why|how\b|explain\b)/i.test(request))
  return false;
 // An answer about writing or debugging scripts is not necessarily a request
 // to execute one. We intervene only when the model itself leaves a concrete
 // required script execution step outstanding.
 let summary=answer;
 try{const obj=JSON.parse(answer);if(typeof obj?.answer==="string")summary=obj.answer}
 catch{/* plain-text answers are also supported */}
 // Match an outstanding action, not a coincidental mention of an
 // interpreter or a phrase such as "不需要手动执行脚本".
 const scriptStep=/(?:脚本|编译器|(?:python|node|bash|sh)(?:3)?\s|scripts\/|\.(?:py|mjs|js|sh|ps1)\b|script|compiler)/i;
 const pending=/(?:还(?:需|要)|仍(?:需|要)|尚需|需要|需用|必须|请(?:手动|自行)?|手动|自行|尚未|未(?:能)?(?:执行|运行|编译)|下一步|must|need(?:s)?(?:\s+to)?|manually|not\s+(?:yet\s+)?(?:run|executed))/i;
 return summary.split(/[。！？\n]+/u).some(sentence=>{
  if(!scriptStep.test(sentence)||!pending.test(sentence))return false;
  const negated=/(?:无需|不必|不需要|无需再|已经|已成功|已完成|成功执行|already (?:run|executed|compiled)|no need to|don't need to)/i.test(sentence);
  const nextStep=/(?:还(?:需|要)|仍(?:需|要)|尚需|下一步(?:需|要)|another script|need(?:s)? to run again)/i.test(sentence);
  return !negated||nextStep;
 });
}
export function requireSkillExecutionMessage(provider,body){
 const payload=JSON.parse(body);
 const guidance="SKILL WORKFLOW COMPLETION REQUIRED: Your previous answer deferred a script step"+
  " to the user instead of completing the authorized Skill procedure. If the"+
  " relevant SKILL.md requires a script, read listed references with read_skill_resource"+
  " and call run_skill_script with the exact authorized script_path, complete"+
  " input_files_json, args and output_files. Do NOT return a draft-only canvas"+
  " action or manual command as the final result. You may propose the script,"+
  " but execution requires explicit user approval and is never automatic."+
  " If the authorized Skill cannot be applied, explain the issue without"+
  " claiming completion.";
 if(provider==="google_gemini"){
  if(!payload.systemInstruction)payload.systemInstruction={parts:[]};
  payload.systemInstruction.parts??=[];
  payload.systemInstruction.parts.push({text:guidance});
 }else{
  payload.messages[0].content+="\n"+guidance;
 }
 return JSON.stringify(payload);
}
