/** Opt-in serial background pump. It never retries /prompt: only the
 * coordinator decides which durable queued/running/collecting jobs are due.
 */
export function createBackendWorker({coordinator,materializer,intervalMs=250,onError=()=>{}}={}){
 if(!coordinator||!materializer||!Number.isSafeInteger(intervalMs)||intervalMs<20)
  throw Error("invalid_backend_worker");
 let stopping=false,active=null,timer=null,wakes=0,lastError=null;
 async function cycle(){
  if(stopping)return 0;
  if(active)return active;
  const run=(async()=>{
   try{
    const claimed=await coordinator.tick({maxClaims:16});
    const outputs=await materializer.runOnce({maxItems:32});
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
  if(active)await active;
 }
 function status(){return {running:!!timer,active:!!active,lastError}}
 return {start,cycle,stop,status};
}
