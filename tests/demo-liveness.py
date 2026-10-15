from pathlib import Path
import json,subprocess,time,threading,ssl,urllib.request
root=Path(__file__).resolve().parents[1]
login=dict(x.split('=',1) for x in (root/'keys/demo-login.env').read_text().splitlines())
compose=['docker','compose','--env-file',str(root/'keys/demo.env'),'-p','zt_demo','--profile','demo']
ctx=ssl._create_unverified_context()
def request(path,body=None,token=None):
 headers={'content-type':'application/json'}
 if token:headers['Authorization']='Bearer '+token
 req=urllib.request.Request('https://localhost'+path,data=None if body is None else json.dumps(body).encode(),headers=headers)
 with urllib.request.urlopen(req,context=ctx,timeout=5) as response:return json.load(response)
token=request('/api/auth/login',{'username':'demo-admin','password':login['DEMO_ADMIN_PASSWORD']})['token']
def state():
 data=request('/api/nodes',token=token)['data']
 return next(x['status'] for x in data if x['name']=='node-worker-01')
def wait(expected,seconds):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if state()==expected:return
  threading.Event().wait(.4)
 raise AssertionError('Không đạt trạng thái '+expected)
wait('HEALTHY',10)
print('Online trước dừng: PASS',flush=True)
start=time.monotonic()
subprocess.run(compose+['pause','node_worker_01'],check=True,cwd=root)
try:
 wait('WARNING',26)
 stale=time.monotonic()-start
 print(f'Stale thật sau {stale:.2f}s: PASS',flush=True)
 wait('OFFLINE',24)
 offline=time.monotonic()-start
 assert 15<=offline<=45,offline
 print(f'Offline thật sau {offline:.2f}s (yêu cầu15–45s): PASS',flush=True)
 result=subprocess.run(compose+['exec','-T','postgres','psql','-U','zt_admin','-d','zt_serverops','-Atc',"SELECT count(*) FROM alerts WHERE message LIKE 'NODE_OFFLINE:%' AND resolved=false;"],check=True,capture_output=True,text=True)
 assert int(result.stdout.strip())==1,result.stdout
 print('Một incident offline thật trong PostgreSQL: PASS',flush=True)
finally:
 subprocess.run(compose+['unpause','node_worker_01'],check=True,cwd=root)
wait('HEALTHY',12)
print('Khôi phục Online sau mở agent: PASS',flush=True)
result=subprocess.run(compose+['exec','-T','postgres','psql','-U','zt_admin','-d','zt_serverops','-Atc',"SELECT count(*) FROM alerts WHERE message LIKE 'NODE_OFFLINE:%' AND resolved=false;"],check=True,capture_output=True,text=True)
assert int(result.stdout.strip())==0
print('Incident tự resolved sau heartbeat mới: PASS',flush=True)
request('/api/auth/logout',{},token)
