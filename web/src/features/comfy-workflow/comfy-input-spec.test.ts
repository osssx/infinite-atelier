import {describe,expect,it} from "vitest";
import {inspectComfyInputSpec,MAX_COMFY_CHOICES} from "./comfy-input-spec";

describe("Comfy scalar enum descriptors",()=>{
 it("imports a 120-entry LoadImage enum with 84-character labels",()=>{
  const names=Array.from({length:120},(_,i)=>`${"m".repeat(78)}-${String(i).padStart(3,"0")}`);
  const descriptor=inspectComfyInputSpec([names,{tooltip:"model file"}]);
  expect(descriptor.valueKind).toBe("STRING");expect(descriptor.choices).toHaveLength(120);
  expect(descriptor.choices?.[0]).toEqual({label:names[0],value:names[0]});
 });
 it("accepts 2048 values, rejects larger snapshots and leaves the label limit unchanged",()=>{
  const max=Array.from({length:MAX_COMFY_CHOICES},(_,i)=>`entry-${i}`);
  expect(inspectComfyInputSpec([max,{}]).choices).toHaveLength(MAX_COMFY_CHOICES);
  const oversized=[...max,"entry-over-limit"];
  expect(inspectComfyInputSpec([oversized,{}]).options).toHaveLength(MAX_COMFY_CHOICES+1);
  expect(inspectComfyInputSpec([oversized,{}]).choices).toBeUndefined();
  expect(inspectComfyInputSpec([["x".repeat(91)],{}]).choices).toEqual([
   {label:"x".repeat(89)+"…",value:"x".repeat(91)}
  ]);
 });
 it("preserves numeric COMBO option types",()=>{
  expect(inspectComfyInputSpec(["COMBO",{options:[1,2,4]}])).toMatchObject({
   declaredType:"COMBO",valueKind:"INT",choices:[{label:"1",value:1},{label:"2",value:2},{label:"4",value:4}]
  });
  expect(inspectComfyInputSpec(["COMBO",{options:[0.25,0.5]}]).valueKind).toBe("FLOAT");
 });
});
