// The executor is media-agnostic. This is the sole registry of supported capture contracts.
const fail = (code) => { throw Object.assign(new Error(code), {code,status:422}); };
const definitions = {
    SaveImage:{kind:"image",socket:"IMAGE",input:"images",history:["images"],prefix:"image"},
    SaveVideo:{kind:"video",socket:"VIDEO",input:"video",history:["videos","images"],prefix:"video"},
    SaveAudio:{kind:"audio",socket:"AUDIO",input:"audio",history:["audio","audios","images"],prefix:"audio"},
    SaveText:{kind:"text",socket:"STRING",input:"text",history:["text","texts","strings","files"],prefix:"text"},
};
export const CAPTURE_ADAPTERS=Object.freeze(definitions);
const safeFile=(value)=>typeof value==="string" && value.length>0 && value.length<=180 && !/[\/\\\x00-\x1f]/.test(value) && value!=="." && value!=="..";
export function prepareCapture(graph, output, sourceId, nodePrefix, info) {
    const adapterId=output.capture?.adapterId;
    const adapter=definitions[adapterId];
    if(!adapter || adapter.kind!==output.capture.kind || adapter.socket!==output.valueKind)fail("capture_adapter_unsupported");
    const classInfo=info?.[adapterId];
    if(!classInfo || !classInfo.input?.required?.[adapter.input] && !classInfo.input?.optional?.[adapter.input])fail("capture_adapter_missing:"+adapterId);
    const source=output.outputBinding;
    const link=[sourceId,source.outputIndex];
    let sinkId=output.capture?.strategy==="inject-sink"?null:Object.keys(graph).find(id=>graph[id].class_type===adapterId &&
        Array.isArray(graph[id].inputs[adapter.input]) &&
        graph[id].inputs[adapter.input][0]===link[0] && graph[id].inputs[adapter.input][1]===link[1]);
    if(!sinkId) {
        if(output.capture?.strategy==="reuse-sink")fail("capture_reuse_sink_unavailable:"+output.id);
        sinkId=nodePrefix+"capture_"+output.id;
        if(graph[sinkId])fail("generated_node_collision");
        const inputs={[adapter.input]:link};
        for(const [key,schema] of Object.entries(classInfo.input.required??{})) {
            if(key===adapter.input)continue;
            if(key==="filename_prefix" || key==="prefix") inputs[key]="infinite_atelier";
            else if(Array.isArray(schema) && schema[1] && Object.hasOwn(schema[1],"default")) inputs[key]=schema[1].default;
            else fail("capture_sink_requires_configuration:"+adapterId+":"+key);
        }
        graph[sinkId]={class_type:adapterId,inputs};
    }
    return {workflowNodeId:nodePrefix.slice(2,-2),portId:output.id,kind:adapter.kind,valueKind:adapter.socket,
        source:{nodeId:sourceId,outputIndex:source.outputIndex},captureNodeId:sinkId,adapterId,adapterVersion:1,
        required:output.capture?.required!==false,selector:adapter.history.join("|")};
}
export function extractCapture(output,cap) {
    if(!output || typeof output!=="object")return [];
    const adapter=definitions[cap.adapterId];
    if(!adapter || adapter.kind!==cap.kind)fail("capture_adapter_unsupported");
    for(const key of adapter.history) {
        const values=output[key];
        if(values===undefined || values===null)continue;
        if(cap.kind==="text" && (typeof values==="string" || Array.isArray(values) && values.every(x=>typeof x==="string"))) {
            return (Array.isArray(values)?values:[values]).map((text,index)=>({type:"inline",text,key:key+":"+index+":"+text.length}));
        }
        const items=Array.isArray(values)?values:[values];
        if(cap.kind==="text" && items.every(x=>x && typeof x==="object" && typeof x.text==="string")) {
            return items.map((item,index)=>({type:"inline",text:item.text,key:key+":"+index+":"+item.text.length}));
        }
        if(items.every(x=>x && typeof x==="object" && safeFile(x.filename))) {
            return items.map((file,index)=>{
                const subfolder=file.subfolder??"";
                if(typeof subfolder!=="string" || !/^[\w./-]{0,120}$/.test(subfolder) ||
                    subfolder.split("/").includes("..") || !["output","temp"].includes(file.type))
                    fail("unsafe_output_filename");
                return {type:"file",filename:file.filename,subfolder,fileType:file.type,
                    key:JSON.stringify([file.filename,subfolder,file.type,index])};
            });
        }
        fail("capture_history_shape_invalid:"+cap.adapterId);
    }
    return [];
}
export function detectArtifactMime(kind,header,reported) {
    const b=Buffer.isBuffer(header)?header:Buffer.from(header);
    const ascii=(a,z)=>b.toString("ascii",a,z);
    let actual=null;
    if(kind==="image") {
        if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))actual="image/png";
        else if(b[0]===255 && b[1]===216 && b[2]===255)actual="image/jpeg";
        else if(ascii(0,4)==="RIFF" && ascii(8,12)==="WEBP")actual="image/webp";
    } else if(kind==="video") {
        if(ascii(4,8)==="ftyp")actual="video/mp4";
        else if(b.subarray(0,4).equals(Buffer.from([26,69,223,163])))
            actual=b.includes(Buffer.from("matroska")) || reported==="video/x-matroska"?"video/x-matroska":"video/webm";
    } else if(kind==="audio") {
        if(ascii(0,4)==="RIFF" && ascii(8,12)==="WAVE")actual="audio/wav";
        else if(ascii(0,4)==="fLaC")actual="audio/flac";
        else if(ascii(0,4)==="OggS")actual="audio/ogg";
        else if(ascii(0,3)==="ID3" || b[0]===255 && (b[1]&224)===224)actual="audio/mpeg";
    } else if(kind==="text") {
        actual="text/plain";
        new TextDecoder("utf-8",{fatal:true}).decode(b);
        if(b.includes(0))fail("invalid_text_content");
    }
    if(!actual)fail("invalid_media:"+kind);
    const declared=(reported||"").split(";")[0].toLowerCase();
    if(declared && declared!=="application/octet-stream" && declared!=="binary/octet-stream" &&
        declared!==actual && !(kind==="text" && declared==="text/plain"))fail("captured_mime_mismatch");
    return actual;
}
export const captureLimits=Object.freeze({image:40_000_000,video:2_000_000_000,audio:500_000_000,text:2_000_000});
