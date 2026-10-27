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
 it("requires explicit media connections even if template includes sample filenames",()=>{
  expect(missingComfyMediaInputs(template,"wf",[]).map(p=>p.id)).toEqual(["first_frame"]);
  expect(missingComfyMediaInputs(template,"wf",[{
   id:"another",fromNodeId:"image",fromPortId:"image",toNodeId:"unrelated",toPortId:"first_frame"
  }]).map(p=>p.id)).toEqual(["first_frame"]);
  expect(missingComfyMediaInputs(template,"wf",[{
   id:"edge",fromNodeId:"image",fromPortId:"image",toNodeId:"wf",toPortId:"first_frame"
  }])).toEqual([]);
 });
});
