import {describe,it,expect} from "vitest";
import {canSaveTextVersion,CANVAS_DOCUMENT_LIMIT_BYTES,documentFitsCanvasLimit,getTextRestoreDecision,isValidTextRestore,prepareTextRestore,withTextVersions} from "./canvas-text-versions";
import {CanvasNodeType,type CanvasNodeData} from "@/types/canvas";

const node:CanvasNodeData={id:"t",type:CanvasNodeType.Text,title:"Text",position:{x:0,y:0},width:100,height:100,metadata:{content:"body"}};
describe("text version rules",()=>{
 it("rejects blank text and duplicates of the latest version, but allows a new distinct version",()=>{
  expect(canSaveTextVersion("  ")).toBe(false);
  expect(canSaveTextVersion("same",[{id:"1",createdAt:"",content:"same",source:"manual"}])).toBe(false);
  expect(canSaveTextVersion("next",[{id:"1",createdAt:"",content:"same",source:"manual"}])).toBe(true);
 });
 it("caps versions at 50 and rejects blank restore targets",()=>{
  const versions=Array.from({length:50},(_,i)=>({id:String(i),createdAt:"",content:String(i),source:"manual" as const}));
  expect(canSaveTextVersion("next",versions)).toBe(false);
  expect(isValidTextRestore(" \n")).toBe(false);expect(isValidTextRestore("ok")).toBe(true);
 });
 it("preserves node metadata when recording versions and enforces the serialized document cap",()=>{
  const version={id:"v",createdAt:"now",content:"snapshot",source:"manual" as const};
  expect(withTextVersions(node,[version]).metadata?.content).toBe("body");
  expect(withTextVersions(node,[version]).metadata?.textVersions).toEqual([version]);
  expect(documentFitsCanvasLimit({value:"x"})).toBe(true);
  expect(documentFitsCanvasLimit({value:"x".repeat(CANVAS_DOCUMENT_LIMIT_BYTES)})).toBe(false);
 });
 it("chooses direct restore for blank/already-backed text and confirmation otherwise",()=>{
  const target={id:"t",createdAt:"",content:"target",source:"manual" as const};
  expect(getTextRestoreDecision("",target.content,[])).toBe("direct");
  expect(getTextRestoreDecision("saved",target.content,[{...target,content:"saved"}])).toBe("direct");
  expect(getTextRestoreDecision("unsaved",target.content,[])).toBe("confirm");
  const full=Array.from({length:50},(_,i)=>({...target,id:String(i),content:String(i)}));
  expect(getTextRestoreDecision("unsaved",target.content,full)).toBe("backup-unavailable");
  expect(prepareTextRestore("unsaved",target,full,"backup")).toBeNull();
  const overwrite=prepareTextRestore("unsaved",target,full,"overwrite");
  expect(overwrite?.content).toBe("target");expect(overwrite?.versions).toHaveLength(50);
 });
 it("backs up the exact current text and never treats blank restore targets as valid",()=>{
  const target={id:"t",createdAt:"",content:"target",source:"manual" as const};
  const backup={id:"b",createdAt:"now",content:"current",note:"auto",source:"restore-backup" as const};
  expect(prepareTextRestore("current",target,[],"backup",backup)).toEqual({content:"target",versions:[backup]});
  expect(prepareTextRestore("current",{...target,content:" "},[],"overwrite")).toBeNull();
  expect(prepareTextRestore("current",target,[],"backup",{...backup,content:"wrong"})).toBeNull();
 });
});
