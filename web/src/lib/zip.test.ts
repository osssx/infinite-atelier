import { describe, expect, it } from "vitest";
import { createZip, readZip } from "./zip";

const limits = {maxFiles:3,maxUncompressedBytes:32,maxEntryBytes:24,maxArchiveBytes:1024};
describe("v2 backup ZIP extraction limits", () => {
    it("accepts a small safe archive", async () => {
        const zip=await createZip([{name:"backup.json",data:"{}"}]);
        const entries=await readZip(zip,limits);
        expect(await entries.get("backup.json")?.text()).toBe("{}");
    });
    it("rejects traversal entries prior to extracting them", async () => {
        const zip=await createZip([{name:"../workflow.json",data:"{}"}]);
        await expect(readZip(zip,limits)).rejects.toThrow(/Unsafe/);
    });
    it("rejects excessive file counts and declared expanded payload sizes", async () => {
        const zip=await createZip(Array.from({length:4},(_,i)=>({name:"f"+i,data:"tiny"})));
        await expect(readZip(zip,limits)).rejects.toThrow(/limit exceeded/);
        const big=await createZip([{name:"huge",data:".".repeat(128)}]);
        await expect(readZip(big,limits)).rejects.toThrow(/limit exceeded/);
    });
});
