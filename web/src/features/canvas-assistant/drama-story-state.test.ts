import {expect,it} from "vitest";
import type {CanvasNodeMetadata} from "@/types/canvas";
import {rollbackStoryDraftPatch,storyDraftPatchMatches} from "./drama-story-state";

it("uses a single rollback for story body and provenance and never overwrites a conflicting field",()=>{
 const before:CanvasNodeMetadata={dramaDraft:"旧稿",content:"旧稿",dramaConfirmed:"旧版本"};
 const patch={dramaDraft:"新稿",content:"新稿"};
 expect(rollbackStoryDraftPatch(before,{...before,...patch},patch)).toEqual({dramaDraft:"旧稿",content:"旧稿"});
 expect(rollbackStoryDraftPatch(before,{...before,...patch,content:"外部修改"},patch)).toBeNull();
 expect(storyDraftPatchMatches(before,{...before,...patch,dramaFilmStyle:"新风格"},patch)).toBe(true);
});
it("preserves a separate art field changed during a failed save, but refuses to undo a new value for the edited field",()=>{
 const old={palette:"绿",lighting:"柔光",characterDesign:"猫",anchors:"尾巴"};
 const before={dramaArtDirection:old};
 const patch={dramaArtDirection:{...old,palette:"蓝"}};
 const current={dramaArtDirection:{...patch.dramaArtDirection,lighting:"明亮"}};
 expect(storyDraftPatchMatches(before,current,patch)).toBe(true);
 expect(rollbackStoryDraftPatch(before,current,patch)).toEqual({dramaArtDirection:{...old,lighting:"明亮"}});
 expect(rollbackStoryDraftPatch(before,{dramaArtDirection:{...current.dramaArtDirection,palette:"红"}},patch)).toBeNull();
});
