// Loads the real Edge Function TypeScript (supabase/functions) in Node with the Deno/npm imports stubbed, so the mailbox readers can be
// tested without Deno: `cd scripts/mail-intake-tests && npm install && npm test`. Nothing here talks to Gmail, Anthropic or the database —
// fetch and the database are faked inside the tests.
const ts=require('typescript'),fs=require('fs'),Module=require('module'),path=require('path'),XLSX=require('xlsx');
const root=path.resolve(__dirname,'../../supabase/functions')+'/';
globalThis.Deno={env:{get:()=>"x"},serve(){}};
const cache={};
function load(file){
  if(cache[file])return cache[file];
  let src=fs.readFileSync(file,'utf8');
  if(file.endsWith('plant-price-emails-poll/index.ts')) src+="\nexport { extractXlsxItems, extractImageItems, listUnreadAttachments, pendingReason };";
  const out=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const m={exports:{}};cache[file]=m.exports;
  const req=(spec)=>{
    if(spec==='npm:postgres@3.4.4')return {default:(...a)=>(globalThis.__pgFactory?globalThis.__pgFactory(...a):{}),__esModule:true};
    if(spec==='npm:xlsx@0.18.5')return XLSX;
    if(spec.startsWith('node:'))return require(spec);
    if(spec.startsWith('.')){ const stub=(globalThis.__stubs||{})[spec.split('/').pop()]; if(stub) return stub; return load(path.resolve(path.dirname(file),spec)); }
    return require(spec);
  };
  new Function('exports','require','module','__filename',out)(m.exports,req,m,file);
  return m.exports;
}
module.exports=load(root+'plant-price-emails-poll/index.ts'); module.exports.__load=load; module.exports.__root=root;
