import {describe,expect,it} from "vitest";
import {missingComfyMediaInputs} from "./run-types";
import type {ComfyWorkflowTemplate} from "./template-schema";

const template:ComfyWorkflowTemplate={
 id:"minimax",revision:"a".repeat(64),name:"Video I2V",
 apiGraph:{"114":{class_type:"LoadImage",inputs:{image:"example.png"}}},
 requirements:{classTypes:["LoadImage"]},
 ports:[
  {id:"first_frame",label:"首帧图片",direction:"target",valueKind:"IMAGE",required:true,
   inputBinding:{mode:"media-file",mediaKind:"IMAGE",targets:[{nodeId:"114",inputName:"image"}]},
   absentPolicy:{mode:"keep-template"}},
  {id:"video",label:"视频",direction:"source",valueKind:"VIDEO",
   outputBinding:{nodeId:"114",outputIndex:0},capture:{kind:"video",adapterId:"SaveVideo"}}
 ]
};
describe("SQLite Comfy media input preflight",()=>{
 it("only requires media inputs explicitly marked required, ignoring sample filenames",()=>{
  expect(missingComfyMediaInputs(template,"wf",[]).map(p=>p.id)).toEqual(["first_frame"]);
  expect(missingComfyMediaInputs(template,"wf",[{
   id:"another",fromNodeId:"image",fromPortId:"image",toNodeId:"unrelated",toPortId:"first_frame"
  }]).map(p=>p.id)).toEqual(["first_frame"]);
  expect(missingComfyMediaInputs(template,"wf",[{
   id:"edge",fromNodeId:"image",fromPortId:"image",toNodeId:"wf",toPortId:"first_frame"
  }])).toEqual([]);
 });
 it("optional first frame with auto-prune does not block an unconnected workflow",()=>{
  const optional=structuredClone(template);
  optional.ports[0].required=false;
  optional.ports[0].absentPolicy={mode:"auto-prune"};
  expect(missingComfyMediaInputs(optional,"wf",[])).toEqual([]);
 });
 it("required video/audio/socket media ports are checked generically",()=>{
  const copy=structuredClone(template);
  copy.ports=[
   {id:"clip",label:"Clip",direction:"target",required:true,valueKind:"VIDEO",
    inputBinding:{mode:"media-file",mediaKind:"VIDEO",targets:[{nodeId:"114",inputName:"image"}]}},
   {id:"voice",label:"Voice",direction:"target",required:false,valueKind:"AUDIO",
    inputBinding:{mode:"media-file",mediaKind:"AUDIO",targets:[{nodeId:"114",inputName:"image"}]}},
   {id:"frame",label:"Frame",direction:"target",required:true,valueKind:"IMAGE",
    inputBinding:{mode:"socket",replaceInternalLink:true,targets:[{nodeId:"114",inputName:"image"}]}}
  ];
  expect(missingComfyMediaInputs(copy,"wf",[]).map(p=>p.id)).toEqual(["clip","frame"]);
 });
});
