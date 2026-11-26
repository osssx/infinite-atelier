"""Story S1/S2/S3/S4 real Chrome, isolated SQLite and deterministic model-stub regression."""
from __future__ import annotations
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
spec=importlib.util.spec_from_file_location("story_browser",ROOT/"scripts/drama-p1-chrome-e2e.py")
p1=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=p1
spec.loader.exec_module(p1)

def run():
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-drama-p1-browser-"))
    profile=root.parent/(root.name+"-chrome-profile")
    backend_port,front_port,chrome_port=p1.port(),p1.port(),p1.port()
    env=dict(os.environ,ATELIER_DRAMA_P1_BROWSER_E2E="1",ATELIER_P34B_BROWSER_E2E="1",ATELIER_DRAMA_STORY_AI_E2E="1",ATELIER_DRAMA_STORY_HISTORY_E2E="1",ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port))
    processes=[];logs=[];page=None;passed=[]
    portal='[data-creative-workspace-node-id="story"]'
    card='[data-node-id="story"]'
    field=portal+' [data-story-textarea]'
    def q(value):return json.dumps(value,ensure_ascii=False)
    def launch(name,args):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace");logs.append(log)
        processes.append(subprocess.Popen(args,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT))
    def check(name,expr,timeout=25):
        p1.wait_for(lambda:page.js(expr),name,timeout)
        passed.append(name);print("STORY_BROWSER_ASSERT",name,flush=True)
    def click(selector):
        check("click "+selector,"(()=>{const el=document.querySelector(%s);if(!el||el.disabled)return false;el.click();return true})()"%q(selector))
    def button(label,scope=portal):
        check("click "+label,"(()=>{const el=[...(document.querySelector(%s)?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()===%s);if(!el||el.disabled)return false;el.click();return true})()"%(q(scope),q(label)))
    def write(selector,text):
        check("write "+selector,"(()=>{const el=document.querySelector(%s);if(!el||el.readOnly||el.disabled)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,%s);el.dispatchEvent(new Event('input',{bubbles:true}));return true})()"%(q(selector),q(text)))
    def meta():
        result=p1.graph(page,fixture["projectId"])
        metadata=p1.find_node(result["data"],"story")["metadata"]
        if "dramaDraft" not in metadata:
            payload=page.js("(async()=>{const r=await fetch('/api/v1/projects/%s/drama-pipeline/payload?nodeId=story');return (await r.json()).payload})()"%fixture["projectId"])
            return dict(metadata,**payload)
        return metadata
    def backend(name,predicate):
        p1.wait_for(lambda:predicate(meta()),name,25)
        passed.append(name);print("STORY_BROWSER_ASSERT",name,flush=True)
    def pending_modal_button(label):
        check("pending "+label,"(()=>{const modals=[...document.querySelectorAll('.ant-modal')];const modal=modals.find(m=>m.textContent.includes('存在未提交的草案修改'));const b=[...(modal?.querySelectorAll('button')||[])].find(x=>x.textContent.trim()===%s);if(!b||b.disabled)return false;b.click();return true})()"%q(label))
    def select_range(start,end):
        check("select story range %d:%d"%(start,end),"(()=>{const el=document.querySelector(%s);if(!el)return false;el.focus();el.setSelectionRange(%d,%d);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true})()"%(q(field),start,end))
    def candidate_modal_button(label):
        check("candidate exit "+label,"(()=>{const section=document.querySelector('[data-story-candidate-exit]');const b=[...(section?.querySelectorAll('button')||[])].find(x=>x.textContent.trim()===%s);if(!b||b.disabled)return false;b.click();return true})()"%q(label))
    try:
        launch("backend",["node","scripts/drama-p1-browser-fixture.mjs"])
        fixture=p1.wait_for(lambda:json.loads((root/"p1-fixture.json").read_text("utf-8")) if (root/"p1-fixture.json").exists() else None,"fixture",45)
        front=f"http://127.0.0.1:{front_port}"
        launch("static",["node","scripts/drama-p34b-static-frontend.mjs","--port",str(front_port),"--backend",fixture["backendOrigin"],"--dist",str(ROOT/"dist")])
        p1.wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"frontend",30)
        launch("chrome",[str(p1.cdp.CHROME),"--headless=new","--no-first-run","--no-default-browser-check",
         f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",f"--user-data-dir={profile}","--window-size=1440,900","about:blank"])
        p1.wait_for(lambda:p1.http_json(f"http://127.0.0.1:{chrome_port}/json/version"),"Chrome CDP",35)
        page=p1.ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",{"width":1440,"height":900,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        check("summary without editing controls","(()=>{const root=document.querySelector(%s);return !!root?.querySelector('[data-story-inline-summary]')&&!root.querySelector('textarea,select,input,details')})()" %q(card),55)
        original=meta()["dramaConfirmed"]
        check("actual confirmed text in canvas summary","document.querySelector("+q(card+" [data-story-inline-summary]")+")?.textContent.includes("+q(original[:40])+")")
        click(card+" [data-story-inline-summary]")
        check("story starts read-only with AI collapsed","(()=>{const r=document.querySelector(%s);return r?.querySelector('[data-story-textarea]')?.readOnly&&!r.querySelector('[aria-label=\"故事 AI 创作\"]')&&r.querySelectorAll('[data-story-confirm-version]').length===1})()"%q(portal))
        click(portal+' [aria-label="编辑故事正文"]')
        write(field,"浏览器故事草案\n第二段")
        check("dirty registered","!!document.querySelector("+q(portal+" [data-drama-pending-status]")+")")
        assert meta()["dramaDraft"]==original,"typing must not update the persisted graph"
        button("美术设定")
        pending_modal_button("继续编辑")
        check("continue editing keeps draft","document.querySelector("+q(field)+")?.value===" + q("浏览器故事草案\n第二段"))
        button("美术设定")
        pending_modal_button("保存草案")
        check("settings after successful durable save","!!document.querySelector("+q(portal+" [data-story-art-panel]")+")")
        backend("story draft saved, published version unchanged",lambda m:m["dramaDraft"]=="浏览器故事草案\n第二段" and m["content"]==m["dramaDraft"] and m["dramaConfirmed"]==original)
        check("art fields are read-only","!document.querySelector("+q(portal+" [data-story-art-panel] textarea, "+portal+" [data-story-art-panel] select")+")")
        click(portal+' [aria-label="编辑影片风格"]')
        write(portal+' [aria-label="影片风格"]',"水彩故事风格")
        button("保存并确认故事版本")
        backend("confirmed body and art persisted together",lambda m:m["dramaConfirmed"]=="浏览器故事草案\n第二段" and m.get("dramaConfirmedVisual",{}).get("visualStyle")=="水彩故事风格")
        check("header confirmed","document.querySelector("+q('[data-drama-workspace-version-status]')+")?.textContent==='已确认'")
        confirmed_id=meta()["dramaConfirmedVersionId"]
        click(portal+' [aria-label="编辑视频比例"]')
        check("select ratio","(()=>{const s=document.querySelector(%s);if(!s)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'9:16');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()"%q(portal+' [aria-label="视频比例"]'))
        click(portal+' [aria-label="保存视频比例"]')
        backend("ratio persisted without changing confirmed revision",lambda m:m.get("videoRatio")=="9:16" and m["dramaConfirmedVisual"]["visualStyle"]=="水彩故事风格" and m["dramaConfirmedVersionId"]==confirmed_id)
        check("ratio does not dirty the version","document.querySelector("+q('[data-drama-workspace-version-status]')+")?.textContent==='已确认'")
        button("故事正文")
        click(portal+' [aria-label="编辑故事正文"]')
        write(field,"不要保存的正文")
        button("影响与历史")
        pending_modal_button("放弃修改")
        check("history mounted","!!document.querySelector("+q(portal+" [data-drama-history-layout]")+")")
        check("confirmed paragraphs history entry","!!document.querySelector("+q(portal+" [data-story-history-summary]")+")")
        click(portal+" [data-story-history-summary] button[aria-expanded]")
        check("confirmed paragraphs use readable labels","document.querySelector("+q(portal+" [data-story-history-summary]")+")?.textContent.includes('第 1 段')")
        backend("discard keeps saved story",lambda m:m["dramaDraft"]=="浏览器故事草案\n第二段")
        current_theme=page.js("document.querySelector("+q(portal)+")?.dataset.dramaWorkspaceTheme")
        click(".ant-modal-close")
        check("workspace closed","!document.querySelector("+q(portal)+")")
        check("updated real canvas summary","document.querySelector("+q(card+" [data-story-inline-summary]")+")?.textContent.includes('浏览器故事草案')")
        # Toggle via the existing canvas theme control, then check the workspace token.
        check("alternate canvas theme","(()=>{const b=[...document.querySelectorAll('button')].find(x=>['切换到浅色主题','切换到深色主题','Switch to light theme','Switch to dark theme'].includes(x.getAttribute('aria-label')));if(!b)return false;b.click();return true})()")
        click(card+" [data-story-inline-summary]")
        check("reopened draft matches saved content","document.querySelector("+q(field)+")?.readOnly&&document.querySelector("+q(field)+")?.value==="+q("浏览器故事草案\n第二段"))
        check("workspace switched theme","document.querySelector("+q(portal)+")?.dataset.dramaWorkspaceTheme==="+q("light" if current_theme=="dark" else "dark"))
        page.call("Emulation.setDeviceMetricsOverride",{"width":1024,"height":768,"deviceScaleFactor":1.25,"mobile":False})
        check("narrow workspace remains contained","(()=>{const r=document.querySelector(%s);return r&&r.getBoundingClientRect().right<=innerWidth&&r.querySelector('[data-story-textarea]').clientHeight>0})()"%q(portal))
        # S3: isolated assistantChat stub, but actual HTTP, model routing, UI and SQLite.
        saved="浏览器故事草案\n第二段"
        revised="浏览器人工确认候选\n第二段"
        button("AI 创作");select_range(3,7);button("润色")
        check("selected polish range","document.querySelector("+q(portal+" [data-story-ai-scope]")+")?.textContent.includes('4–7')")
        check("narrow AI layout stays within the workspace","(()=>{const w=document.querySelector(%s);const a=w.querySelector('[aria-label=\"故事 AI 创作\"]');return a&&a.clientWidth>0&&a.scrollWidth<=a.clientWidth+2&&a.getBoundingClientRect().right<=innerWidth})()"%q(portal))
        button("生成候选")
        check("running AI blocks tab and version confirmation","(()=>{const r=document.querySelector(%s);return r.textContent.includes('AI 生成中')&&r.querySelector('nav button').disabled&&r.querySelector('[data-story-confirm-version]').disabled})()"%q(portal))
        check("selection original and candidate","(()=>{const r=document.querySelector('[data-story-ai-candidate]');return r?.querySelector('[data-story-candidate-original]').textContent==='故事草案'&&r.querySelector('[data-story-candidate-text]').textContent==='润色候选'&&!r.querySelector('textarea')})()")
        assert meta()["dramaDraft"]==saved and meta()["dramaConfirmed"]==saved
        click(portal+' [aria-label="编辑 AI 候选"]')
        write(portal+' [data-story-candidate-edit]',"不采用的候选")
        click(portal+' [aria-label="AI 候选操作"] [data-drama-action="cancel"]')
        check("candidate cancel retains generated text","document.querySelector('[data-story-candidate-text]')?.textContent==='润色候选'")
        click(portal+' [aria-label="编辑 AI 候选"]')
        write(portal+' [data-story-candidate-edit]',"人工确认候选")
        click(portal+' [aria-label="确认AI 候选"]')
        check("candidate confirm is local only","document.querySelector('[data-story-candidate-text]')?.textContent==='人工确认候选'")
        assert meta()["dramaDraft"]==saved
        button("美术设定");candidate_modal_button("继续查看")
        check("candidate retained after leaving guard is cancelled","!!document.querySelector('[data-story-ai-candidate]')")
        button("美术设定");candidate_modal_button("采用到草案")
        check("candidate adopted locally before separate save","document.querySelector("+q(field)+")?.value==="+q(revised)+"&&!document.querySelector('[data-story-ai-candidate]')")
        assert meta()["dramaDraft"]==saved
        pending_modal_button("保存草案")
        check("second navigation decision leaves editor after save","!!document.querySelector("+q(portal+" [data-story-art-panel]")+")")
        backend("adoption persists draft only after explicit save",lambda m:m["dramaDraft"]==revised and m["dramaConfirmed"]==saved and m["dramaConfirmedVersionId"]==confirmed_id)
        button("故事正文");button("AI 创作")
        select_range(revised.index("\n")+1,revised.index("\n")+1);button("当前光标");button("生成候选")
        check("insertion preview is explicit","document.querySelector('[data-story-candidate-original]')?.textContent.includes('在此插入续写')")
        button("收起 AI 创作");button("继续查看")
        check("collapse guard retains candidate","!!document.querySelector('[data-story-ai-candidate]')")
        button("收起 AI 创作");button("舍弃候选")
        check("explicit discard collapses panel","!document.querySelector('[aria-label=\"故事 AI 创作\"]')")
        assert meta()["dramaDraft"]==revised
        button("AI 创作");button("改写");button("生成候选")
        check("full rewrite preview","document.querySelector('[data-story-candidate-original]')?.textContent==="+q(revised))
        click(portal+' [aria-label="编辑故事正文"]');write(field,"用户自己的更新")
        check("stale candidate disables adoption","(()=>{const c=document.querySelector('[data-story-ai-candidate]');return c?.textContent.includes('已过期')&&[...c.querySelectorAll('button')].find(b=>b.textContent==='采用到草案').disabled})()")
        button("美术设定")
        check("stale candidate cannot be adopted from exit guard","[...document.querySelectorAll('[data-story-candidate-exit] button')].find(b=>b.textContent==='采用到草案')?.disabled===true")
        candidate_modal_button("舍弃候选")
        pending_modal_button("继续编辑")
        check("discarding candidate does not discard user draft","document.querySelector("+q(field)+")?.value==='用户自己的更新'&&!document.querySelector('[data-story-ai-candidate]')")
        button("生成候选")
        check("request in progress","document.querySelector("+q(portal)+")?.textContent.includes('AI 生成中')")
        button("停止等待");time.sleep(1.2)
        check("late response ignored after stop","!document.querySelector('[data-story-ai-candidate]')&&document.querySelector("+q(field)+")?.value==='用户自己的更新'")
        assert meta()["dramaDraft"]==revised and meta()["dramaConfirmed"]==saved

        # S4: actual graph source + recorded dependencies, isolated history backup and restore.
        original_meta=meta()
        def downstream():
            data=p1.graph(page,fixture["projectId"])["data"]
            return {key:p1.find_node(data,key)["metadata"] for key in ("assets","episodes","board")}
        downstream_before=downstream()
        check("one compact source row without mutation controller in story editor","(()=>{const r=document.querySelector("+q(portal)+");return r?.querySelectorAll('[data-story-source-status]').length===1&&r.textContent.includes('上游剧本')&&!r.querySelector('[data-story-upstream-panel]')})()")
        button("查看来源");pending_modal_button("放弃修改")
        check("single history source controller","document.querySelectorAll("+q(portal+" [data-story-upstream-panel]")+").length===1")
        check("actual direct assets and episodes need review, no indirect board","(()=>{const el=document.querySelector('[data-story-direct-downstream]');return el?.querySelectorAll('li').length===2&&el.querySelectorAll('[data-story-downstream-status=review]').length===2&&el.textContent.includes('资产规划')&&el.textContent.includes('剧集规划')&&!el.textContent.includes('分镜配置')})()")
        button("追加预览")
        check("exact append preview, not persisted","document.querySelector('[aria-label=\"追加草案预览\"]')?.value==="+q(revised+"\n\n上游原稿全文"))
        assert meta()["dramaDraft"]==revised
        button("取消");button("替换预览")
        check("frozen old draft and source","document.querySelector('[aria-label=\"当前故事对比正文\"]')?.value==="+q(revised)+"&&document.querySelector('[aria-label=\"上游文本对比正文\"]')?.value==='上游原稿全文'")
        button("用上游替换当前草案")
        def confirmation_unchanged(m):
            return all(m.get(key)==original_meta.get(key) for key in ("dramaConfirmed","dramaConfirmedVersionId","dramaConfirmedVisual","dramaSourceParagraphs","visualStyle","artDirection","videoRatio"))
        backend("source replacement preserves confirmed story, provenance and art",lambda m:m["dramaDraft"]=="上游原稿全文" and m["content"]==m["dramaDraft"] and m.get("dramaTextSourceSync",{}).get("edgeId")=="history-story-link" and confirmation_unchanged(m))
        assert downstream()==downstream_before
        check("replacement shows updated source sync status","document.querySelector('[data-story-upstream-panel]')?.textContent.includes('上游已同步')&&!document.querySelector('[data-story-upstream-compare]')")
        click(portal+' [aria-label="同步新上游文本前的故事草案"]')
        check("actual recovery backup is available in saved version preview","document.querySelector('[data-canvas-text-versions-inline] pre')?.textContent==="+q(revised))
        click(portal+' [aria-label="恢复为草案"]')
        check("restore asks to protect the unbacked current draft","(()=>{const b=[...document.querySelectorAll('.ant-modal button')].find(b=>b.textContent.trim()==='备份后恢复');if(!b||b.disabled)return false;b.click();return true})()")
        backend("history restore changes only the story draft, not confirmation, art or source mapping",lambda m:m["dramaDraft"]==revised and m["content"]==revised and confirmation_unchanged(m) and m.get("dramaTextSourceSync",{}).get("edgeId")=="history-story-link")
        assert downstream()==downstream_before
        check("restore reports draft edited and downstream still pending review","document.querySelector('[data-story-upstream-panel]')?.textContent.includes('草案已编辑')&&document.querySelectorAll('[data-story-downstream-status=review]').length===2")
        button("故事正文")
        check("restored text appears in read-only editor","document.querySelector("+q(field)+")?.value==="+q(revised)+"&&document.querySelector("+q(field)+")?.readOnly")

        # S5: cross the shared workspace boundary in the same real project.
        # The old monolithic P1 script still expects an obsolete asset canvas browser;
        # exercise the modern episode editor directly without skipping its actual UI.
        episode='[data-creative-workspace-node-id="episodes"]'
        episode_card='[data-node-id="episodes"]'
        synopsis=episode+' [data-episode-editable-field="synopsis"]'
        click(".ant-modal-close")
        check("story closed before episode workspace opens","!document.querySelector("+q(portal)+")")
        page.call("Emulation.setDeviceMetricsOverride",{"width":1440,"height":900,"deviceScaleFactor":1.25,"mobile":False})
        button("打开完整编辑器 ↗",episode_card)
        check("episode has independent active editor and no story pending state","(()=>{const r=document.querySelector("+q(episode)+");return r?.querySelector('nav button[aria-pressed=true]')?.textContent.trim()==='剧集编辑'&&!r.querySelector('[data-story-textarea],[data-drama-pending-status]')&&!document.querySelector("+q(portal)+")})()")
        check("episode split editor is still read-only and themed","(()=>{const r=document.querySelector("+q(episode)+"),ed=r?.querySelector('[aria-label=\"当前剧集编辑区\"]');return ['dark','light'].includes(r?.dataset.dramaWorkspaceTheme)&&!!r.querySelector('[data-episode-editor-layout=expanded] [aria-label=\"剧集导航\"]')&&ed?.querySelectorAll('[data-episode-editable-field][data-episode-field-mode=reading]').length===5&&!ed.querySelector('textarea')})()")
        click(synopsis+' [aria-label="编辑剧情梗概"]')
        write(synopsis+' textarea[aria-label="剧情梗概"]',"S5 临时剧集草稿，不保存")
        check("episode local edit remains staged without reactivating story pending state","document.querySelector("+q(synopsis)+")?.dataset.episodeFieldMode==='editing'&&document.querySelector("+q(synopsis+" textarea")+")?.value==="+q("S5 临时剧集草稿，不保存")+"&&!document.querySelector("+q(portal)+")")
        assert downstream()==downstream_before
        click(synopsis+' [data-episode-action="cancel"]')
        check("episode cancel restores read-only synopsis","document.querySelector("+q(synopsis)+")?.dataset.episodeFieldMode==='reading'&&!document.querySelector("+q(synopsis+" textarea")+")")
        button("影响与历史",episode)
        check("episode history uses its own version layout, not story history","(()=>{const r=document.querySelector("+q(episode)+");return !!r?.querySelector('[data-drama-history-layout] [data-canvas-text-versions-inline]')&&!r.querySelector('[data-story-history-summary],[data-story-upstream-panel]')})()")
        button("剧集编辑",episode)
        check("episode history unmounted on return","!document.querySelector("+q(episode+" [data-drama-history-layout]")+")")
        click(".ant-modal-close")
        check("episode workspace closed before story reopens","!document.querySelector("+q(episode)+")")
        click(card+" [data-story-inline-summary]")
        check("story reopens with restored draft and no episode state","document.querySelector("+q(field)+")?.readOnly&&document.querySelector("+q(field)+")?.value==="+q(revised)+"&&!document.querySelector("+q(episode)+")")
        assert downstream()==downstream_before and confirmation_unchanged(meta())
        click(".ant-modal-close")
        check("all workspaces closed","!document.querySelector('[data-creative-workspace-node-id]')")

        assert not page.exceptions,page.exceptions
        print("STORY_BROWSER_REPORT",json.dumps({"passed":len(passed),"browserExceptions":page.exceptions,"isolation":"temporary SQLite/CAS; in-process deterministic assistantChat stub; no external model calls"},ensure_ascii=False),flush=True)
    except Exception:
        for log in logs:log.flush()
        for filename in ("backend.log","static.log","chrome.log"):
            file=root/filename
            if file.exists():print(filename,file.read_text("utf-8",errors="replace")[-4000:],flush=True)
        if page:
            print("STORY_BROWSER_DIAGNOSTIC",page.js("document.body.innerText.slice(-3500)"),flush=True)
        raise
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for proc in reversed(processes):
            try:p1.kill_tree(proc)
            except Exception:pass
        for log in logs:log.close()
        shutil.rmtree(root,ignore_errors=True);shutil.rmtree(profile,ignore_errors=True)

if __name__=="__main__":run()
