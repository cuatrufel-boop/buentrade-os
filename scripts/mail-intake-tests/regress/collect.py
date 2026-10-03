# Matcher regression (needs SUPABASE_ACCESS_TOKEN): collects every historical plant line (Pending rows + aliases) plus a case per abbreviation.
# Run run_matcher.py before a matcher/term change (python3 run_matcher.py before.json) and after (after.json); the two must be identical.
import json,os,urllib.request
def q(sql):
    req=urllib.request.Request("https://api.supabase.com/v1/projects/geqhjykbxvxugvnpnygn/database/query",data=json.dumps({"query":sql}).encode(),headers={"Authorization":"Bearer "+os.environ["SUPABASE_ACCESS_TOKEN"],"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(req).read().decode())
rows=q("""select distinct plant_id, raw_text from (
  select plant_id, raw_text from plant_pending_matches
  union select plant_id, raw_text from plant_product_aliases
) t where raw_text is not null""")
# plants for synthetic cases
plants={r['n']:r['id'] for r in q("select id, split_part(lower(trim(name)),' ',1) n from plants where name ~* '^\\s*(tyson|seaboard|smithfield|wholestone)'")}
synthetic=[
 "Frozen — Pork Sirloin FZ COV","Pork Spareribs FZ Box","Offals Tongues","Frozen — Offals Stomachs","Pork Loin VP","Pork Loin CVP 14/1","Pork Backribs Cryol","Pork Backribs Cryl 12/1","Pork Loin Vacuum Pack",
 "Pork Butts COV","Pork Hams Poly 2.5-3.0 lbs","Fresh Bone-in Loins COV","Frozen Skinless Bellies 13/15 FZ","Pork Picnic PCS","Pork Picnic CMBS","Pork Picnic CBOS","Fresh Boneless Picnic CBO",
 "Stomachs FZ","Hearts FZ wax","Frozen — Pork Jowls VP","Pork Neckbones Poly","Frozen Fat Backs COV","Pork Trim 72 boxes","Pork Trim 42 combos"]
texts=[(r['plant_id'],r['raw_text']) for r in rows]
for pid in plants.values():
    for t in synthetic: texts.append((pid,t))
json.dump(texts,open('inputs.json','w'))
print(len(texts),"inputs (",len(rows),"historical +",len(plants)*len(synthetic),"synthetic )")
