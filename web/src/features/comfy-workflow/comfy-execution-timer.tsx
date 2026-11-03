import {useEffect,useState} from "react";
import {Clock3} from "lucide-react";
import {useCanvasComfyExecution} from "./canvas-execution-visual";
import {isComfyRunActive} from "./run-status";

export function formatComfyElapsed(startedAt:number,now:number):string {
 const elapsed=Number.isFinite(startedAt)&&Number.isFinite(now)
  ?Math.max(0,Math.floor((now-startedAt)/1000)):0;
 const hours=Math.floor(elapsed/3600);
 const minutes=Math.floor((elapsed%3600)/60);
 const seconds=elapsed%60;
 return hours>0?`${hours}:${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`
  :`${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
}

/** Owns its one-second updates so the workflow media visual never rerenders per tick. */
export function ComfyExecutionTimer({nodeId,visible=true}:{nodeId:string;visible?:boolean}) {
 const execution=useCanvasComfyExecution(nodeId);
 const active=visible&&isComfyRunActive(execution?.status);
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{
  if(!active)return;
  setNow(Date.now());
  const interval=window.setInterval(()=>setNow(Date.now()),1000);
  return()=>window.clearInterval(interval);
 },[active,execution?.runId]);
 if(!active||execution?.startedAt===undefined)return null;
 const elapsed=formatComfyElapsed(execution.startedAt,now);
 return <div role="timer" aria-live="off" aria-label={`运行时间 ${elapsed}`} title={`运行时间 ${elapsed}`}
  className="pointer-events-none absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm">
  <Clock3 aria-hidden="true" className="size-3.5 shrink-0"/>
  <span className="tabular-nums">{elapsed}</span>
 </div>;
}
