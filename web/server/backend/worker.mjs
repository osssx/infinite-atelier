/** Opt-in serial background pump. It never retries /prompt: only the
 * coordinator decides which durable queued/running/collecting jobs are due.
 */
export function createBackendWorker({coordinator,materializer,shotBatches,intervalMs=250,onError=()=>{}}={}){
 if(!coordinator||!materializer||!Number.isSafeInteger(intervalMs)||intervalMs<20)
  throw Error("invalid_backend_worker");
 let stopping=false,active=null,timer=null,wakes=0,lastError=null;
 let legacyMaterializationsRequeued=false;
 let shotWork=null;
 async function cycle(){
  if(stopping)return 0;
  if(active)return active;
  const run=(async()=>{
   try{
    // Revisit pre-upgrade blocked CAS results once after backend startup.
    // No provider/GPU work is scheduled by this local materialization step.
    if(!legacyMaterializationsRequeued){
     materializer.requeueLegacyBlocked?.();
     legacyMaterializationsRequeued=true;
    }
    const claimed=await coordinator.tick({maxClaims:16});
    const outputs=await materializer.runOnce({maxItems:32});
    if(shotBatches&&!shotWork&&!stopping)shotWork=shotBatches.tick().catch(error=>{
     try{onError(error?.code??"shot_batch_cycle_failed")}catch{}
    }).finally(()=>{shotWork=null});
    lastError=null;
    return claimed+outputs.length;
   }catch(error){
    lastError=error?.code??"worker_cycle_failed";
    try{onError(lastError)}catch{}
    return 0;
   }
  })();
  active=run;
  try{return await run}finally{if(active===run)active=null}
 }
 function start(){
  if(stopping||timer)throw Error("backend_worker_already_started");
  timer=setInterval(()=>{void cycle()},intervalMs);
  timer.unref?.();
  queueMicrotask(()=>{void cycle()});
  return this;
 }
 async function stop(){
  stopping=true;
  if(timer){clearInterval(timer);timer=null}
  shotBatches?.stop();
  if(active)await active;
  if(shotWork)await shotWork;
 }
 function status(){return {running:!!timer,active:!!active,lastError}}
 return {start,cycle,stop,status};
}
