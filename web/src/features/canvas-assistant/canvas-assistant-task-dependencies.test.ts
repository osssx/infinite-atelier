import {describe,expect,it} from "vitest";
import {confirmedAssistantTaskDependencies} from "./canvas-assistant-task-dependencies";
const make=(status:string,steps:any[]=[])=>({status,activePlanVersion:2,steps});
const step=(id:string,ordinal:number,kind:string,status="succeeded",
 receiptTrust="server_committed",dependsOn:string[]=[])=>
 ({id,planVersion:2,ordinal,kind,status,receiptTrust,dependsOn});
describe("P3 trusted sequential Task dependencies",()=>{
 it("starts with no dependency and chains the last trusted canvas Step",()=>{
  expect(confirmedAssistantTaskDependencies(make("planning"))).toEqual([]);
  expect(confirmedAssistantTaskDependencies(make("ready",[
   step("first",0,"canvas_mutation"),step("second",1,"canvas_mutation")
  ]))).toEqual(["second"]);
 });
 it("a generated artifact is not enough: materialization must be verified",()=>{
  expect(()=>confirmedAssistantTaskDependencies(make("ready",[
   step("job",0,"model_job")
  ]))).toThrow("assistant_task_materialization_required");
  expect(confirmedAssistantTaskDependencies(make("ready",[
   step("job",0,"model_job"),step("materialize",1,"materialize","succeeded",
    "server_committed",["job"])
  ]))).toEqual(["materialize"]);
 });
 it("rejects all unapproved, failed, waiting and ambiguous steps",()=>{
  for(const status of ["waiting_approval","ready","running","waiting_external",
   "needs_reconcile","failed","blocked"]){
   expect(()=>confirmedAssistantTaskDependencies(make("waiting_external",[
    step("old",0,"canvas_mutation"),step("pending",1,"comfy_workflow",status,"none")
   ]))).toThrow("assistant_task_step_unverified");
  }
  for(const status of ["cancelled","completed","failed","blocked","cancelling","needs_reconcile"])
   expect(()=>confirmedAssistantTaskDependencies(make(status))).toThrow("assistant_task_not_editable");
 });
 it("does not chain superseded plan Steps",()=>{
  expect(confirmedAssistantTaskDependencies(make("ready",[
   {...step("old",0,"model_job"),planVersion:1},
   step("current",0,"canvas_mutation")
  ]))).toEqual(["current"]);
 });
});
