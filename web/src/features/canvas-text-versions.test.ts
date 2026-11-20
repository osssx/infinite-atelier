import {describe,it,expect} from "vitest";
import {canRestoreNodeVersion,canSaveTextVersion,prepareDramaConfirmation,versionNodeContent,CANVAS_DOCUMENT_LIMIT_BYTES,documentFitsCanvasLimit,getTextRestoreDecision,isValidTextRestore,prepareTextRestore,withTextVersions} from "./canvas-text-versions";
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

describe("episode version rules",()=>{
 const draft=(title:string)=>JSON.stringify({episodes:[{id:"ep1",title,synopsis:"梗概",events:["事件"],sourceRefs:[],ending:"结尾"}]});
 const archive={id:"archived",createdAt:"2026-11-20T00:00:00Z"};
 const episode:CanvasNodeData={...node,type:"drama:episodes",metadata:{content:"历史正文",dramaDraft:draft("初稿")}};
 it("keeps the first confirmation and archives the previous one when the draft changes",()=>{
  const first=prepareDramaConfirmation(episode,archive);
  expect(first.metadata?.dramaConfirmed).toBe(draft("初稿"));
  expect(first.metadata?.textVersions).toEqual([]);
  const revised=withTextVersions(first,[],draft("新稿"));
  const second=prepareDramaConfirmation(revised,archive);
  expect(second.metadata?.dramaConfirmed).toBe(draft("新稿"));
  expect(second.metadata?.textVersions).toEqual([{...archive,content:draft("初稿"),source:"confirmation"}]);
  expect(prepareDramaConfirmation(second,{...archive,id:"another"})).toEqual(second);
 });
 it("restores only the draft, keeps archived versions across serialization and rejects invalid episode content",()=>{
  const confirmed=prepareDramaConfirmation(episode,archive);
  const newer=prepareDramaConfirmation(withTextVersions(confirmed,[],draft("新稿")),archive);
  const versions=newer.metadata!.textVersions!;
  const current=withTextVersions(newer,versions,draft("未备份草案"));
  const backup={id:"backup",createdAt:archive.createdAt,content:versionNodeContent(current),source:"restore-backup" as const};
  const prepared=prepareTextRestore(backup.content,versions[0],versions,"backup",backup)!;
  const restored:CanvasNodeData=JSON.parse(JSON.stringify(withTextVersions(current,prepared.versions,prepared.content)));
  expect(versionNodeContent(restored)).toBe(draft("初稿"));
  expect(restored.metadata?.dramaConfirmed).toBe(draft("新稿"));
  expect(restored.metadata?.content).toBe("历史正文");
  expect(restored.metadata?.textVersions?.[0]).toEqual(backup);
  expect(canRestoreNodeVersion(restored,"纯文本")).toBe(false);
 });
 it("blocks a full archive only if the previous confirmation needs a new record",()=>{
  const current=prepareDramaConfirmation(episode,archive);
  const full=Array.from({length:50},(_,index)=>({id:String(index),createdAt:"",content:draft(String(index)),source:"manual" as const}));
  const revised=withTextVersions(current,full,draft("新稿"));
  expect(()=>prepareDramaConfirmation(revised,archive)).toThrow("episode_history_full");
  expect(revised.metadata?.dramaConfirmed).toBe(draft("初稿"));
  const alreadySaved=withTextVersions(revised,[{...full[0],content:draft("初稿")},...full.slice(1)]);
  expect(prepareDramaConfirmation(alreadySaved,archive).metadata?.textVersions).toHaveLength(50);
 });
});

it("archives storyboard confirmations and restores a complete shot draft with links intact",()=>{
 const shot={id:"shot1",episodeId:"ep1",order:1,description:"旧画面",camera:"推镜",
  sceneId:"scene1",sceneVariantId:"night",characterVariantIds:["costume1"],propIds:["prop1"],
  keyPropIds:["prop1"],sourceRefs:["source1"]};
 const original=JSON.stringify({shots:[shot]});
 const updated=JSON.stringify({shots:[{...shot,description:"新画面"}]});
 const storyboard:CanvasNodeData={...node,type:"drama:storyboard",metadata:{dramaConfirmed:original,dramaDraft:updated}};
 const confirmed=prepareDramaConfirmation(storyboard,{id:"archived",createdAt:"now"});
 const versions=confirmed.metadata?.textVersions??[];
 expect(versions[0]?.content).toBe(original);
 expect(confirmed.metadata?.dramaStage).toBe("storyboard");
 expect(canRestoreNodeVersion(confirmed,original)).toBe(true);
 expect(canRestoreNodeVersion(confirmed,JSON.stringify({shots:[shot,shot]}))).toBe(false);
 const restored=withTextVersions(confirmed,versions,original);
 expect(JSON.parse(versionNodeContent(restored)).shots).toEqual([shot]);
 expect(restored.metadata?.dramaConfirmed).toBe(updated);
});
