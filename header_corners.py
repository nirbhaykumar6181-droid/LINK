import os, sys, tempfile
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from harness import *
from PIL import Image
import io
def run(root, label, port, theme):
    d=tempfile.mkdtemp(); srv=start(d,port,root); room='room_corner_001'; ping(port,room)
    try:
        with sync_playwright() as p:
            b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':780},device_scale_factor=2)
            ctx.add_init_script(seed('uA','Alice',room,{'bg':{'t':'preset','v':'sand'}},theme))
            pg=ctx.new_page(); pg.goto(f'http://127.0.0.1:{port}/'); pg.wait_for_timeout(600)
            pg.evaluate(f"open('{room}')"); pg.wait_for_timeout(700)
            box=pg.evaluate("(()=>{const r=document.querySelector('#chat header').getBoundingClientRect();return[r.left,r.bottom,r.right]})()")
            png=pg.screenshot(path=f'/tmp/{label}-{theme}.png'); im=Image.open(io.BytesIO(png)).convert('RGB')
            # sample just inside the bottom-left curved corner, outside the arc: (left+2, bottom-2) in CSS px
            x=int((box[0]+2)*2); y=int((box[1]-2)*2)
            print(label, theme, 'corner pixel', im.getpixel((x,y)), ' wallpaper sample', im.getpixel((200,int(box[1]*2)+120)))
            b.close()
    finally: srv.terminate()
for theme in ('dark','light'):
    pass  # compare against a v1.3.2 checkout by passing its path as argv[1]
    if len(sys.argv)>1: run(sys.argv[1],'BEFORE',32100,theme)
    run(ROOT,'AFTER',32101,theme)
