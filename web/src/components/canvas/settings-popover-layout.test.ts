import {describe,expect,it} from "vitest";
import {calculateSettingsPopoverHorizontalPosition} from "./settings-popover-layout";

describe("canvas settings popover width and horizontal clamping",()=>{
 it("keeps default channel width while honoring the workflow parameter width",()=>{
  const anchor={left:500,right:540,width:40};
  expect(calculateSettingsPopoverHorizontalPosition(anchor,"topLeft",356,1280)).toMatchObject({width:356,left:500});
  expect(calculateSettingsPopoverHorizontalPosition(anchor,"topLeft",300,1280)).toMatchObject({width:300,left:500});
 });
 it("fits the available viewport and clamps all placements without horizontal overflow",()=>{
  const anchor={left:220,right:260,width:40};
  for(const placement of ["topLeft","top","topRight","bottomLeft","bottom","bottomRight"] as const){
   const position=calculateSettingsPopoverHorizontalPosition(anchor,placement,356,320);
   expect(position.width).toBe(296);
   expect(position.left).toBeGreaterThanOrEqual(0);
   expect(position.left+position.width).toBeLessThanOrEqual(320);
  }
 });
});
