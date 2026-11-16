"""My QR code: every dot shape, with/without centre badge, and gradients must decode to the profile link.
Needs: playwright, opencv-python, numpy. Run: python3 test/browser/qr_code.py"""
import sys,os,json,base64,tempfile
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
import harness,numpy as np,cv2
from playwright.sync_api import sync_playwright
PORT=4191;d=tempfile.mkdtemp();srv=harness.start(d,PORT,harness.ROOT)
st={'me':{'id':'Ab3dE9xYz','name':'Nirbhay','color':'#2f5bea','user':'nirbhay.k'},'theme':'light','rooms':{},'archived':{}}
want=f'http://127.0.0.1:{PORT}/#f=nirbhay.k';dets=[cv2.QRCodeDetector(),cv2.QRCodeDetectorAruco()];bad=[]
def ok(png):
    a=cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_COLOR)
    return any(x.detectAndDecode(im)[0]==want for x in dets for im in (a,)+tuple(cv2.resize(a,None,fx=f,fy=f,interpolation=cv2.INTER_AREA) for f in (.8,.6)))
def grab(pg):
    pg.wait_for_timeout(250);return base64.b64decode(pg.evaluate("document.querySelector('#qrPrev').toDataURL('image/png')").split(',')[1])
try:
    with sync_playwright() as p:
        b=p.chromium.launch();ctx=b.new_context(viewport={'width':390,'height':800},accept_downloads=True)
        ctx.add_init_script(f"if(!localStorage.link)localStorage.link={json.dumps(json.dumps(st))};")
        pg=ctx.new_page();pg.goto(f'http://127.0.0.1:{PORT}/');pg.wait_for_timeout(600);pg.click('#ts');pg.click('#sqr');pg.wait_for_timeout(400)
        for sh in ('smooth','rounded','dots','square'):
            for ce in ('off','initial'):
                pg.click(f'#qrShape button[data-k={sh}]');pg.click(f'#qrCentre button[data-k={ce}]')
                if not ok(grab(pg)):bad.append(f'{sh}/{ce}')
        pg.click('#qrFg i[data-c=g1]');pg.click('#qrBg i[data-c=h2]')
        if not ok(grab(pg)):bad.append('gradient')
        pg.click('#qrFg i[data-c=g1]');pg.click('#qrBg i[data-c="#111827"]');pg.wait_for_timeout(200)
        if 'Light-on-dark' not in pg.inner_text('#qrWarn'):bad.append('inverted warning missing')
        with pg.expect_download() as dl:pg.click('#qrSv')
        if dl.value.suggested_filename!='link-qr-nirbhay.k.png':bad.append('filename')
        b.close()
finally:srv.terminate()
print('FAILED:',bad) if bad else print('qr_code: all passed');sys.exit(1 if bad else 0)
