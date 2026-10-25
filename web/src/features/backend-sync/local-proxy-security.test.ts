import {describe,it,expect} from "vitest";
import {validateLocalBackendTarget} from "../../../vite.config";

describe("private opt-in backend development proxy",()=>{
 it("remains disabled until explicitly configured",()=>{
  expect(validateLocalBackendTarget(undefined)).toBeNull();
  expect(validateLocalBackendTarget("")).toBeNull();
 });
 it("accepts only exact explicit loopback HTTP origins",()=>{
  expect(validateLocalBackendTarget("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
  expect(validateLocalBackendTarget("http://[::1]:8788")).toBe("http://[::1]:8788");
  for(const value of [
   "http://localhost:8788","http://8.8.8.8:8788",
   "https://127.0.0.1:8788","http://127.0.0.1",
   "http://127.0.0.1:8788/api","http://127.0.0.1:8788?x=1",
   "http://admin:pw@127.0.0.1:8788","http://127.0.0.1:8788/#test"
  ])expect(()=>validateLocalBackendTarget(value),value).toThrow();
 });
});
