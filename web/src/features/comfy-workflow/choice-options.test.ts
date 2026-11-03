import {describe,expect,it} from "vitest";
import {autoFillComfyPortChoices,formatComfyChoiceLines,inferComfyChoicesForPort,parseComfyChoiceLines} from "./choice-options";
import type {ComfyApiGraph,ComfyObjectInfo,ComfyTemplatePort} from "./template-schema";

describe("editable Comfy literal candidate arrays",()=>{
 it("imports LoRA catalogs with long paths and roundtrips complete execution values",()=>{
  const longName="minimaxh3\\minimax_h3_4step_lora_flashgen_v1.0_768p_fl2va_pruned_avg_rank_13_bf16.safetensors";
  const graph:ComfyApiGraph={"105_121":{class_type:"LoraLoaderModelOnly",inputs:{lora_name:longName}}};
  const port:ComfyTemplatePort={id:"lora",label:"LoRA",direction:"target",valueKind:"STRING",
   inputBinding:{mode:"literal",targets:[{nodeId:"105_121",inputName:"lora_name"}]}};
  for(const spec of [[[longName,"short.safetensors"],{}],["COMBO",{options:[longName,"short.safetensors"]}]]){
   const info:ComfyObjectInfo={LoraLoaderModelOnly:{input:{required:{lora_name:spec}}}};
   const result=autoFillComfyPortChoices([port],graph,info);
   expect(result.blocked.size).toBe(0);
   const choices=result.ports[0].choices!;
   expect(choices).toHaveLength(2);
   expect(choices[0].label).toHaveLength(90);
   expect(choices[0].value).toBe(longName);
   expect(parseComfyChoiceLines("STRING",formatComfyChoiceLines(choices))).toEqual({ok:true,choices});
  }
 });
 it("parses labels separately from native STRING values (including extra pipes)",()=>{
  expect(parseComfyChoiceLines("STRING","标准 | standard\n快速 | fast\n复杂 | a|b")).toEqual({
   ok:true,choices:[
    {label:"标准",value:"standard"},
    {label:"快速",value:"fast"},
    {label:"复杂",value:"a|b"},
   ]
  });
  const source=[{label:"低",value:"0.25"},{label:"高",value:"0.75"}];
  expect(parseComfyChoiceLines("STRING",formatComfyChoiceLines(source))).toEqual({ok:true,choices:source});
 });
 it("uses the entire line as both display label and actual value when no pipe exists",()=>{
  expect(parseComfyChoiceLines("STRING","  cinematic  \n写实 | realistic\n动漫")).toEqual({
   ok:true,choices:[
    {label:"cinematic",value:"cinematic"},
    {label:"写实",value:"realistic"},
    {label:"动漫",value:"动漫"}
   ]
  });
  expect(parseComfyChoiceLines("INT"," 8 \n标准 | 16\n32")).toEqual({
   ok:true,choices:[
    {label:"8",value:8},
    {label:"标准",value:16},
    {label:"32",value:32}
   ]
  });
  expect(parseComfyChoiceLines("FLOAT","0.25\n中 | 0.5\n-1.25e-3")).toEqual({
   ok:true,choices:[
    {label:"0.25",value:0.25},
    {label:"中",value:0.5},
    {label:"-1.25e-3",value:-0.00125}
   ]
  });
 });
 it("formats equal label/value choices without a separator and roundtrips typed numbers",()=>{
  const options=[{label:"8",value:8},{label:"标准",value:16},{label:"32",value:32}];
  expect(formatComfyChoiceLines(options)).toBe("8\n标准 | 16\n32");
  expect(parseComfyChoiceLines("INT",formatComfyChoiceLines(options))).toEqual({ok:true,choices:options});
  const texts=[{label:"cinematic",value:"cinematic"},{label:"写实",value:"realistic"}];
  expect(formatComfyChoiceLines(texts)).toBe("cinematic\n写实 | realistic");
  expect(parseComfyChoiceLines("STRING",formatComfyChoiceLines(texts))).toEqual({ok:true,choices:texts});
 });
 it("supports INT, FLOAT and negative/safe numeric values without string coercion",()=>{
  expect(parseComfyChoiceLines("INT","低 | -2\n高 | 10")).toEqual({ok:true,choices:[
   {label:"低",value:-2},{label:"高",value:10}
  ]});
  expect(parseComfyChoiceLines("FLOAT","低 | 0.125\n高 | 2.5e-3")).toEqual({ok:true,choices:[
   {label:"低",value:0.125},{label:"高",value:0.0025}
  ]});
  expect(parseComfyChoiceLines("INT","坏 | 1.2").ok).toBe(false);
  expect(parseComfyChoiceLines("INT","坏 | 9007199254740992").ok).toBe(false);
  expect(parseComfyChoiceLines("FLOAT","坏 | NaN").ok).toBe(false);
  expect(parseComfyChoiceLines("FLOAT","坏 | Infinity").ok).toBe(false);
 });
 it("validates line syntax, option limits and distinct actual values",()=>{
  for(const s of ["","abc","1.5"," | 1","A | 1\nB | 1","1\n另一个 | 1",Array.from({length:2049},(_,i)=>"选项"+i+" | "+i).join("\n")]){
   expect(parseComfyChoiceLines("INT",s).ok).toBe(false);
  }
 });
 it("fills missing existing-port enums after object_info arrives and remains idempotent",()=>{
  const graph:ComfyApiGraph={"10":{class_type:"LoadImage",inputs:{image:"sample.png"}}};
  const port:ComfyTemplatePort={id:"image",label:"Image",direction:"target",valueKind:"STRING",
   inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"image"}]}};
  const before=autoFillComfyPortChoices([port],graph,{});
  expect(before.ports).toBeTruthy();expect(before.ports[0].choices).toBeUndefined();
  const info:ComfyObjectInfo={LoadImage:{input:{required:{image:[["sample.png","second.png"],{}]}}}};
  const after=autoFillComfyPortChoices(before.ports,graph,info);
  expect(after.ports[0].choices).toEqual([{label:"sample.png",value:"sample.png"},{label:"second.png",value:"second.png"}]);
  const again=autoFillComfyPortChoices(after.ports,graph,info,new Set(),new Set(["image"]));
  expect(again.ports).toBe(after.ports);
 });
 it("intersects enum mappings, ignores unconstrained scalar strings, and rejects incompatible mappings",()=>{
  const graph:ComfyApiGraph={
   "10":{class_type:"A",inputs:{mode:"fast"}},
   "11":{class_type:"B",inputs:{mode:"fast"}},
   "12":{class_type:"Plain",inputs:{text:"fast"}},
  };
  const port:ComfyTemplatePort={id:"mode",label:"Mode",direction:"target",valueKind:"STRING",defaultValue:"fast",
   inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"mode"},{nodeId:"11",inputName:"mode"},{nodeId:"12",inputName:"text"}]}};
  const info:ComfyObjectInfo={
   A:{input:{required:{mode:[["fast","quality"],{}]}}},
   B:{input:{required:{mode:[["fast","fastest"],{}]}}},
   Plain:{input:{required:{text:["STRING",{}]}}},
  };
  expect(inferComfyChoicesForPort(port,graph,info)).toMatchObject({kind:"choices",choices:[{value:"fast"}]});
  info.B={input:{required:{mode:[["quality","fastest"],{}]}}};
  expect(inferComfyChoicesForPort(port,graph,info).kind).toBe("default-outside");
  info.B={input:{required:{mode:["INT",{}]}}};
  expect(inferComfyChoicesForPort(port,graph,info).kind).toBe("incompatible");
 });
 it("does not overwrite manual choices or refill a user-suppressed port",()=>{
  const graph:ComfyApiGraph={"10":{class_type:"A",inputs:{mode:"fast"}}};
  const info:ComfyObjectInfo={A:{input:{required:{mode:[["fast","quality"],{}]}}}};
  const port:ComfyTemplatePort={id:"mode",label:"Mode",direction:"target",valueKind:"STRING",
   choices:[{label:"Custom",value:"custom"}],inputBinding:{mode:"literal",targets:[{nodeId:"10",inputName:"mode"}]}};
  expect(autoFillComfyPortChoices([port],graph,info).ports).toBeTruthy();
  expect(autoFillComfyPortChoices([port],graph,info).ports[0].choices).toEqual(port.choices);
  const without:ComfyTemplatePort={...port,choices:undefined};
  expect(autoFillComfyPortChoices([without],graph,info,new Set(["mode"])).ports[0].choices).toBeUndefined();
 });
 it("imports the full enum when an existing scalar is stale without changing saved values",()=>{
  const choices=Array.from({length:120},(_,i)=>`catalog-${i}`);
  const graph:ComfyApiGraph={"130":{class_type:"LoadImage",inputs:{image:"removed-from-comfy.png"}}};
  const info:ComfyObjectInfo={LoadImage:{input:{required:{image:[choices,{}]}}}};
  const port:ComfyTemplatePort={id:"last_frame",label:"Last frame",direction:"target",valueKind:"STRING",
   defaultValue:"removed-from-comfy.png",inputBinding:{mode:"literal",targets:[{nodeId:"130",inputName:"image"}]}};
  const result=autoFillComfyPortChoices([port],graph,info);
  expect(result.ports[0].choices).toHaveLength(120);
  expect(result.blocked.get(port.id)).toMatchObject({kind:"default-outside"});
  expect(graph["130"].inputs.image).toBe("removed-from-comfy.png");
  expect(result.ports[0].defaultValue).toBe("removed-from-comfy.png");
 });
});
