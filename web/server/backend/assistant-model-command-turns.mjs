/** Legacy commands without a server-recorded turn binding cannot authorize draft reuse. */
export function assistantModelCommandTurns(db,taskId){
 const rows=db.prepare("SELECT payload_json FROM assistant_task_events WHERE task_id=? AND kind='model_command_started' ORDER BY seq DESC").all(taskId);
 const bindings=new Map();
 for(const row of rows){
  const value=JSON.parse(row.payload_json);
  if(typeof value.requestId!=="string"||bindings.has(value.requestId))continue;
  bindings.set(value.requestId,value);
 }
 return command=>{
  const binding=bindings.get(command.request_id);
  return binding?.requestDigest===command.payload_digest?binding.turnMessageId:undefined;
 };
}
