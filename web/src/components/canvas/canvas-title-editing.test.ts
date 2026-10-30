import {describe, expect, it} from "vitest";
import {nextTitleEditingNodeId, toolbarNodeDuringTitleEditing} from "./canvas-title-editing";

describe("canvas title editing / floating toolbar", () => {
    const selected = {id:"selected"};

    it("hides the toolbar immediately while a selected or hovered node title is edited", () => {
        const editing = nextTitleEditingNodeId(null, selected.id, true);
        expect(editing).toBe(selected.id);
        expect(toolbarNodeDuringTitleEditing(selected, editing)).toBeNull();
        // A hover/selection update elsewhere does not reveal another toolbar.
        expect(toolbarNodeDuringTitleEditing({id:"other"}, editing)).toBeNull();
    });

    it("restores the normal selected-node toolbar on blur, Enter or Escape", () => {
        const editing = nextTitleEditingNodeId(null, selected.id, true);
        const finished = nextTitleEditingNodeId(editing, selected.id, false);
        expect(finished).toBeNull();
        expect(toolbarNodeDuringTitleEditing(selected, finished)).toBe(selected);
    });

    it("ignores a delayed cleanup from a different title editor", () => {
        let editing = nextTitleEditingNodeId(null, "first", true);
        editing = nextTitleEditingNodeId(editing, "second", true);
        expect(nextTitleEditingNodeId(editing, "first", false)).toBe("second");
        expect(nextTitleEditingNodeId(editing, "second", false)).toBeNull();
    });

    it("preserves the existing hidden state when no node is selected", () => {
        expect(toolbarNodeDuringTitleEditing(null, null)).toBeNull();
    });
});
