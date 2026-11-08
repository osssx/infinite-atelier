import {describe,expect,it} from "vitest";
import {restoreCanvasMaskSelectionPixels} from "./canvas-mask-pixels";

describe("canonical mask PNG alpha decoding",()=>{
 it("inverts only the alpha channel per pixel without shifting into the next pixel",()=>{
  const source=new Uint8ClampedArray([10,20,30,0,40,50,60,255,70,80,90,128]);
  expect([...restoreCanvasMaskSelectionPixels(source)]).toEqual([
   0,0,0,255,0,0,0,0,0,0,0,127
  ]);
 });
});
