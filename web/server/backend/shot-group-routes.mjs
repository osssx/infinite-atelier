
export function registerShotGroupRoutes(app,{shotBatches}){
 if(!shotBatches)return;
 const path="/api/v1/projects/:id/shot-batches";
 app.get(path,req=>shotBatches.list(req.params.id));
 app.get(path+"/capabilities",async()=>({tailFrames:await shotBatches.available()}));
 app.post(path+"/inspect",async req=>{
  try{return await shotBatches.inspect(req.params.id,req.body);}
  catch(error){return {ready:false,reason:error.code??"shot_preflight_failed"};}
 });
 app.post(path,(req,reply)=>reply.code(201).send(shotBatches.create(req.params.id,req.body)));
 app.post(path+"/:batchId/actions",req=>shotBatches.action(req.params.id,req.params.batchId,req.body));
}

