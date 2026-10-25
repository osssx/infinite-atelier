import {describe,it,expect} from "vitest";
import {createCanvasStatePersistence} from "./canvas-state-persistence";
import {CanvasApiError,type canvasApi} from "./canvas-api";
describe("independent Canvas state writes",()=>{
 it("serializes viewport PUTs; while first save is in-flight, later movement is not lost",async()=>{
  let release!:()=>void;
  const first=new Promise<void>(resolve=>{release=resolve});
  let started!:()=>void;
  const startedPromise=new Promise<void>(resolve=>{started=resolve});
  const puts:Array<{revision:number;x:number}>=[];
  let serverRevision=1;
  const api=(async(path:string,method="GET",payload?:any)=>{
   if(method==="GET"&&path.endsWith("/viewport"))return {revision:1,viewport:{x:0,y:0,k:1}};
   if(method==="GET")return {revision:1,sessions:[],activeChatId:null};
   const view=payload.viewport;
   if(method==="PUT"){
    puts.push({revision:payload.expectedRevision,x:view.x});
    if(puts.length===1){started();await first}
    if(payload.expectedRevision!==serverRevision)throw new CanvasApiError("viewport_revision_conflict",409);
    return {revision:++serverRevision,viewport:view};
   }
   throw Error("unexpected request");
  }) as typeof canvasApi;
  const errors:unknown[]=[];
  const queue=createCanvasStatePersistence(error=>errors.push(error),api);
  await queue.load("p");
  queue.updateViewport("p",{x:1,y:0,k:1});
  const flush=queue.flush("p");
  await startedPromise;
  queue.updateViewport("p",{x:77,y:-8,k:2});
  release();
  await flush;
  expect(puts).toEqual([{revision:1,x:1},{revision:2,x:77}]);
  expect(serverRevision).toBe(3);
  expect(queue.hasPending("p")).toBe(false);
  expect(errors.at(-1)).toBeNull();
  queue.discard("p");
 });
 it("retains dirty chat edits and reports stale revision instead of overwriting",async()=>{
  const api=(async(path:string,method="GET",payload?:any)=>{
   if(method==="GET"&&path.endsWith("/viewport"))return {revision:1,viewport:{x:0,y:0,k:1}};
   if(method==="GET")return {revision:1,sessions:[],activeChatId:null};
   if(method==="PUT")throw new CanvasApiError("chats_revision_conflict",409);
   throw Error("unexpected request");
  }) as typeof canvasApi;
  let error:unknown=null;
  const queue=createCanvasStatePersistence(e=>{error=e},api);
  await queue.load("p");
  queue.updateChats("p",[{id:"c",title:"One",createdAt:"today",updatedAt:"today",messages:[]}],"c");
  await expect(queue.flush("p")).rejects.toThrow("chats_revision_conflict");
  expect(queue.hasPending("p")).toBe(true);
  expect((error as Error).message).toBe("chats_revision_conflict");
  queue.discard("p");
 });
});
