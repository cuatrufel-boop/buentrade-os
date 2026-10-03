import json,sys,urllib.request,concurrent.futures as cf
KEY="sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"
URL="https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/products-match-from-plant-text?forceFunctionRegion=us-east-1"
inputs=json.load(open('inputs.json'))
def one(pair):
    pid,text=pair
    body=json.dumps({"plant_id":pid,"raw_text":text}).encode()
    for attempt in range(6):
        try:
            req=urllib.request.Request(URL,data=body,headers={"Authorization":"Bearer "+KEY,"apikey":KEY,"Content-Type":"application/json"})
            d=json.loads(urllib.request.urlopen(req,timeout=60).read().decode())
            if d.get("matched") is True: return [pid,text,"matched",d.get("source"),d["product"]["id"],None]
            if "error" in d: return [pid,text,"error",d["error"],None,None]
            return [pid,text,"candidates",None,sorted(c["id"] for c in d.get("candidates",[])),bool(d.get("conflicted"))]
        except Exception as e:
            err=str(e); import time; time.sleep(1+attempt)
    return [pid,text,"fail",err,None,None]
with cf.ThreadPoolExecutor(3) as ex: out=list(ex.map(one,inputs))
json.dump(out,open(sys.argv[1],'w'))
from collections import Counter
print(Counter(r[2] for r in out))
