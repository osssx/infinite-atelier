import { describe, expect, it } from "vitest";
import { comfyRunStatusLabel, isComfyRunActive, isComfyRunTerminal } from "./run-status";

describe("durable ComfyUI workflow spinner statuses",()=>{
    it("spins from first click through GPU execution, capture and canvas import",()=>{
        for(const status of ["submitting","queued","preparing","running","collecting","importing"]){
            expect(isComfyRunActive(status)).toBe(true);
            expect(isComfyRunTerminal(status)).toBe(false);
            expect(comfyRunStatusLabel(status)).not.toMatch(/完成|失败/);
        }
    });
    it("stops on completion, failure, cancellation and unknown submission without claiming success",()=>{
        for(const status of ["succeeded","failed","cancelled","timed_out","submission_unknown","import_failed","blocked_credential","unavailable"]){
            expect(isComfyRunActive(status)).toBe(false);
            expect(isComfyRunTerminal(status)).toBe(true);
        }
        expect(comfyRunStatusLabel("submission_unknown")).toContain("待确认");
        expect(isComfyRunActive(undefined)).toBe(false);
    });
});
