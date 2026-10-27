import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {CanvasApiError,canvasApi} from "@/features/backend-sync/canvas-api";
import {listSqliteComfyInstances,saveSqliteComfyInstance,deleteSqliteComfyInstance} from "./sqlite-instances-client";
vi.mock("@/features/backend-sync/canvas-api",async(importOriginal)=>({
 ...await importOriginal<typeof import("@/features/backend-sync/canvas-api")>(),
 canvasApi:vi.fn()
}));
const request=vi.mocked(canvasApi);
const emit=vi.fn();
beforeEach(()=>{request.mockReset();emit.mockReset();vi.stubGlobal("window",{dispatchEvent:emit})});
afterEach(()=>vi.unstubAllGlobals());
describe("SQLite ComfyUI instance settings client",()=>{
 it("lists the authoritative backend instances, not the deprecated gateway",async()=>{
  request.mockResolvedValue({instances:[{id:"comfy-local",url:"http://127.0.0.1:8188",reachable:false,classTypes:[]}]});
  await expect(listSqliteComfyInstances()).resolves.toHaveLength(1);
  expect(request).toHaveBeenCalledWith("/api/v1/comfy/instances");
 });
 it("writes to the SQLite backend and refreshes Canvas readiness after success",async()=>{
  request.mockResolvedValueOnce({instance:{id:"new",url:"http://127.0.0.1:8188"}})
   .mockResolvedValueOnce({instance:{id:"new",url:"http://127.0.0.1:8189"}})
   .mockResolvedValueOnce({deleted:"new"});
  await saveSqliteComfyInstance("new","http://127.0.0.1:8188");
  await saveSqliteComfyInstance("new","http://127.0.0.1:8189","new");
  await deleteSqliteComfyInstance("new");
  expect(request.mock.calls).toEqual([
   ["/api/v1/comfy/instances","POST",{id:"new",url:"http://127.0.0.1:8188"}],
   ["/api/v1/comfy/instances/new","PUT",{id:"new",url:"http://127.0.0.1:8189"}],
   ["/api/v1/comfy/instances/new","DELETE"]
  ]);
  expect(emit).toHaveBeenCalledTimes(3);
  expect(emit.mock.calls[0][0].type).toBe("atelier:comfy-instances-changed");
 });
 it("does not signal readiness on conflicts and explains nonterminal run locks",async()=>{
  request.mockRejectedValue(new CanvasApiError("comfy_instance_has_pending_jobs",409));
  await expect(deleteSqliteComfyInstance("new")).rejects.toThrow(/未完成或提交状态不明/);
  expect(emit).not.toHaveBeenCalled();
 });
});
