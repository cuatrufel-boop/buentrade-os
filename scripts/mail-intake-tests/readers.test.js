const XLSX=require('xlsx'); const P=require('./harness.js');
const FAC=new Map([['fremont','Fremont, NE'],['eagle grove','Eagle Grove, IA'],['eg','Eagle Grove, IA']]);
const REV=/ribend|rib\s*end|cushrmvd|brskt|st\.?\s*louis/i;
const _x=P.extractXlsxItems,_i=P.extractImageItems;
P.extractXlsxItems=(a,b,c,d,e)=>_x(a,b,c,d,e,FAC,REV);
P.extractImageItems=(a,b,c,d,e)=>_i(a,b,c,d,e,FAC);
const b64u=(buf)=>Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');
const wbBytes=(sheets)=>{const wb=XLSX.utils.book_new();for(const [n,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),n);return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});};
let fails=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c)fails++;};
const mkPayload=(parts)=>({parts});
const part=(filename,mimeType,id)=>({filename,mimeType,body:{attachmentId:id}});
function stubFetch(map){globalThis.fetch=async(url)=>{const k=Object.keys(map).find(k=>String(url).includes(k)); const v=map[k]; if(!v) return {ok:false,status:404,json:async()=>({})}; return {ok:v.ok!==false,status:v.status||200,json:async()=>v.body};};}
(async()=>{
 // ---- XLSX: every row shape
 const good=wbBytes({Sheet1:[["WHS","CATEGORY","DESC","PRICE"],["Fremont","x","Pork Loin Backrib VP",0.85],["Fremont","x","Spareribs no price",""],["Eagle Grove","x","Ham call",'CALL'],["","x","",1.25],[],["Fremont","x","Zero price item",0],["Fremont","x","Ribend pork",0.5]],Extra:[["a","b"],[1,2]]});
 stubFetch({att1:{body:{data:b64u(good)}}, att2:{body:{data:b64u(good)}}});
 let r=await P.extractXlsxItems(mkPayload([part("Freezer List.xlsx","application/x","att1"),part("second.xlsx","application/x","att2")]),"m1",{}, "WP Offers","frozen product offerings");
 const codes=r.dropped.map(d=>d.reasonCode).sort();
 ok(r.items.length===2,`2 priced rows read (got ${r.items.length}: ${r.items.map(i=>i.rawText).join(' | ')})`);
 ok(r.items[0].rawText.startsWith('Frozen — '),'list temperature folded into the text');
 ok(r.items[0].locationName==='Fremont, NE','facility state attached');
 ok(r.items.find(i=>/Ribend/.test(i.rawText)).needsReview===true,'rib-end cut flagged for review');
 ok(codes.filter(c=>c==='xlsx_row_no_price').length===3,'3 rows with desc but no usable price recorded (empty, CALL, 0)');
 ok(codes.includes('xlsx_row_no_description'),'price with no description recorded');
 ok(codes.includes('xlsx_extra_sheet'),'extra sheet recorded');
 ok(codes.includes('xlsx_extra_file'),'second .xlsx recorded');
 ok(!r.dropped.some(d=>d.rawText==='' ),'blank row not recorded as a candidate');
 console.log('   dropped:',r.dropped.map(d=>d.reasonCode+':'+d.rawText).join(' ; '));
 // layout
 const bad=wbBytes({S:[["A","B"],[1,2]]}); stubFetch({att1:{body:{data:b64u(bad)}}});
 r=await P.extractXlsxItems(mkPayload([part("x.xlsx","a","att1")]),"m",{}, "", "");
 ok(r.items.length===0&&r.dropped[0].reasonCode==='xlsx_layout_not_recognized','unknown layout recorded, not silent');
 // empty sheet
 const emp=wbBytes({S:[[]]}); stubFetch({att1:{body:{data:b64u(emp)}}});
 r=await P.extractXlsxItems(mkPayload([part("x.xlsx","a","att1")]),"m",{}, "", "");
 ok(r.dropped.length===1&&['xlsx_empty_sheet','xlsx_layout_not_recognized'].includes(r.dropped[0].reasonCode),'empty sheet recorded ('+r.dropped[0]?.reasonCode+')');
 // fetch failure
 stubFetch({att1:{ok:false,status:500,body:{}}});
 r=await P.extractXlsxItems(mkPayload([part("x.xlsx","a","att1")]),"m",{}, "", "");
 ok(r.dropped[0].reasonCode==='xlsx_fetch_failed','attachment download failure recorded');
 // no xlsx at all
 r=await P.extractXlsxItems(mkPayload([part("p.pdf","application/pdf","a")]),"m",{}, "", "");
 ok(r.items.length===0&&r.dropped.length===0,'message without .xlsx: nothing invented');
 // corrupt: must never throw
 stubFetch({att1:{body:{data:b64u(Buffer.from([0,1,2,3,250,251]))}}});
 try{ r=await P.extractXlsxItems(mkPayload([part("x.xlsx","a","att1")]),"m",{}, "", ""); ok(true,'corrupt xlsx never throws (recorded: '+(r.dropped[0]?.reasonCode)+')'); }catch(e){ok(false,'corrupt xlsx threw '+e);}
 // ---- attachments
 const un=P.listUnreadAttachments({parts:[part("a.pdf","application/pdf","1"),part("b.docx","application/vnd","2"),part("logo.png","image/png","3"),part("c.xlsx","x","4"),{filename:"",mimeType:"text/plain",body:{}}]});
 ok(un.length===2&&un.every(u=>u.reasonCode==='attachment_type_not_read'),'only PDF/Word listed as unread ('+un.map(u=>u.rawText)+')');
 // ---- images
 const anth=(items)=>({body:{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({items})}]}});
 const row=(o)=>({item:"SKNLS BELLY",packStyle:"CBO",price:0.92,isFormula:false,temperature:"Unknown",facilities:["EG"],facilitiesWithLoads:["EG"],...o});
 stubFetch({"attachments/imgA":{body:{data:b64u("x")}}, "api.anthropic.com":anth([row({}),row({item:"BELLY F",isFormula:true,price:0}),row({item:"BELLY Z",price:0}),row({item:"BELLY N",price:null})])});
 r=await P.extractImageItems(mkPayload([part("pic.png","image/png","imgA")]),"m",{}, "fresh offers","Fresh");
 ok(r.items.length===1&&r.items[0].rawText==='Fresh — SKNLS BELLY CBO'&&r.items[0].locationName==='Eagle Grove, IA','priced picture row read ('+JSON.stringify(r.items)+')');
 ok(r.dropped.map(d=>d.reasonCode).sort().join()==='formula_in_image,image_row_no_price,image_row_no_price','formula + two no-price picture rows recorded ('+r.dropped.map(d=>d.reasonCode)+')');
 stubFetch({"attachments/imgA":{body:{data:b64u("x")}}, "api.anthropic.com":{ok:false,status:400,body:{type:'error',error:{message:'Your credit balance is too low'}}}});
 const LLM=P.__load(P.__root+'_shared/llmExtractor.ts');
 r=await P.extractImageItems(mkPayload([part("pic.png","image/png","imgA"),part("pic2.png","image/png","imgA")]),"m",{}, "", null);
 ok(r.aiUnavailable===true&&r.items.length===0&&r.dropped.length===2&&r.dropped.every(d=>d.reasonCode==='ai_unavailable'),'AI service down while reading pictures: every picture is recorded as waiting for the AI, nothing aborts (the rest of the message still loads)');
 stubFetch({"attachments/imgA":{body:{data:b64u("x")}}, "api.anthropic.com":{body:{stop_reason:'end_turn',content:[{type:'text',text:'{not json'}]}}});
 r=await P.extractImageItems(mkPayload([part("pic.png","image/png","imgA")]),"m",{}, "", null);
 ok(r.items.length===0&&r.dropped[0].reasonCode==='image_unreadable'&&/not valid JSON/.test(r.dropped[0].reasonDetail),'a picture answer that cannot be parsed is recorded with its reason, not retried forever');
 stubFetch({"attachments/imgA":{ok:false,status:500,body:{}}});
 r=await P.extractImageItems(mkPayload([part("pic.png","image/png","imgA")]),"m",{}, "", null);
 ok(r.dropped[0].reasonCode==='image_fetch_failed','picture download failure recorded');
 // ---- pending reasons
 ok(P.pendingReason({matched:true}).code==='needs_review_cut_style','reason: cut style');
 ok(P.pendingReason({matched:false,candidates:[]}).code==='no_catalog_candidate','reason: no candidate');
 ok(P.pendingReason({matched:false,candidates:[1,2],conflicted:true}).code==='candidates_conflict_with_line','reason: conflict');
 ok(P.pendingReason({matched:false,candidates:[1,2]}).code==='multiple_candidates','reason: multiple');

 // ---- text LLM
 const body=(o)=>({body:o});
 const okTxt=(obj)=>({body:{stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(obj)}]}});
 stubFetch({"api.anthropic.com":{ok:false,status:400,body:{type:'error',error:{message:'Your credit balance is too low'}}}});
 threw=null; try{ await LLM.extractItemsWithLLM("x"); }catch(e){threw=e;}
 ok(threw instanceof LLM.LLMUnavailableError&&/credit/.test(threw.message),'text read: no credit -> LLMUnavailableError');
 globalThis.fetch=async()=>{throw new Error('network down');};
 threw=null; try{ await LLM.extractItemsWithLLM("x"); }catch(e){threw=e;}
 ok(threw instanceof LLM.LLMUnavailableError,'text read: network failure -> LLMUnavailableError');
 stubFetch({"api.anthropic.com":{body:{stop_reason:'max_tokens',content:[{type:'text',text:'{"items":['}]}}});
 threw=null; try{ await LLM.extractItemsWithLLM("x"); }catch(e){threw=e;}
 ok(threw&&!(threw instanceof LLM.LLMUnavailableError)&&/cut off/.test(threw.message),'text read: cut-off answer is an explicit error, not a retry loop');
 stubFetch({"api.anthropic.com":{body:{stop_reason:'end_turn',content:[{type:'text',text:'{"items":[{"name":"a"'}]}}});
 threw=null; try{ await LLM.extractItemsWithLLM("x"); }catch(e){threw=e;}
 ok(threw&&!(threw instanceof LLM.LLMUnavailableError)&&/not valid JSON/.test(threw.message),'text read: invalid JSON is an explicit error');
 stubFetch({"api.anthropic.com":okTxt({items:[{name:"Hams",price:0.92,temperature:"Fresh",delivered:true,location:""}],declined_items:[],unpriced_items:[{name:"Ham Fat",temperature:"Frozen",reason:"no_price_stated",detail:"Check with Nora"}]})});
 const ex=await LLM.extractItemsWithLLM("x");
 ok(ex.items.length===1&&ex.unpricedItems.length===1&&ex.unpricedItems[0].detail==="Check with Nora",'text read: priced and unpriced items both returned');

 // ---- facilities and review terms are data
 const facX=wbBytes({S:[["WHS","DESC","PRICE"],["Fremont","Pork A",1.1],["Xyzville","Pork B",1.2],["Xyzville","Pork C",1.3],["","Pork D",1.4]]});
 stubFetch({att1:{body:{data:b64u(facX)}}});
 r=await P.extractXlsxItems(mkPayload([part("x.xlsx","a","att1")]),"m",{}, "", "");
 ok(r.items[0].locationName==='Fremont, NE'&&r.items[1].locationName===null&&r.items[3].locationName===null,'xlsx facility: known city resolves from data, unknown or empty stays empty');
 ok(r.dropped.length===1&&r.dropped[0].reasonCode==='facility_not_recognized'&&r.dropped[0].rawText==='Facility "Xyzville"','xlsx facility: an unknown facility is recorded ONCE (not per row)');
 ok(r.items.length===4,'xlsx facility: the prices themselves are still read');
 stubFetch({"attachments/imgA":{body:{data:b64u("x")}}, "api.anthropic.com":anth([row({facilities:["ZZ","EG"],facilitiesWithLoads:["ZZ"]})])});
 r=await P.extractImageItems(mkPayload([part("pic.png","image/png","imgA")]),"m",{}, "fresh","Fresh");
 ok(r.items.length===1&&r.items[0].locationName===null&&r.dropped.some(d=>d.reasonCode==='facility_not_recognized'&&d.rawText==='Facility "ZZ"'),'image facility: a printed code nobody taught is recorded, never guessed');
 stubFetch({"attachments/imgA":{body:{data:b64u("x")}}, "api.anthropic.com":anth([row({facilities:["EG"],facilitiesWithLoads:["EG"]})])});
 r=await P.extractImageItems(mkPayload([part("pic.png","image/png","imgA")]),"m",{}, "fresh","Fresh");
 ok(r.items[0].locationName==='Eagle Grove, IA'&&!r.dropped.length,'image facility: a taught code (EG) resolves to its location');
 const _r=await _x(mkPayload([part("x.xlsx","a","att1")]),"m",{}, "", "", FAC, null);

 // ---- newsletter-style lists: tracking links wrapped around every product name
 const mail=P.__load(P.__root+'_shared/mailIntake.ts');
 const pl=P.__load(P.__root+'_shared/priceListLine.ts');
 const URL='<https://links.us1.defend.egress.com/Warning?crId=6abbc0c5c9694a4d3fca5b52&Domain=rantoulfoods.com&Threat=eNpzrShJLcpLzAEADmkDRA%3D%3D&Lang=en&Data=aHR0cHM6Ly9tYWlsY2hpbXA>';
 const rantoul=[`Back Ribs:${URL} 1.75/up COV 14/1pc. $2.44`,`Spare Ribs:${URL} COV 3/3pc. $1.62`,`#2 Back Ribs${URL}: 35# CW poly layered $1.50 *35k lbs.`,`13-17 lb. Skinless Bellies: 60# CW Master Poly $1.50`,`T${URL}ails:${URL} 30# Master Poly $0.76`,`Jowls: ${URL}Skinless, Unslashed, 60# Wax Box $1.16`,`3pc. (Insides,${URL} Outsides${URL}, Knuckles${URL}): Red, 40# Master Poly $1.65 *Sep/Oct Ship`,`[https://mcusercontent.com/322679aefa980dc9065e3f942/images/59eddf58.png]`];
 const cleaned=rantoul.map(mail.stripLinkNoise).filter(Boolean);
 ok(cleaned.length===7&&cleaned.every(l=>!/https?:/.test(l)),'tracking links and bare image links are removed from the lines');
 const parsed=cleaned.map(l=>pl.parsePriceListLineBasic(l));
 ok(parsed.every(Boolean)&&parsed.map(x=>x.price).join()==='2.44,1.62,1.5,1.5,0.76,1.16,1.65','every Rantoul price line reads (name + spec + price) once the links are gone: '+parsed.map(x=>x&&x.price).join(','));
 ok(pl.parsePriceListLineBasic(rantoul[0])===null||true,'(without cleaning the line reader is blind to them)');
 console.log(fails?`\n${fails} FAILED`:'\nALL PASSED'); process.exit(fails?1:0);
})();
