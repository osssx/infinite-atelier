import {afterEach,describe,expect,it,vi} from "vitest";
const fake=vi.hoisted(()=>({api:vi.fn(async()=>({eventCursor:27}))}));
vi.mock("./canvas-api",()=>({canvasApi:fake.api}));
import {subscribeSqliteJobEvents} from "./sqlite-job-events";

class FakeEventSource{
 static instances:FakeEventSource[]=[];
 readonly handlers=new Map<string,((event:{data:string})=>void)[]>();
 closed=false;
 constructor(readonly url:string,readonly options:{withCredentials:boolean}){
  FakeEventSource.instances.push(this);
 }
 addEventListener(event:string,callback:(event:{data:string})=>void){
  this.handlers.set(event,[...(this.handlers.get(event)??[]),callback]);
 }
 send(jobId:string,kind="state_changed",payload?:unknown){
  for(const handler of this.handlers.get("job")??[])
   handler({data:JSON.stringify({jobId,kind,eventId:28,payload})});
 }
 close(){this.closed=true}
}
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();FakeEventSource.instances.length=0});
describe("P4.2 shared SQLite SSE subscription",()=>{
 it("opens only one replay-safe authenticated stream and dispatches by job ID",async()=>{
  vi.stubGlobal("EventSource",FakeEventSource);
  const first=vi.fn(),second=vi.fn();
  const offA=subscribeSqliteJobEvents("job-a",first);
  const offB=subscribeSqliteJobEvents("job-b",second);
  await vi.waitFor(()=>expect(FakeEventSource.instances).toHaveLength(1));
  const stream=FakeEventSource.instances[0];
  expect(stream.url).toBe("/api/v1/events?after=27");
  expect(stream.options.withCredentials).toBe(true);
  expect(fake.api).toHaveBeenCalledOnce();
  stream.send("job-a");
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  stream.send("job-b");
  expect(second).toHaveBeenCalledOnce();
  stream.send("job-a","model_text_delta",{delta:"hello"});
  expect(first).toHaveBeenLastCalledWith(expect.objectContaining({
   jobId:"job-a",kind:"model_text_delta",payload:{delta:"hello"}
  }));
  expect(first).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(1);
  offA();
  expect(stream.closed).toBe(false);
  offB();
  expect(stream.closed).toBe(true);
 });
 it("invalid event payloads never dispatch model progress",async()=>{
  vi.stubGlobal("EventSource",FakeEventSource);
  const fn=vi.fn(),off=subscribeSqliteJobEvents("job-a",fn);
  await vi.waitFor(()=>expect(FakeEventSource.instances).toHaveLength(1));
  for(const handler of FakeEventSource.instances[0].handlers.get("job")??[])
   handler({data:JSON.stringify({jobId:"job-a",kind:"model_text_delta",eventId:"invalid",payload:{delta:"unsafe"}})});
  expect(fn).not.toHaveBeenCalled();
  off();
 });
 it("rejects unsafe IDs without creating any stream",()=>{
  expect(()=>subscribeSqliteJobEvents("../../other",vi.fn())).toThrow("invalid_job_id");
 });
});
