import socket, json, sys
code = open(sys.argv[1]).read()
s = socket.create_connection(('localhost', 9876), timeout=180)
s.settimeout(180)
s.sendall(json.dumps({"type": "execute_code", "params": {"code": code}}).encode())
buf = b''
while True:
    b = s.recv(65536)
    if not b: break
    buf += b
    try:
        json.loads(buf.decode()); break
    except Exception: continue
s.close()
r = json.loads(buf.decode())
print(r['result'].get('result', r['result']) if r.get('status')=='success' else "ERROR: "+json.dumps(r)[:800])
