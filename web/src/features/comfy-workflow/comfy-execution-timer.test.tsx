import {describe,expect,it} from "vitest";
import {formatComfyElapsed} from "./comfy-execution-timer";

describe("Comfy execution timer formatting",()=>{
 it("formats elapsed time as MM:SS and switches to H:MM:SS after one hour",()=>{
  expect(formatComfyElapsed(1000,1000)).toBe("00:00");
  expect(formatComfyElapsed(1000,60000)).toBe("00:59");
  expect(formatComfyElapsed(1000,3601000)).toBe("1:00:00");
  expect(formatComfyElapsed(1000,7322000)).toBe("2:02:01");
 });
 it("clamps future anchors and invalid timestamps to zero",()=>{
  expect(formatComfyElapsed(5000,1000)).toBe("00:00");
  expect(formatComfyElapsed(Number.NaN,1000)).toBe("00:00");
 });
});
