"""Actual Chrome feedback smoke using the isolated P1 fixture (deterministic model, no paid calls).
Checks current workspace entry points rather than historical inline editor selectors.
"""
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
spec=importlib.util.spec_from_file_location("drama_p1",ROOT/"scripts/drama-p1-chrome-e2e.py")
p1=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=p1
spec.loader.exec_module(p1)

def run():
    root=Path(tempfile.mkdtemp(prefix="infinite-atelier-drama-p1-browser-"))
    profile=root.parent/(root.name+"-chrome-profile")
    backend_port,front_port,chrome_port=p1.port(),p1.port(),p1.port()
    env=dict(os.environ,ATELIER_DATA_DIR=str(root),ATELIER_BACKEND_PORT=str(backend_port),
             ATELIER_DRAMA_P1_BROWSER_E2E="1",ATELIER_DRAMA_FEEDBACK_E2E="1")
    processes=[];logs=[];page=None;passed=[]
    def launch(name,args,e=env):
        log=open(root/(name+".log"),"w",encoding="utf-8",errors="replace");logs.append(log)
        p=subprocess.Popen(args,cwd=ROOT,env=e,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
        processes.append(p)
    def check(name,expr,timeout=20):
        value=p1.wait_for(lambda:page.js(expr),name,timeout)
        passed.append(name);print("FEEDBACK_BROWSER_ASSERT",name,flush=True);return value
    def click(label,scope):
        check("click "+label,"(()=>{const b=[...(document.querySelector(%s)?.querySelectorAll('button')||[])].find(b=>b.textContent.trim()===%s&&!b.disabled&&b.getClientRects().length);if(!b)return false;b.click();return true})()"%(json.dumps(scope),json.dumps(label,ensure_ascii=False)))
    def click_selector(name,selector):
        check(name,"(()=>{const b=document.querySelector(%s);if(!b||b.disabled||!b.getClientRects().length)return false;b.click();return true})()"%json.dumps(selector,ensure_ascii=False))
    def type_value(name,selector,value):
        check(name,"(()=>{const e=document.querySelector(%s);if(!e||e.disabled)return false;Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,%s);e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"%(json.dumps(selector,ensure_ascii=False),json.dumps(value,ensure_ascii=False)))
    def close(portal):
        check("close workspace","(()=>{const b=document.querySelector('.ant-modal-close');if(!b||b.disabled)return false;b.click();return true})()")
        check("workspace and feedback unmounted","!document.querySelector("+json.dumps(portal)+")&&!document.querySelector('[data-drama-feedback-toasts],[data-drama-feedback-errors],[data-drama-task-status]')")
    try:
        launch("backend",["node","scripts/drama-p1-browser-fixture.mjs"])
        fixture=p1.wait_for(lambda:json.loads((root/"p1-fixture.json").read_text("utf-8")) if (root/"p1-fixture.json").exists() else None,"fixture",45)
        front=f"http://127.0.0.1:{front_port}"
        launch("vite",["node","node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",str(front_port),"--strictPort"],dict(env,ATELIER_BACKEND_URL=fixture["backendOrigin"]))
        p1.wait_for(lambda:urllib.request.urlopen(front,timeout=2).status==200,"frontend",45)
        launch("chrome",[str(p1.cdp.CHROME),"--headless=new","--no-first-run","--no-default-browser-check",f"--remote-debugging-port={chrome_port}","--remote-allow-origins=*",f"--user-data-dir={profile}","--window-size=1720,1050","about:blank"])
        p1.wait_for(lambda:p1.http_json(f"http://127.0.0.1:{chrome_port}/json/version"),"Chrome CDP",35)
        page=p1.ChromeCDP(chrome_port)
        page.call("Emulation.setDeviceMetricsOverride",{"width":1720,"height":1050,"deviceScaleFactor":1.25,"mobile":False})
        page.call("Page.navigate",{"url":front+"/canvas/"+fixture["projectId"]})
        check("canvas ready","document.querySelectorAll('[data-drama-summary-kind]').length>=3",65)
        for node,label,appearance in (("assets","资产","dark"),("episodes","剧集","light"),("board","分镜","dark")):
            card='[data-node-id="'+node+'"]'
            portal='[data-creative-workspace-node-id="'+node+'"]'
            current=page.js("document.querySelector("+json.dumps(card+" [data-drama-summary-kind]")+")?.dataset.dramaCardTheme")
            if current!=appearance:
                theme="切换到浅色主题" if appearance=="light" else "切换到深色主题"
                check("switch theme "+appearance,"(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===%s);if(!b)return false;b.click();return true})()"%json.dumps(theme,ensure_ascii=False))
            click("打开完整编辑器 ↗",card)
            check("workspace "+node+" "+appearance,"document.querySelector("+json.dumps(portal)+")?.dataset.dramaWorkspaceTheme==="+json.dumps(appearance))
            check("no inherited feedback "+node,"!document.querySelector('[data-drama-feedback-toasts],[data-drama-feedback-errors],[data-drama-task-status]')")
            if node=="board":
                check("select second episode","(()=>{const s=document.querySelector("+json.dumps(portal+' select[aria-label="选择分镜剧集"]',ensure_ascii=False)+");if(!s||s.disabled||!Array.from(s.options).some(o=>o.value==='ep-two'))return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'ep-two');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            if node=="episodes":
                check("select complete episode plan","(()=>{const s=document.querySelector("+json.dumps(portal+' select[aria-label="剧集规划生成范围"]',ensure_ascii=False)+");if(!s||s.disabled)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'');s.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            click("生成"+label+"候选",portal)
            check("running task "+node,"!!document.querySelector('[data-drama-task-status]')")
            check("success toast themed "+node,"""(()=>{const r=document.querySelector(%s),t=r?.querySelector('[data-drama-feedback="success"]'),layer=r?.querySelector('[data-drama-feedback-toasts]');if(!t||!layer)return false;const a=r.getBoundingClientRect(),b=t.getBoundingClientRect();return b.width>0&&b.right<=a.right&&b.left>=a.left&&b.top>=a.top&&b.bottom<=a.bottom&&getComputedStyle(layer).position==='absolute'&&getComputedStyle(t).backgroundColor===getComputedStyle(r.querySelector('[data-drama-workspace-content]')).backgroundColor})()"""%json.dumps(portal),30)
            check("automatic candidate tab "+node,"""(()=>{const r=document.querySelector(%s);return [...(r?.querySelectorAll('nav button[aria-pressed="true"]')||[])].some(b=>b.textContent.trim().startsWith('生成候选'))&&!document.querySelector('[data-drama-task-status]')})()"""%json.dumps(portal))
            if node=="assets":
                check("asset candidate visible","document.querySelector("+json.dumps(portal+" [data-asset-candidate-review]")+")?.textContent.includes('验收道具')")
            else:
                check("newest run automatically expanded "+node,"""(()=>{const r=document.querySelector(%s),d=r?.querySelector('[data-drama-run-scroll-region] > details[open]');return d?.querySelector('summary')?.textContent.includes('待采用')&&d.textContent.includes(%s)})()"""%(json.dumps(portal),json.dumps("验收候选" if node=="episodes" else "浏览器实际触发",ensure_ascii=False)))
            if node=="episodes":
                candidate=portal+" [data-episode-candidate-editor]"
                pid=fixture["projectId"]
                before=p1.graph(page,pid)["data"]
                original_meta=p1.find_node(before,"episodes")["metadata"]
                old_draft=json.loads(original_meta["dramaDraft"])["episodes"]
                old_confirmed=original_meta["dramaConfirmed"]
                run_id=page.js("document.querySelector("+json.dumps(candidate)+").dataset.episodeCandidateEditor")
                check("candidate two episodes","document.querySelector("+json.dumps(candidate)+")?.textContent.includes('当前候选 2 集')")
                click_selector("edit candidate synopsis",candidate+' button[aria-label="编辑剧情梗概"]')
                type_value("type local candidate synopsis",candidate+' textarea[aria-label="剧情梗概"]',"浏览器人工修订梗概")
                check("candidate navigation locked during editing","""(()=>{const r=document.querySelector(%s),d=r?.closest('details');return [...r.querySelectorAll('[aria-label^="选择候选第"]')].every(b=>b.disabled)&&[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='采用到草案')?.disabled})()"""%json.dumps(candidate))
                ai_input=candidate+' textarea[aria-label="剧情梗概"]'
                check("select unsaved candidate substring","(()=>{const e=document.querySelector(%s);if(!e)return false;e.focus();e.setSelectionRange(3,7);return e.value.slice(e.selectionStart,e.selectionEnd)==='人工修订'})()"%json.dumps(ai_input,ensure_ascii=False))
                click("AI 优化",candidate)
                check("AI selection mode","""document.querySelector(%s)?.querySelector('[data-episode-ai-optimize] button[aria-pressed="true"]')?.textContent.trim()==='选区改写'"""%json.dumps(candidate))
                type_value("AI custom instructions",candidate+' textarea[aria-label="候选 AI 修改意见"]',"增强悬念，保持前后文")
                click("生成优化建议",candidate)
                check("AI before and after preview","""(()=>{const r=document.querySelector(%s),p=r?.querySelector('[data-episode-ai-preview]');return p?.textContent.includes('浏览器人工修订梗概')&&p.textContent.includes('浏览器增强悬念梗概')&&r.querySelector('textarea[aria-label="剧情梗概"]')?.value==='浏览器人工修订梗概'&&r.querySelector('button[aria-label="保存候选剧情梗概"]')?.disabled})()"""%json.dumps(candidate))
                run_url="/api/v1/projects/"+pid+"/drama-pipeline/runs/"+run_id
                def saved_candidate():
                    return page.js("(async()=>await (await fetch(%s,{credentials:'same-origin',cache:'no-store'})).json())()"%json.dumps(run_url))
                original_candidate=saved_candidate()["candidate"]
                assert original_candidate["revision"]==0 and original_candidate["episodes"][0]["synopsis"]=="剧情梗概 · 验收候选"
                passed.append("AI preview no candidate write")
                click("放弃建议",candidate)
                check("AI discarded preserves manual input","document.querySelector(%s)?.value==='浏览器人工修订梗概'&&!document.querySelector('[data-episode-ai-preview]')"%json.dumps(ai_input,ensure_ascii=False))
                click("生成优化建议",candidate)
                check("AI regenerated","document.querySelector('[data-episode-ai-preview]')?.textContent.includes('浏览器增强悬念梗概')")
                click("应用到编辑内容",candidate)
                check("AI applied only to local buffer","document.querySelector(%s)?.value==='浏览器增强悬念梗概'&&!document.querySelector('[data-episode-ai-preview]')"%json.dumps(ai_input,ensure_ascii=False))
                assert saved_candidate()["candidate"]==original_candidate
                passed.append("AI apply no candidate write")
                click_selector("save candidate synopsis",candidate+' button[aria-label="保存候选剧情梗概"]')
                check("candidate saved and modified","document.querySelector("+json.dumps(candidate)+")?.textContent.includes('浏览器增强悬念梗概')&&document.querySelector("+json.dumps(candidate)+")?.textContent.includes('已手动修改')&&!document.querySelector('[data-drama-task-status]')")
                click_selector("select second candidate",candidate+' button[aria-label^="选择候选第 2 集"]')
                click("删除本集",candidate)
                click("确认删除候选",candidate)
                check("candidate now one episode","""(()=>{const r=document.querySelector(%s);return r?.textContent.includes('当前候选 1 集')&&r.querySelector('button[aria-label^="删除候选剧集"]')?.disabled&&!document.querySelector('[data-drama-task-status]')})()"""%json.dumps(candidate))
                after=p1.graph(page,pid)["data"]
                assert after["revision"]==before["revision"],("candidate altered graph revision",before["revision"],after["revision"])
                assert p1.find_node(after,"episodes")["metadata"]["dramaDraft"]==original_meta["dramaDraft"]
                assert p1.find_node(after,"episodes")["metadata"]["dramaConfirmed"]==old_confirmed
                passed.append("candidate only writes")
                close(portal)
                click("打开完整编辑器 ↗",card)
                click("生成候选",portal)
                click_selector("reopen persisted episode candidate",portal+" [data-drama-run-scroll-region] > details > summary")
                check("saved candidate restored","document.querySelector("+json.dumps(candidate)+")?.textContent.includes('浏览器增强悬念梗概')&&document.querySelector("+json.dumps(candidate)+")?.textContent.includes('当前候选 1 集')")
                click("采用到草案",portal)
                check("adopted persisted candidate","document.querySelector("+json.dumps(portal+" [data-drama-run-scroll-region] > details > summary")+")?.textContent.includes('已采用')&&!document.querySelector('[data-drama-task-status]')")
                adopted=p1.graph(page,pid)["data"]
                new_meta=p1.find_node(adopted,"episodes")["metadata"]
                adopted_draft=json.loads(new_meta["dramaDraft"])["episodes"]
                assert adopted_draft[0]["synopsis"]=="浏览器增强悬念梗概" and adopted_draft[1]==old_draft[1]
                assert new_meta["dramaConfirmed"]==old_confirmed
                passed.append("adoption preserved excluded draft episode and confirmation")
                click("剧集编辑",portal)
                click("生成剧集候选",portal)
                check("second candidate ready","(()=>{const r=document.querySelector(%s),d=r?.querySelector('[data-drama-run-scroll-region] > details[open]');return d?.querySelector('[data-episode-candidate-editor]')?.dataset.episodeCandidateEditor!==%s&&d?.querySelector('summary')?.textContent.includes('待采用')&&!document.querySelector('[data-drama-task-status]')})()"%(json.dumps(portal),json.dumps(run_id)))
                active_candidate=portal+" [data-drama-run-scroll-region] > details[open] [data-episode-candidate-editor]"
                click("删除生成记录",active_candidate)
                click("确认删除候选",active_candidate)
                check("discarded run removed","document.querySelectorAll("+json.dumps(portal+" [data-drama-run-scroll-region] > details")+").length===1&&!document.querySelector('[data-drama-task-status]')")
            close(portal)
        before=len([r for r in page.network_requests if "/drama-pipeline/runs" in r.get("path","")])
        time.sleep(3.4)
        after=len([r for r in page.network_requests if "/drama-pipeline/runs" in r.get("path","")])
        assert after==before,("polling after close",before,after)
        passed.append("no run polling after close")
        assert not page.exceptions,page.exceptions
        print("FEEDBACK_BROWSER_REPORT",json.dumps({"assertions":passed,"browserExceptions":page.exceptions,"providerPosts":0},ensure_ascii=False),flush=True)
    except Exception:
        if page:
            try:print("FEEDBACK_BROWSER_DIAGNOSTIC",page.text()[-2500:],flush=True)
            except Exception:pass
        for log in logs:
            try:log.flush();print(Path(log.name).name,Path(log.name).read_text("utf-8",errors="replace")[-1200:],flush=True)
            except Exception:pass
        raise
    finally:
        if page:
            try:page.close()
            except Exception:pass
        for p in reversed(processes):
            try:p1.kill_tree(p)
            except Exception:pass
        for log in logs:log.close()
        shutil.rmtree(root,ignore_errors=True);shutil.rmtree(profile,ignore_errors=True)

if __name__=="__main__":run()
