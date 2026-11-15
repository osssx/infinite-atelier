/** P4.6c read-only ComfyUI protocol preflight.
 * Uses GET only. Does not print prompt IDs, workflows, markers or outputs.
 */
const value=process.env.ATELIER_P46C_COMFY_URL??"http://127.0.0.1:8188";
const url=new URL(value);
if(url.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(url.hostname)||
   !url.port||url.pathname!=="/"||url.username||url.password||url.search||url.hash)
 throw Error("p46c_preflight_requires_exact_loopback_origin");
async function get(path){
 const response=await fetch(url.origin+path,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error("p46c_preflight_http_"+response.status+"_"+path.split("?")[0]);
 return response.json();
}
const stats=await get("/system_stats");
const queue=await get("/queue");
const history=await get("/history?max_items=1");
const rows=history&&typeof history==="object"&&!Array.isArray(history)?Object.values(history):[];
const tuple=rows.length?rows[0]?.prompt:null;
const native=Array.isArray(tuple)&&tuple.length>=5&&typeof tuple[1]==="string"&&
 typeof tuple[2]==="object"&&tuple[2]!==null&&
 typeof tuple[3]==="object"&&tuple[3]!==null;
const report={
 version:stats?.system?.comfyui_version??"unknown",
 queued:Array.isArray(queue?.queue_pending)?queue.queue_pending.length:null,
 running:Array.isArray(queue?.queue_running)?queue.queue_running.length:null,
 historyEntriesInspected:rows.length,
 nativeFiveFieldTuple:rows.length?native:null,
 submitMarkerFieldPresent:native?Object.hasOwn(tuple[3],"infinite_atelier_submit_marker"):null,
 checkedOnly:["GET /system_stats","GET /queue","GET /history?max_items=1"]
};
if(rows.length&&!native)throw Error("p46c_unexpected_history_tuple_shape");
console.log("P46C_COMFY_READONLY_PREFLIGHT_PASS "+JSON.stringify(report));
