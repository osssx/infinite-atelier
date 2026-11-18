import {afterEach,expect,it,vi} from "vitest";
import {canvasApiStream,canvasSession} from "./canvas-api";

afterEach(()=>vi.unstubAllGlobals());

it("replays from the last rendered event after the POST stream ends early",async()=>{
 const path="/api/v1/projects/p/assistant/chat";
 const fetcher=vi.fn()
  .mockResolvedValueOnce(Response.json({csrfToken:"csrf"}))
  .mockResolvedValueOnce(new Response('data: {"seq":1,"type":"delta","text":"甲"}\n\n'))
  .mockResolvedValueOnce(Response.json({events:[
   {seq:2,type:"delta",text:"乙"},
   {seq:3,type:"done",result:{answer:"甲乙"}}
  ],terminal:true}));
 vi.stubGlobal("fetch",fetcher);
 await canvasSession(true);
 const onDelta=vi.fn();
 await expect(canvasApiStream(path,{turnId:"one"},new AbortController().signal,onDelta)).resolves.toEqual({answer:"甲乙"});
 expect(onDelta.mock.calls).toEqual([["甲"],["乙"]]);
 expect(fetcher.mock.calls.slice(1).map(([url,options])=>[url,options.method])).toEqual([
  [path,"POST"],[path+"/stream/one?after=1","GET"]
 ]);
});
