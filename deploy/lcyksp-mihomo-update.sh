#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:-test}"
MIHOMO_DIR="${MIHOMO_DIR:-/opt/mihomo}"
CONFIG="$MIHOMO_DIR/config.yaml"
if [[ "$ACTION" == "update" ]]; then
  SUBSCRIPTION="${2:-}"
  [[ -n "$SUBSCRIPTION" ]] || { echo '{"ok":false,"message":"missing subscription"}'; exit 2; }
  python3 - "$CONFIG" "$SUBSCRIPTION" <<'PY'
import pathlib, re, sys
path, url = sys.argv[1], sys.argv[2]
s = pathlib.Path(path).read_text()
pattern = r'(proxy-providers:\s*\n\s+airport:\s*\n(?:.*\n)*?\s+url:\s*)["\']?[^"\'\n]+["\']?'
replacement = r'\1"' + url.replace('"', '\\"') + '"'
new, count = re.subn(pattern, replacement, s, count=1)
if count != 1: raise SystemExit('airport provider url not found')
pathlib.Path(path).write_text(new)
PY
  chmod 600 "$CONFIG"
  (cd "$MIHOMO_DIR" && docker compose restart mihomo >/dev/null)
  sleep 3
fi
SECRET="$(sed -n 's/^secret: *"\(.*\)"/\1/p' "$CONFIG" | head -n1)"
export SECRET
python3 - "$ACTION" <<'PY'
import json, os, sys, time, urllib.request
action = sys.argv[1]
base = 'http://127.0.0.1:9090'
headers = {'Authorization': 'Bearer ' + os.environ.get('SECRET',''), 'Content-Type':'application/json'}
def call(path, method='GET', payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read() or b'{}')
data = call('/providers/proxies/airport')
healthy = []
for proxy in data.get('proxies', []):
    for item in reversed(proxy.get('history') or []):
        try: delay = int(item.get('delay', 0))
        except: delay = 0
        if delay > 0: healthy.append((delay, proxy.get('name',''))); break
if not healthy: raise SystemExit('no healthy github proxy nodes')
healthy.sort(key=lambda x: x[0])
delay, name = healthy[0]
call('/proxies/GITHUB', 'PUT', {'name': name})
print(json.dumps({'ok': True, 'node': name, 'delay': delay, 'status':'已连接'}, ensure_ascii=False))
PY
