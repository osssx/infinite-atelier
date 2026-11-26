"""P5 real SPA + isolated SQLite/CAS, 200 nodes and 200 confirmed shots.
Default: no generation. ATELIER_DRAMA_P5_LIVE_COMFY=1 explicitly enables a single local ComfyUI clip."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("p34b",ROOT/"scripts/drama-p34b-chrome-perf.py")
perf=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=perf
spec.loader.exec_module(perf)
def run():
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-p34b-browser-"))
    profile=root.parent/(root.name+"-chrome-profile")
    backend_port,front_port,chrome_port=perf.port(),perf.port(),perf.port()
    env=dict(os.environ,ATELIER_P34B_BROWSER_E2E="1",ATELIER_DRAMA_P5_BROWSER_E2E="1",
        ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port))
    processes=[];logs=[];page=None
    passed=[];metrics=[]
    portal='[data-creative-workspace-node-id="board"]'
    card='[data-node-id="board"] [data-drama-summary-kind="storyboard"]'
    def launch(name,args,e=env):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace");logs.append(log)
        p=subprocess.Popen(args,cwd=ROOT,env=e,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT);processes.append(p)
    def check(name,expr,timeout=20):
        value=perf.wait_for(lambda:page.js(expr),name,timeout)
        passed.append(name);print("P5_BROWSER_ASSERT",name,flush=True)
        return value
    def click(selector):
        check("click "+selector,"(()=>{const b=document.querySelector(%s);if(!b||b.disabled)return false;b.click();return true})()"%json.dumps(selector,ensure_ascii=False))
    def button(label,scope=portal):
        check("click "+label,"(()=>{const b=[...(document.querySelector(%s)?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()===%s&&!b.disabled&&b.getClientRects().length);if(!b)return false;b.click();return true})()"%(json.dumps(scope),json.dumps(label,ensure_ascii=False)))
    def choose(label,value):
        check("select "+label,"(()=>{const s=document.querySelector(%s);if(!s||s.disabled||![...s.options].some(o=>o.value===%s&&!o.disabled))return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,%s);s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"%(json.dumps(portal+' select[aria-label="'+label+'"]',ensure_ascii=False),json.dumps(value),json.dumps(value)))
    def open_workspace():
        start=time.monotonic()
        button("打开完整编辑器 ↗",card)
        check("editor mounted", "!!document.querySelector("+json.dumps(portal+' [aria-label="当前分镜编辑区"]',ensure_ascii=False)+")",45)
        metrics.append({"scenario":"editor-open","ms":round((time.monotonic()-start)*1000,1)})
    def close_workspace():
        click(".ant-modal-close")
        check("workspace unmounted","!document.querySelector("+json.dumps(portal)+")")
    try:
        launch("backend",["node","scripts/drama-p34b-browser-fixture.mjs"])
        fixture=perf.wait_for(lambda:json.loads((root/"p34b-fixture.json").read_text("utf-8")) if (root/"p34b-fixture.json").exists() else None,"fixture",45)
        assert fixture["shots"]==200 and fixture["nodes"]==200,fixture
        front=f"http://127.0.0.1:{front_port}"
        launch("vite",["node",str(ROOT/"node_modules/vite/bin/vite.js"),"--host","127.0.0.1","--port",str(front_port),"--strictPort"],dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]))
        perf.wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"vite",40)
        launch("chrome",[str(perf.cdp.CHROME),"--headless=new","--no-first-run","--no-default-browser-check",f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",f"--user-data-dir={profile}","--window-size=1720,1050","about:blank"])
        perf.wait_for(lambda:perf.get_json(f"http://127.0.0.1:{chrome_port}/json/version"),"Chrome CDP",35)
        page=perf.ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",{"width":1720,"height":1050,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Performance.enable",{})
        page.call("HeapProfiler.enable",{})
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        check("lightweight canvas summary","!!document.querySelector("+json.dumps(card)+")&&!document.querySelector("+json.dumps(portal)+")",65)
        for appearance in ("dark","light"):
            current=page.js("document.querySelector("+json.dumps(card)+")?.dataset.dramaCardTheme")
            if current!=appearance:
                label="切换到浅色主题" if appearance=="light" else "切换到深色主题"
                english="Switch to light theme" if appearance=="light" else "Switch to dark theme"
                check("switch theme "+appearance,"(()=>{const b=[...document.querySelectorAll('button')].find(x=>[%s,%s].includes(x.getAttribute('aria-label')));if(!b)return false;b.click();return true})()"%(json.dumps(label,ensure_ascii=False),json.dumps(english)))
            check("canvas theme "+appearance,"document.querySelector("+json.dumps(card)+")?.dataset.dramaCardTheme==="+json.dumps(appearance))
            open_workspace()
            check("merged editor "+appearance,"""(()=>{const r=document.querySelector(%s);return r?.dataset.dramaWorkspaceTheme===%s&&!!r.querySelector('[aria-label="镜头视频配置"]')&&!r.querySelector('[aria-label="视频配置镜头目录"]')})()"""%(json.dumps(portal),json.dumps(appearance)))
            start=time.monotonic()
            button("批量创建配置")
            check("batch table mounted","document.querySelector("+json.dumps(portal+" tbody")+")?.children.length===15")
            choose("批量创建配置剧集","")
            check("200 shots bounded to 15 rows","(()=>{const r=document.querySelector(%s);return r?.textContent.includes('200 条')&&r.querySelectorAll('tbody tr').length===15})()"%json.dumps(portal))
            metrics.append({"scenario":"batch-open-all","theme":appearance,"ms":round((time.monotonic()-start)*1000,1),"heapBytes":perf.heap(page)})
            button("全选筛选结果")
            check("200 selected","document.querySelector("+json.dumps(portal)+")?.textContent.includes('已选 200 镜')")
            start=time.monotonic()
            button("下一页",portal+' [aria-label="批量创建配置"]')
            check("page two retains selection","(()=>{const r=document.querySelector(%s);return r?.textContent.includes('第 2 / 14 页')&&r.textContent.includes('已选 200 镜')&&r.querySelectorAll('tbody tr').length===15})()"%json.dumps(portal))
            metrics.append({"scenario":"page-switch","theme":appearance,"ms":round((time.monotonic()-start)*1000,1)})
            episode="ep-1" if appearance=="dark" else "ep-2"
            shot="shot-50" if appearance=="dark" else "shot-100"
            choose("批量创建配置剧集",episode)
            check("episode filter","document.querySelector("+json.dumps(portal)+")?.textContent.includes('50 条')")
            button("定位镜头",portal+" tbody")
            check("locate shot in editor","!!document.querySelector("+json.dumps(portal+' [aria-label="当前分镜编辑区"]',ensure_ascii=False)+")")
            check("located episode","document.querySelector("+json.dumps(portal+' select[aria-label="选择分镜剧集"]',ensure_ascii=False)+")?.value==="+json.dumps(episode))
            button("提示词",portal+' [aria-label="视频配置页面"]')
            check("separate prompt preview","!!document.querySelector('[aria-label=\"视频提示词\"] pre')")
            button("参考素材",portal+' [aria-label="视频配置页面"]')
            check("separate reference preview","!!document.querySelector('[aria-label=\"视频参考素材\"]')")
            button("生成设置",portal+' [aria-label="视频配置页面"]')
            click(portal+' button[aria-label="编辑视频输入模式"]')
            target=check("installed video workflow choice","""(()=>{const s=document.querySelector('[aria-label="视频渠道"]');return [...(s?.options||[])].find(o=>{try{return JSON.parse(o.value).templateId==='p5-video-fixture'}catch{return false}})?.value||null})()""")
            choose("视频渠道",target)
            check("selected workflow capability ready","""(()=>{const s=document.querySelector('[aria-label="视频输入模式"]');return s&&!s.disabled&&s.value==='first_frame'&&[...s.options].some(o=>o.value==='first_frame'&&!o.disabled)})()""")
            check("inner video tabs locked during settings edit","[...document.querySelectorAll('[aria-label=\"视频配置页面\"] button')].every(b=>b.disabled)")

            # The isolated shot starts in first-frame mode, so no configured model is needed to bind a CAS image.
            click(portal+' button[aria-label="选择首帧"]')
            check("real image thumbnail loaded","""(()=>{const s=document.querySelector(%s);const i=s?.querySelector('img');return i&&i.complete&&i.naturalWidth>0})()"""%json.dumps(portal+' [aria-label="首帧图片选择器"]',ensure_ascii=False))
            # Network CDP is authoritative: the Resource Timing buffer can fill on large canvases.
            assert any("/image-generation-times" in req.get("path","") and req["method"]=="GET" for req in page.network_requests), "image generation time request missing"
            passed.append("generation time endpoint requested")
            click(portal+' [aria-label="首帧图片选择器"] button[aria-label^="选择图片 "]')
            button("使用图片",portal+' [aria-label="首帧图片选择器"]')
            check("image staged only","""(()=>{const r=document.querySelector(%s);return r?.querySelector('[data-video-mode-field="editing"] img')&&!r.querySelector('[aria-label="首帧图片选择器"]')})()"""%json.dumps(portal))
            before=page.js("""(async()=>{const r=await fetch('/api/v1/projects/%s');const d=await r.json();return d.document.nodes.find(n=>n.id==='board').metadata.dramaShotProduction?.[%s]?.firstFrame??null})()"""%(fixture["projectId"],json.dumps(shot)))
            assert before is None,before
            button("批量创建配置")
            check("dirty mode blocks tab","document.body.innerText.includes('存在未提交的草案修改')")
            button("继续编辑","body")
            check("shot directory locked","""(()=>{const r=document.querySelector(%s);const b=[...r.querySelectorAll('[aria-label="分镜镜头导航"] button')];return b.length>0&&b.every(x=>x.disabled)})()"""%json.dumps(portal))
            if appearance=="dark":
                click(portal+' button[aria-label="确认视频输入模式"]')
                check("field success toast within themed workspace","""(()=>{const r=document.querySelector(%s),t=r?.querySelector('[data-drama-feedback="success"]'),layer=r?.querySelector('[data-drama-feedback-toasts]');if(!t||!layer||!t.textContent.includes('视频输入模式已更新草案'))return false;const a=r.getBoundingClientRect(),b=t.getBoundingClientRect(),c=getComputedStyle(layer);return b.width>0&&b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom&&c.position==='absolute'&&c.pointerEvents==='none'&&getComputedStyle(t).backgroundColor===getComputedStyle(r.querySelector('[data-drama-workspace-content]')).backgroundColor})()"""%json.dumps(portal))
                check("real persisted frame","""(async()=>{const r=await fetch('/api/v1/projects/%s');const d=await r.json();return !!d.document.nodes.find(n=>n.id==='board').metadata.dramaShotProduction?.[%s]?.firstFrame})()"""%(fixture["projectId"],json.dumps(shot)),35)
                check("read-only preview loaded","""(()=>{const i=document.querySelector(%s);return i&&i.complete&&i.naturalWidth>0})()"""%json.dumps(portal+' [data-video-mode-readonly] img'))
            else:
                click(portal+' [data-video-mode-field="editing"] [data-drama-action="cancel"]')
                check("cancel does not show success toast","!document.querySelector("+json.dumps(portal+' [data-drama-feedback="success"]')+")")
                check("cancel leaves backend unchanged","""(async()=>{const r=await fetch('/api/v1/projects/%s');const d=await r.json();return !d.document.nodes.find(n=>n.id==='board').metadata.dramaShotProduction?.[%s]?.firstFrame})()"""%(fixture["projectId"],json.dumps(shot)))
            check("shot directory unlocked","""(()=>{const r=document.querySelector(%s);const b=[...r.querySelectorAll('[aria-label="分镜镜头导航"] button')];return b.length>0&&b.every(x=>!x.disabled)})()"""%json.dumps(portal))
            close_workspace()
        # Reopen the real saved shot and create a production Config from the merged editor.
        # Feedback is scoped to the mounted workspace and must not survive closing.
        check("closed workspace has no feedback or task","!document.querySelector('[data-drama-feedback-toasts],[data-drama-feedback-errors],[data-drama-task-status]')")
        open_workspace()
        button("批量创建配置")
        check("reopened workspace starts without previous feedback","!document.querySelector('[data-drama-feedback-toasts],[data-drama-feedback-errors],[data-drama-task-status]')")
        choose("批量创建配置剧集","ep-1")
        button("定位镜头",portal+" tbody")
        check("saved shot production ready","""(()=>{const r=document.querySelector(%s);return r?.textContent.includes('输入预检通过')&&[...r.querySelectorAll('button')].some(b=>b.textContent.trim()==='创建视频配置'&&!b.disabled)})()"""%json.dumps(portal),35)
        button("创建视频配置")
        check("real Config graph persisted","""(async()=>{const r=await fetch('/api/v1/projects/%s');const d=await r.json();const nodes=d.document?.nodes||[],edges=d.document?.connections||[];
          const configs=nodes.filter(n=>n.type==='config'&&n.metadata?.dramaShotId==='shot-50');if(configs.length!==1)return false;
          const c=configs[0],m=c.metadata,b=m.comfyWorkflowSelections?.video,source=nodes.find(n=>n.id===b?.slots?.opening?.nodeId);
          return m.generationMode==='video'&&m.videoMode==='first_frame'&&m.dramaVideoSource?.revisionId==='p34b-v1'&&b?.templateId==='p5-video-fixture'&&b?.mediaMode==='first_frame'&&
            source?.metadata?.storageKey===m.dramaVideoSource?.referenceKeys?.[0]&&
            edges.some(e=>e.fromNodeId==='board'&&e.toNodeId===c.id)&&edges.some(e=>e.fromNodeId===source.id&&e.fromPortId==='image'&&e.toNodeId===c.id&&e.toPortId==='opening')})()"""%fixture["projectId"],35)
        assert not any(req["method"]=="POST" and ("/jobs" in req["path"] or "/shot-batches" in req["path"]) for req in page.network_requests),"Config creation must not submit generation"
        passed.append("Config created without submitting generation")
        if os.environ.get("ATELIER_DRAMA_P5_LIVE_COMFY")=="1":
            # One actual user action; do not retry submission on a slow response.
            config_id=page.js("""(async()=>{const d=await (await fetch('/api/v1/projects/%s')).json();return d.document.nodes.find(n=>n.type==='config'&&n.metadata?.dramaShotId==='shot-50').id})()"""%fixture["projectId"])
            check("config panel opened","!document.querySelector("+json.dumps(portal)+")")
            page.js("""(()=>{window.p5Notices=[];new MutationObserver(()=>{for(const n of document.querySelectorAll('.ant-message-notice,.ant-notification-notice,[role="alert"]')){const s=n.textContent.trim();if(s&&!window.p5Notices.includes(s))window.p5Notices.push(s)}}).observe(document.body,{subtree:true,childList:true,characterData:true});return true})()""")
            click('button[aria-label="开始生成"]')
            def submitted():
                notices=page.js("window.p5Notices||[]")
                jobs=[r for r in page.network_requests if r["method"]=="POST" and "jobs" in r["path"]]
                return {"jobs":jobs,"notices":notices} if jobs or notices else False
            submission=perf.wait_for(submitted,"generation submission or notice",25)
            print("P5_SUBMISSION",json.dumps(submission,ensure_ascii=False),flush=True)
            assert submission["jobs"],submission
            outcome=check("real Comfy video materialized","""(async()=>{const d=await (await fetch('/api/v1/projects/%s')).json();const c=%s;
              const video=d.document.nodes.find(n=>n.type==='video'&&n.metadata?.comfyArtifact?.workflowNodeId===c);
              if(!video||!d.document.connections.some(e=>e.fromNodeId===c&&e.toNodeId===video.id))return false;
              const m=video.metadata,a=m.comfyArtifact;
              if(!/^cas:[a-f0-9]{64}$/.test(m.storageKey)||!a.runId||!a.artifactId)return false;
              const rr=await fetch('/api/v1/jobs/'+a.runId+'/materializations');const mm=await rr.json();
              if(!mm.materializations?.some(x=>x.artifact_id===a.artifactId&&x.status==='materialized'&&x.node_id===video.id))return false;
              const resp=await fetch('/api/v1/blobs/'+m.storageKey.slice(4));const bytes=(await resp.arrayBuffer()).byteLength;
              return resp.ok&&bytes>0?{configId:c,jobId:a.runId,artifactId:a.artifactId,videoNodeId:video.id,bytes,mime:resp.headers.get('content-type')}:false})()"""%(fixture["projectId"],json.dumps(config_id)),120)
            assert outcome["mime"].startswith("video/"),outcome
            print("P5_LIVE_COMFY_REPORT",json.dumps(outcome),flush=True)

        assert not page.exceptions,page.exceptions
        print("P5_BROWSER_REPORT",json.dumps({"assertions":passed,"metrics":metrics,"browserExceptions":page.exceptions,"isolation":"temporary SQLite/CAS; local test clip" if os.environ.get("ATELIER_DRAMA_P5_LIVE_COMFY")=="1" else "temporary SQLite/CAS; no generation","shots":200,"nodes":200},ensure_ascii=False),flush=True)
    except Exception:
        if page:
            try:print("P5_BROWSER_DIAGNOSTIC",page.text()[-3000:],page.js("window.p5Notices||[]"),[r for r in page.network_requests if r["method"]=="POST"][-8:],flush=True)
            except Exception:pass
        for log in logs:
            try:log.flush();print(Path(log.name).name,Path(log.name).read_text("utf-8",errors="replace")[-1800:],flush=True)
            except Exception:pass
        raise
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for p in reversed(processes):
            try:perf.kill_tree(p)
            except Exception:pass
        for log in logs:log.close()
        shutil.rmtree(root,ignore_errors=True);shutil.rmtree(profile,ignore_errors=True)
if __name__=="__main__":run()
