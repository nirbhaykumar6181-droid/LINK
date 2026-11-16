import os, sys, tempfile, io, base64, time
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from harness import *
from PIL import Image
port=32200; room='room_theme_0001'; room2='room_theme_0002'
d=tempfile.mkdtemp(); srv=start(d,port,ROOT); ping(port,room); ping(port,room2)
# a recognisable red/blue test photo
im=Image.new('RGB',(900,1400),(200,30,60)); 
for x in range(450,900):
    for y in range(0,1400,1): im.putpixel((x,y),(30,60,200))
im.save('' + os.path.join(os.path.dirname(os.path.abspath(__file__)),'bg-test.jpg') + '',quality=90)
def st(uid,name,rooms):
    s={'me':{'id':uid,'name':name,'color':'#2f5bea','user':name.lower()},'theme':'light','rooms':{},'archived':{}}
    for r in rooms: s['rooms'][r]={'id':r,'key':KEY,'name':'Chat '+r[-1],'msgs':[],'seq':0,'unread':0,'peers':{}}
    return f"if(!localStorage.link)localStorage.link={json.dumps(json.dumps(s))};"
ok=True
def check(c,msg):
    global ok
    print(('PASS ' if c else 'FAIL ')+msg); ok&=bool(c)
try:
  with sync_playwright() as p:
    b=p.chromium.launch()
    def mk(uid,name):
        ctx=b.new_context(viewport={'width':390,'height':780}); ctx.add_init_script(st(uid,name,[room,room2])); pg=ctx.new_page()
        errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.goto(f'http://127.0.0.1:{port}/'); pg.wait_for_timeout(700); return ctx,pg,errs
    cA,A,eA=mk('uAlice','Alice'); cB,B,eB=mk('uBobby','Bob')
    bgof=lambda pg:pg.evaluate("document.querySelector('#chat').style.background")
    def opn(pg,r): pg.evaluate(f"open('{r}')"); pg.wait_for_timeout(500)
    for pg in (A,B): opn(pg,room)
    # --- TEST A: red theme from A reaches B
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]')
    A.click('#thsw i[data-k="c:#4a0f18"]'); A.click('#thsw >> nth=0') if False else None
    A.click('#tha'); A.wait_for_selector('#dTh:not([open])',state='attached',timeout=5000); B.wait_for_timeout(1200)
    check('rgb(74, 15, 24)' in bgof(A),'A sees dark red background: '+bgof(A)[:40])
    check('rgb(74, 15, 24)' in bgof(B),'B received dark red background: '+bgof(B)[:40])
    # --- gallery upload
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]')
    A.set_input_files('#thfi','' + os.path.join(os.path.dirname(os.path.abspath(__file__)),'bg-test.jpg') + ''); A.wait_for_selector('#thim',state='visible')
    A.fill('#thdim','10'); A.dispatch_event('#thdim','input')
    A.click('#tha'); A.wait_for_selector('#dTh:not([open])',state='attached',timeout=8000); B.wait_for_timeout(1800)
    check('url(' in bgof(A),'A shows gallery image')
    check('url(' in bgof(B),'B shows the uploaded gallery image (not just metadata)')
    def px(pg):
        png=pg.screenshot(); im=Image.open(io.BytesIO(png)).convert('RGB'); return im.getpixel((60,400)),im.getpixel((330,400))
    pa,pb=px(A),px(B); print('A left/right pixels',pa,' B',pb)
    check(pb[0][0]>pb[0][2] and pb[1][2]>pb[1][0],'B pixels are the red-left / blue-right photo, not a placeholder')
    check(not any('blob:' in x or 'data:' in x for x in [json.dumps(A.evaluate("JSON.parse(localStorage.link).rooms.%s.th"%room))]),'theme metadata holds no blob/base64 image')
    # --- reload persistence (both)
    A.reload(); B.reload(); A.wait_for_timeout(900); B.wait_for_timeout(900)
    for pg in (A,B): opn(pg,room); pg.wait_for_timeout(500)
    check('url(' in bgof(A) and 'url(' in bgof(B),'both devices keep the photo after refresh')
    # --- TEST B: room isolation
    for pg in (A,B): opn(pg,room2); pg.wait_for_timeout(300)
    check(bgof(A)=='' and bgof(B)=='', 'second chat unchanged (no theme leak): A=%r B=%r'%(bgof(A),bgof(B)))
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]'); A.click('#thsw i[data-k="c:#10305c"]'); A.click('#tha'); A.wait_for_selector('#dTh:not([open])',state='attached'); B.wait_for_timeout(1000)
    check('rgb(16, 48, 92)' in bgof(A),'chat 2 blue on A')
    opn(B,room2); check('rgb(16, 48, 92)' in bgof(B),'chat 2 blue on B')
    opn(A,room); opn(B,room); check('url(' in bgof(A) and 'url(' in bgof(B),'chat 1 still has its photo after changing chat 2')
    # --- global app theme independent
    check(A.evaluate("document.documentElement.classList.contains('dark')")==False,'global light theme untouched')
    # --- conflict: both edit simultaneously -> converge
    for pg in (A,B): pg.evaluate("(()=>{})()")
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]'); B.click('#bm'); B.click('#mt'); B.wait_for_selector('#dTh[open]')
    A.click('#thsw i[data-k="c:#12432f"]'); B.click('#thsw i[data-k="c:#32185a"]')
    A.click('#tha'); B.click('#tha'); A.wait_for_timeout(1500); B.wait_for_timeout(1500)
    va=A.evaluate("JSON.stringify(JSON.parse(localStorage.link).rooms.%s.th)"%room); vb=B.evaluate("JSON.stringify(JSON.parse(localStorage.link).rooms.%s.th)"%room)
    check(va==vb,'simultaneous edits converge to the same theme on both devices')
    check(bgof(A)==bgof(B),'and the same background is displayed')
    # --- reset
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]'); A.once('dialog',lambda d:d.accept()); A.click('#thx'); A.wait_for_timeout(1500)
    check(bgof(A)=='' and bgof(B)=='','reset returns both to default')
    check(not eA and not eB,'no page errors: %s %s'%(eA,eB))
    # --- new device joins later and restores the image from relay history
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]'); A.set_input_files('#thfi','' + os.path.join(os.path.dirname(os.path.abspath(__file__)),'bg-test.jpg') + ''); A.wait_for_selector('#thim',state='visible'); A.click('#tha'); A.wait_for_selector('#dTh:not([open])',state='attached',timeout=8000)
    cC,C,eC=mk('uCarol1','Carol'); opn(C,room); C.wait_for_timeout(2500); check('url(' in bgof(C),'a brand-new device receives theme + image from stored history')
    b.close()
finally:
  srv.terminate()
print('ALL PASS' if ok else 'SOME FAILED')
