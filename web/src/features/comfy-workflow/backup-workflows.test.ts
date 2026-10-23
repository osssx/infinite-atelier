import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { AppBackupFile } from "@/services/backup-validation";
import { validateBackup } from "@/services/backup-validation";
import { canonicalComfyJson, createComfyTemplate, templatePayloadFromGraph, type ComfyWorkflowTemplate } from "./template-schema";
import { exportComfyBackupTemplates, unbindImportedComfyProjects, verifyComfyBackupTemplates } from "./backup-workflows";
import { getComfyTemplate } from "./template-registry";

vi.mock("./template-registry", () => ({ getComfyTemplate:vi.fn() }));
const graph = () => ({ "1":{class_type:"CreateImage",inputs:{seed:42}}, "2":{class_type:"SaveImage",inputs:{images:["1",0]}} });
const tpl = async (id="example"): Promise<ComfyWorkflowTemplate> => {
    const payload=templatePayloadFromGraph("Example",graph());
    payload.ports=[{id:"image",label:"Image",direction:"source",valueKind:"IMAGE",
        outputBinding:{nodeId:"1",outputIndex:0},capture:{kind:"image",adapterId:"SaveImage"}}];
    return createComfyTemplate(id,payload);
};
const project = (template: ComfyWorkflowTemplate, id="p"): CanvasProject => ({
    id,title:id,createdAt:"2026",updatedAt:"2026",viewport:{x:0,y:0,k:1},
    backgroundMode:"lines",showImageInfo:false,chatSessions:[],activeChatId:null,connections:[],
    nodes:[{id:"wf-"+id,type:"comfy:workflow",title:"WF",width:340,height:260,position:{x:0,y:0},
        metadata:{comfyPorts:[{id:"injected",direction:"source",label:"Untrusted",valueKind:"IMAGE"}],
            comfyWorkflow:{templateId:template.id,templateRevision:template.revision,instanceId:"remote-other-host",
                bindingState:"bound",inputOverrides:{}}}}],
});
const manifest = (projects: CanvasProject[], records: AppBackupFile["comfyWorkflows"]): AppBackupFile => ({
    app:"infinite-canvas",version:2,exportedAt:"2026-10-22",projects,assets:[],config:{} as AppBackupFile["config"],files:[],comfyWorkflows:records,
});

describe("Phase B: self-contained ComfyUI v2 backups", () => {
    beforeEach(()=>vi.resetAllMocks());
    it("BAK-01: two projects sharing a revision produce one content-addressed workflow ZIP payload", async () => {
        const a=await tpl();
        vi.mocked(getComfyTemplate).mockResolvedValue(a);
        const {records,files}=await exportComfyBackupTemplates([project(a),project(a,"b")]);
        expect(records).toHaveLength(1);
        expect(files.size).toBe(1);
        const checked=validateBackup(manifest([project(a),project(a,"b")],records),files);
        expect(checked.comfyWorkflows?.length).toBe(1);
        const restored=await verifyComfyBackupTemplates(records,files);
        expect(restored[0]).toMatchObject({id:a.id,revision:a.revision});
    });
    it("BAK-02: different template IDs with same content can share ZIP path but restore both IDs", async () => {
        const a=await tpl("original"),b=await tpl("copy");
        vi.mocked(getComfyTemplate).mockImplementation(async (id)=>id==="original"?a:b);
        const {records,files}=await exportComfyBackupTemplates([project(a),project(b,"other")]);
        expect(records).toHaveLength(2);expect(files.size).toBe(1);
        expect((await verifyComfyBackupTemplates(records,files)).map((t)=>t.id)).toEqual(["original","copy"]);
    });
    it("BAK-03: missing package / altered SHA / unexpected records fail before project write", async () => {
        const a=await tpl();
        vi.mocked(getComfyTemplate).mockResolvedValue(a);
        const {records,files}=await exportComfyBackupTemplates([project(a)]);
        expect(()=>validateBackup(manifest([project(a)],records),new Map())).toThrow(/missing Comfy/);
        const tampered=new Map(files);
        tampered.set(records[0].path,new Blob([canonicalComfyJson({...a,name:"Tampered"})]));
        await expect(verifyComfyBackupTemplates(records,tampered)).rejects.toThrow(/SHA-256 mismatch/);
        expect(()=>validateBackup(manifest([project(a)],[...records,...records]),files)).toThrow(/duplicate/);
        expect(()=>validateBackup(manifest([project(a)],[]),files)).toThrow(/missing Comfy/);
    });
    it("BAK-04: imported node is unbound and cached/spoofed ports are rebuilt from verified template", async () => {
        const a=await tpl();
        const restored=unbindImportedComfyProjects([project(a)],[a]);
        const meta=restored[0].nodes[0].metadata!;
        expect(meta.comfyWorkflow?.instanceId).toBeUndefined();
        expect(meta.comfyWorkflow?.bindingState).toBe("needs-instance-binding");
        expect(meta.comfyPorts).toMatchObject([{id:"image",direction:"source",valueKind:"IMAGE"}]);
        expect(()=>unbindImportedComfyProjects([project(a)],[])).toThrow(/Missing template/);
    });
    it("BAK-05: v1 remains supported without Comfy nodes, rejects dangling V1 Comfy references", async () => {
        const a=await tpl();
        const old={...manifest([],[]),version:1 as const,comfyWorkflows:undefined};
        expect(validateBackup(old,new Map()).version).toBe(1);
        expect(()=>validateBackup({...old,projects:[project(a)]},new Map())).toThrow(/v1 backup lacks/);
    });
});
