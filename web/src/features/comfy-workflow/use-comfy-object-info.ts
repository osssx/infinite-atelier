import {useCallback,useEffect,useRef,useState} from "react";
import type {ComfyObjectInfo} from "./template-schema";
import {invalidateComfyObjectInfo,loadComfyObjectInfo} from "./comfy-object-info-client";

type SyncState={instanceId:string;info?:ComfyObjectInfo;loading:boolean;error:string};

export function useComfyObjectInfo(instanceId:string){
 const sequence=useRef(0);
 const [state,setState]=useState<SyncState>({instanceId,loading:false,error:""});
 const sync=useCallback(async(force=false,reset=false)=>{
  const current=++sequence.current;
  if(!instanceId){
   setState({instanceId,loading:false,error:""});
   return;
  }
  setState(previous=>({
   instanceId,loading:true,error:"",
   ...(reset||previous.instanceId!==instanceId?{}:{info:previous.info})
  }));
  try{
   const info=await loadComfyObjectInfo(instanceId,force);
   if(sequence.current===current)setState({instanceId,info,loading:false,error:""});
  }catch(error){
   if(sequence.current===current)setState(previous=>({
    instanceId,loading:false,
    ...(previous.instanceId===instanceId?{info:previous.info}:{}),
    error:error instanceof Error?error.message:String(error)
   }));
  }
 },[instanceId]);
 useEffect(()=>{
  if(instanceId)void sync(false,true);
  else{++sequence.current;setState({instanceId,loading:false,error:""});}
  const onChanged=()=>{
   invalidateComfyObjectInfo();
   if(instanceId)void sync(true,true);
  };
  if(typeof window!=="undefined")window.addEventListener("atelier:comfy-instances-changed",onChanged);
  return ()=>{
   ++sequence.current;
   if(typeof window!=="undefined")window.removeEventListener("atelier:comfy-instances-changed",onChanged);
  };
 },[instanceId,sync]);
 return {
  objectInfo:state.instanceId===instanceId?state.info:undefined,
  loading:state.instanceId===instanceId&&state.loading,
  error:state.instanceId===instanceId?state.error:"",
  refresh:()=>sync(true,true),
 };
}
