import { beforeEach, describe, expect, it, vi } from "vitest";
import { createComfyTemplate, templatePayloadFromGraph } from "./template-schema";
import { getComfyTemplate, installComfyBackupVersions, installComfyTemplate } from "./template-registry";

const store = vi.hoisted(() => ({ values:new Map<string,unknown>(), calls:0,failAt:0 }));
vi.mock("localforage", () => ({default:{createInstance:()=>({
    getItem:async (key:string)=>store.values.get(key)??null,
    setItem:async (key:string,value:unknown)=>{
        store.calls++;
        if (store.failAt===store.calls) throw new Error("disk-fault");
        store.values.set(key,structuredClone(value));return value;
    },
    removeItem:async (key:string)=>{store.values.delete(key);},
    iterate:async (callback:(value:unknown,key:string)=>void)=>{for(const [k,v] of store.values)callback(v,k);},
})}}));
async function fixture(id:string, seed:number) {
    const graph={"1":{class_type:"TestImage",inputs:{seed}}};
    const p=templatePayloadFromGraph("Test",graph);
    p.ports=[{id:"result",label:"Result",direction:"source",valueKind:"IMAGE",outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"none"}}];
    return createComfyTemplate(id,p);
}
describe("Phase B: immutable template registry rollback", () => {
    beforeEach(()=>{store.values.clear();store.calls=0;store.failAt=0;});
    it("will never overwrite an immutable ID@revision with different bytes", async () => {
        const a=await fixture("a",1);
        expect(await installComfyTemplate(a)).toBe("installed");
        expect(await installComfyTemplate(a)).toBe("existing");
        const corrupted=structuredClone(a);corrupted.apiGraph["1"].inputs.seed=999;
        await expect(installComfyTemplate(corrupted)).rejects.toThrow(/SHA-256 mismatch/);
        expect((await getComfyTemplate(a.id,a.revision))?.apiGraph["1"].inputs.seed).toBe(1);
    });
    it("BAK-06: disk failure while installing a later version rolls back earlier new revisions", async () => {
        const a=await fixture("a",1),b=await fixture("b",2);
        store.failAt=2;
        await expect(installComfyBackupVersions([a,b])).rejects.toThrow(/disk-fault/);
        expect(store.values.size).toBe(0);
    });
    it("rollback removes only newly installed versions, keeping pre-existing versions intact", async () => {
        const a=await fixture("a",1), b=await fixture("b",2);
        await installComfyTemplate(a);
        const rollback=await installComfyBackupVersions([a,b]);
        expect(store.values.size).toBe(2);
        await rollback();
        expect(store.values.size).toBe(1);
        expect(await getComfyTemplate(a.id,a.revision)).not.toBeNull();
        expect(await getComfyTemplate(b.id,b.revision)).toBeNull();
    });
});
