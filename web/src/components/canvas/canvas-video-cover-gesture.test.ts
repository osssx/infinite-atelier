import { describe, expect, it } from "vitest";
import { shouldPlayVideoCoverClick, videoCoverPressDragged, type VideoCoverPress } from "./canvas-video-cover-gesture";

describe("video poster mouse gesture vs canvas node dragging", () => {
    it("keeps a stationary click (including small jitter) available for playback", () => {
        const press:VideoCoverPress = { startX:120,startY:70,dragged:false };
        expect(videoCoverPressDragged(press,120,70)).toBe(false);
        expect(videoCoverPressDragged(press,123,73)).toBe(false);
        expect(videoCoverPressDragged(press,117,67)).toBe(false);
    });

    it("treats movement past the same 3px canvas drag threshold as drag, not playback", () => {
        const press:VideoCoverPress = { startX:120,startY:70,dragged:false };
        expect(videoCoverPressDragged(press,124,70)).toBe(true);
        expect(videoCoverPressDragged(press,120,74)).toBe(true);
        expect(videoCoverPressDragged(press,116,70)).toBe(true);
        expect(videoCoverPressDragged(press,120,66)).toBe(true);
    });

    it("keeps the drag classification after the pointer returns to its start position", () => {
        const press:VideoCoverPress = { startX:120,startY:70,dragged:false };
        press.dragged=videoCoverPressDragged(press,130,70);
        expect(videoCoverPressDragged(press,120,70)).toBe(true);
    });

    it("plays on ordinary cover click but not after a node drag", () => {
        const press:VideoCoverPress={startX:40,startY:50,dragged:false};
        expect(shouldPlayVideoCoverClick(press,{detail:1,clientX:40,clientY:50})).toBe(true);
        expect(shouldPlayVideoCoverClick(press,{detail:1,clientX:45,clientY:50})).toBe(false);
        press.dragged=true;
        expect(shouldPlayVideoCoverClick(press,{detail:1,clientX:40,clientY:50})).toBe(false);
        expect(shouldPlayVideoCoverClick(null,{detail:1,clientX:40,clientY:50})).toBe(false);
    });

    it("has no mouse drag for keyboard click activation", () => {
        expect(videoCoverPressDragged(null,0,0)).toBe(false);
    });
});
