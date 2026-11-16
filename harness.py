import json, subprocess, time, os, tempfile, urllib.request, sys
import os
ROOT=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from playwright.sync_api import sync_playwright
KEY='A'*43
def start(dirpath, port, root):
    env=dict(os.environ, PORT=str(port), HOST='127.0.0.1', LINK_DATA_DIR=dirpath, LINK_TRUST_PROXY='0')
    p=subprocess.Popen(['node','server.js'],cwd=root,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(80):
        try: urllib.request.urlopen(f'http://127.0.0.1:{port}/health'); return p
        except Exception: time.sleep(.1)
    raise RuntimeError('server did not start')
def ping(port, room):
    urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/p/{room}?e=1',data=b'ping',method='POST'))
def seed(uid, name, room, extra=None, theme='light'):
    st={'me':{'id':uid,'name':name,'color':'#2f5bea','user':name.lower()},'theme':theme,'rooms':{room:{'id':room,'key':KEY,'name':'Test','msgs':[],'seq':0,'unread':0,'peers':{}}},'archived':{}}
    if extra: st.update(extra)
    return f"if(!localStorage.link)localStorage.link={json.dumps(json.dumps(st))};"
