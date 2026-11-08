import { describe, expect, it } from "vitest";
import { areComfyPickerOptionsEqual } from "./comfy-picker-options";

describe("Config node Comfy picker option equality", () => {
  it("ignores fresh array/object identities but tracks disabled state", () => {
    expect(areComfyPickerOptionsEqual(
      [{ value: "preset@1", label: "Preset" }],
      [{ value: "preset@1", label: "Preset", disabled: false }],
    )).toBe(true);
    expect(areComfyPickerOptionsEqual(
      [{ value: "preset@1", label: "Preset", disabled: true }],
      [{ value: "preset@1", label: "Preset", disabled: false }],
    )).toBe(false);
  });
});
