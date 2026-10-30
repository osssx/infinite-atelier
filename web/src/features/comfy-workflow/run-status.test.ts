import { describe, expect, it } from "vitest";
import { comfyRunStatusLabel, comfyGenerationButtonAction, isComfyRunActive, isComfyRunTerminal } from "./run-status";

describe("durable ComfyUI workflow spinner statuses",()=>{
    it("spins from first click through GPU execution, capture and canvas import",()=>{
        for(const status of ["submitting","queued","preparing","running","collecting","importing"]){
            expect(isComfyRunActive(status)).toBe(true);
            expect(isComfyRunTerminal(status)).toBe(false);
            expect(comfyRunStatusLabel(status)).not.toMatch(/完成|失败/);
        }
    });
    it("selects generate, stop or disabled busy for a single action button",()=>{
        expect(comfyGenerationButtonAction()).toBe("generate");
        for(const status of ["running"]){
            expect(comfyGenerationButtonAction(status,true)).toBe("stop");
            expect(comfyGenerationButtonAction(status,false)).toBe("busy");
        }
        for(const status of ["submitting","preparing","collecting","cancelling"]){
            expect(comfyGenerationButtonAction(status,true)).toBe("busy");
        }
        for(const status of ["succeeded","failed","cancelled","submission_unknown"]){
            expect(comfyGenerationButtonAction(status,true)).toBe("generate");
        }
    });
    it("does not flash Stop in the initial queued -> preparing -> submitting -> running lifecycle",()=>{
        const statuses=["queued","preparing","submitting","running"];
        expect(statuses.map(status=>comfyGenerationButtonAction(status,true)))
            .toEqual(["busy","busy","busy","stop"]);
        expect(statuses.map(status=>isComfyRunActive(status))).toEqual([true,true,true,true]);
        expect(comfyGenerationButtonAction("queued",false)).toBe("busy");
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
