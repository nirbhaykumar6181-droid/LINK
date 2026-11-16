import os, sys, tempfile
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from harness import *
port=32400; room='room_theme_0001'
d=tempfile.mkdtemp(); srv=start(d,port,ROOT); ping(port,room)
def st(uid,name,theme='light'):
    s={'me':{'id':uid,'name':name,'color':'#2f5bea','user':name.lower()},'theme':theme,'rooms':{room:{'id':room,'key':KEY,'name':'Chat','msgs':[],'seq':0,'unread':0,'peers':{}}},'archived':{}}
    return f"if(!localStorage.link)localStorage.link={json.dumps(json.dumps(s))};"
try:
  with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':320,'height':640},device_scale_factor=2); ctx.add_init_script(st('uAlice','Alice','dark')); A=ctx.new_page()
    A.goto(f'http://127.0.0.1:{port}/'); A.wait_for_timeout(600); A.evaluate(f"open('{room}')"); A.wait_for_timeout(400)
    A.click('#bm'); A.click('#mt'); A.wait_for_selector('#dTh[open]'); A.set_input_files('#thfi','' + os.path.join(os.path.dirname(os.path.abspath(__file__)),'bg-test.jpg') + ''); A.wait_for_selector('#thim',state='visible')
    A.screenshot(path='/tmp/editor-320-dark.png')
    A.click('#tha'); A.wait_for_selector('#dTh:not([open])',state='attached',timeout=8000); A.wait_for_timeout(500)
    A.screenshot(path='/tmp/chat-photo-dark.png')
    srv.kill(); srv.wait()                      # hard kill: no graceful shutdown
    srv=start(d,port,ROOT)
    ctx2=b.new_context(viewport={'width':390,'height':780}); ctx2.add_init_script(st('uBobby','Bob')); B=ctx2.new_page()
    B.goto(f'http://127.0.0.1:{port}/'); B.wait_for_timeout(600); B.evaluate(f"open('{room}')"); B.wait_for_timeout(2500)
    print('after SIGKILL + restart, new device background has image:', 'url(' in B.evaluate("document.querySelector('#chat').style.background"))
    b.close()
finally: srv.terminate()
