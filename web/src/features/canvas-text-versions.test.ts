import {describe, expect, it} from "vitest";
import {canRestoreNodeVersion, supportsTextVersions, versionNodeContent} from "./canvas-text-versions";
import type {CanvasNodeData} from "@/types/canvas";

function node(type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return {id:"node", type, metadata, title:"Node", position:{x:0,y:0}, width:100,height:100};
}

describe("node version display and restore rules", () => {
    it("uses the story editor's fallback and honors an explicitly cleared draft", () => {
        expect(versionNodeContent(node("drama:source",{content:"legacy",dramaConfirmed:"confirmed"}))).toBe("legacy");
        expect(versionNodeContent(node("drama:source",{dramaConfirmed:"confirmed"}))).toBe("confirmed");
        expect(versionNodeContent(node("drama:source",{dramaDraft:"",content:"legacy",dramaConfirmed:"confirmed"}))).toBe("");
        expect(canRestoreNodeVersion(node("drama:source",{})," \n")).toBe(false);
        expect(canRestoreNodeVersion(node("drama:source",{}),"# Screenplay\n")).toBe(true);
    });

    it("keeps structured restore validation and restricts history to supported nodes", () => {
        const episode = node("drama:episodes",{dramaConfirmed:"confirmed"});
        const storyboard = node("drama:storyboard",{});
        const shot = {id:"shot",episodeId:"ep",order:1,description:"opening",characterVariantIds:[],propIds:[],keyPropIds:[]};
        expect(versionNodeContent(episode)).toBe("confirmed");
        expect(canRestoreNodeVersion(episode,"plain text")).toBe(false);
        expect(canRestoreNodeVersion(storyboard,JSON.stringify({shots:[shot]}))).toBe(true);
        expect(canRestoreNodeVersion(storyboard,JSON.stringify({shots:[shot,shot]}))).toBe(false);
        expect(supportsTextVersions(node("text",{}))).toBe(true);
        expect(supportsTextVersions(node("image",{}))).toBe(false);
    });
});
