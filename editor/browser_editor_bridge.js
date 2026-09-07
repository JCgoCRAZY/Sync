(() => {
  'use strict';
  if (window.pywebview && window.pywebview.api) return;

  const DB_NAME = 'university-study-hub';
  const DB_VERSION = 1;
  const STORES = {meta:'meta', documents:'documents', blobs:'blobs'};
  const query = new URLSearchParams(location.search);
  const profileId = query.get('profile') || '';
  const courseId = query.get('course') || '';
  const materialId = query.get('material') || '';
  let dbPromise = null;
  let pdfObjectUrl = null;

  const nativePending = new Map();
  window.__studyHubNativeResolve = (id, result) => {
    const pending=nativePending.get(String(id)); if(!pending)return;
    nativePending.delete(String(id)); pending.resolve(result||{ok:false,error:'Native bridge returned no result.'});
  };
  function hasNativeBridge(){return Boolean(window.webkit?.messageHandlers?.studyHub);}
  function nativeCall(action,payload={}){return new Promise((resolve,reject)=>{if(!hasNativeBridge())return reject(new Error('Native bridge unavailable.'));const id=uid('native');nativePending.set(id,{resolve,reject});window.webkit.messageHandlers.studyHub.postMessage({id,action,...payload});setTimeout(()=>{if(nativePending.has(id)){nativePending.delete(id);reject(new Error('Native operation timed out.'));}},30000);});}

  function nowIso(){ return new Date().toISOString(); }
  function uid(prefix='id'){ const body=crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):`${Date.now()}${Math.random().toString(16).slice(2)}`;return `${prefix}_${body.slice(0,18)}`; }
  function openDb(){ if(dbPromise)return dbPromise;dbPromise=new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;for(const s of Object.values(STORES))if(!db.objectStoreNames.contains(s))db.createObjectStore(s);};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});return dbPromise; }
  async function get(store,key){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
  async function put(store,key,value){const db=await openDb();return new Promise((res,rej)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);});}

  function blankDoc(){const t=nowIso();return {schema_version:1,id:materialId,title:'Untitled Document',delta:{ops:[{insert:'\n'}]},slides_attachment:null,editor_layout:{slides_visible:false,split_ratio:.5,slides_scroll_top:0,notes_scroll_top:0,document_format:'normal'},created_at:t,updated_at:t,slide_annotations:{settings:{marker_color:'#2457E6',highlighter_color:'#FFE14F',marker_size:'medium',highlighter_size:'medium',eraser_size:'medium'},strokes:[],texts:[],labels:[]},whiteboard:{exists:false,page_width:1390,page_height:1302,pages_x:1,pages_y:1,scroll_x:0,scroll_y:0,zoom_percent:100,drawings:[],texts:[]},image_occlusion:{reveal_seconds:3,boxes:[]}};}
  async function loadDocument(){let d=await get(STORES.documents,materialId);if(!d){d=blankDoc();await put(STORES.documents,materialId,d);}return structuredClone(d);}
  async function saveDocumentObject(doc){doc.updated_at=nowIso();await put(STORES.documents,materialId,doc);return doc;}
  async function updateMainState(mutator){const s=await get(STORES.meta,'state');if(!s)return;mutator(s);s.app ||= {};s.app.last_saved=nowIso();await put(STORES.meta,'state',s);}
  async function updateMaterialMeta(title){await updateMainState(s=>{const c=s.profiles?.[profileId]?.courses?.[courseId];const m=c?.materials?.find(x=>x.id===materialId);if(m){m.title=title||m.title;m.updated_at=nowIso();m.last_opened_at=nowIso();c.updated_at=nowIso();}});}

  async function makePdfConfig(){
    const state=await get(STORES.meta,'state');const sensitivity=Number(state?.profiles?.[profileId]?.settings?.scroll_sensitivity||100)/100;
    const click=state?.profiles?.[profileId]?.settings?.audio||{};
    const blob=await get(STORES.blobs,`pdf:${materialId}`);
    if(pdfObjectUrl){URL.revokeObjectURL(pdfObjectUrl);pdfObjectUrl=null;}
    if(blob instanceof Blob)pdfObjectUrl=URL.createObjectURL(blob);
    return {layoutUrl:'browser-layout://save',pdfUrl:pdfObjectUrl,pdfJsUrl:new URL('pdfjs/pdf.mjs',location.href).href,pdfWorkerUrl:new URL('pdfjs/pdf.worker.mjs',location.href).href,clickAudioUrl:new URL('../audio/clicks/matthewvakaliuk73627-mouse-click-290204.mp3',location.href).href,clickAudioEnabled:click.click_enabled===true,clickAudioVolume:Number(click.click_volume??.55),scrollSensitivity:sensitivity};
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, init={}){
    const url=typeof input==='string'?input:input?.url||'';
    if(url.startsWith('browser-layout://')){
      try{const patch=JSON.parse(String(init.body||'{}'));const d=await loadDocument();d.editor_layout={...(d.editor_layout||{}),...patch};await saveDocumentObject(d);return new Response(JSON.stringify({ok:true,editor_layout:d.editor_layout}),{status:200,headers:{'Content-Type':'application/json'}});}catch(err){return new Response(JSON.stringify({ok:false,error:String(err)}),{status:400,headers:{'Content-Type':'application/json'}});}
    }
    return nativeFetch(input,init);
  };

  async function chooseColor(initial){
    return new Promise(resolve=>{const input=document.createElement('input');input.type='color';input.value=/^#[0-9a-f]{6}$/i.test(initial||'')?initial:'#2457E6';input.style.position='fixed';input.style.opacity='0';input.style.pointerEvents='none';document.body.appendChild(input);let done=false;const finish=(color)=>{if(done)return;done=true;input.remove();resolve({ok:true,color});};input.addEventListener('input',()=>finish(input.value.toUpperCase()),{once:true});input.addEventListener('change',()=>finish(input.value.toUpperCase()),{once:true});setTimeout(()=>{input.click();},0);setTimeout(()=>finish(null),120000);});
  }

  const api = {
    async load_document(){return loadDocument();},
    async get_scroll_sensitivity(){const s=await get(STORES.meta,'state');return Number(s?.profiles?.[profileId]?.settings?.scroll_sensitivity||100)/100;},
    async save_document(title,delta){try{const d=await loadDocument();d.title=String(title||'').trim()||'Untitled Document';d.delta=delta;await saveDocumentObject(d);await updateMaterialMeta(d.title);return {ok:true,title:d.title,updated_at:d.updated_at};}catch(err){return {ok:false,error:String(err)};}},
    async save_whiteboard_state(value){try{const d=await loadDocument();d.whiteboard=value;await saveDocumentObject(d);return {ok:true,whiteboard:value};}catch(err){return {ok:false,error:String(err)};}},
    async save_whiteboard_viewport(x,y,zoom){try{const d=await loadDocument();d.whiteboard ||= {};Object.assign(d.whiteboard,{scroll_x:Number(x)||0,scroll_y:Number(y)||0,zoom_percent:Number(zoom)||100});await saveDocumentObject(d);return {ok:true};}catch(err){return {ok:false,error:String(err)};}},
    async save_image_occlusion_state(boxes,seconds){try{const d=await loadDocument();d.image_occlusion={reveal_seconds:Number(seconds)||3,boxes:Array.isArray(boxes)?boxes:[]};await saveDocumentObject(d);return {ok:true,image_occlusion:d.image_occlusion};}catch(err){return {ok:false,error:String(err)};}},
    async save_slide_annotations_state(value){try{const d=await loadDocument();d.slide_annotations=value;await saveDocumentObject(d);return {ok:true,slide_annotations:value};}catch(err){return {ok:false,error:String(err)};}},
    async choose_slide_annotation_color(initial){return chooseColor(initial);},
    async copy_text_to_clipboard(text){try{if(hasNativeBridge())return await nativeCall('copyText',{text:String(text||'')});await navigator.clipboard.writeText(String(text||''));return {ok:true};}catch(err){return {ok:false,error:String(err)};}},
    async read_text_from_clipboard(){try{if(hasNativeBridge())return await nativeCall('readText');return {ok:true,text:await navigator.clipboard.readText()};}catch(err){return {ok:false,error:String(err),text:''};}},
    async create_question(prompt,answer,documentTitle){try{const q={id:uid('question'),type:'short_answer',prompt:String(prompt||'').trim(),answer:String(answer||'').trim(),explanation:'',tags:[],created_at:nowIso(),updated_at:nowIso(),stats:{attempts:0,correct:0,incorrect:0,last_tested:null},source_material_id:materialId,source_document_title:String(documentTitle||'Untitled Document')};await updateMainState(s=>{const c=s.profiles?.[profileId]?.courses?.[courseId];if(c)c.questions=(c.questions||[]).concat(q);});return {ok:true,id:q.id};}catch(err){return {ok:false,error:String(err)};}},
    async request_close(){try{await updateMaterialMeta((await loadDocument()).title);}catch(_e){} if(history.length>1)history.back();else location.href='../index.html';return {ok:true};}
  };
  window.pywebview={api};

  async function assignSelectedPdf(){
    const form=document.getElementById('slides-upload-form'),input=document.getElementById('slides-file-input'),frame=document.getElementById('slides-upload-frame');const file=input?.files?.[0];if(!file)return;
    try{if(!file.name.toLowerCase().endsWith('.pdf'))throw new Error('Slides must be a PDF.');await put(STORES.blobs,`pdf:${materialId}`,file);const d=await loadDocument();d.slides_attachment={relative_path:`browser-pdf:${materialId}`,display_name:file.name,size_bytes:file.size,assigned_at:nowIso()};d.editor_layout={...(d.editor_layout||{}),slides_visible:true};await saveDocumentObject(d);const config=await makePdfConfig();window.editorApp?.setPdfServiceConfig(config);setTimeout(()=>frame?.dispatchEvent(new Event('load')),20);}catch(err){console.error(err);const status=document.getElementById('save-status');if(status){status.textContent=`Slides import failed: ${err.message||err}`;status.className='error';}setTimeout(()=>frame?.dispatchEvent(new Event('load')),20);}
  }

  function installTouchAdapters(){
    const style=document.createElement('style');style.textContent=`
      html,body,.app{width:100%;max-width:100%;height:100dvh;max-height:100dvh;}
      body{padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);padding-bottom:env(safe-area-inset-bottom);}
      .slide-annotation-layer,.occlusion-layer,#whiteboard-svg{touch-action:none;}
      .slides-stage,.notes-stage,#whiteboard-scrollport{overscroll-behavior:contain;-webkit-overflow-scrolling:touch;}
      @media (pointer:coarse){button{min-height:42px}.slide-text-resize-handle{width:16px;height:16px}.image-resize-handle{width:16px;height:16px}#toolbar{padding-left:10px;padding-right:10px;gap:4px}.topbar{padding-left:10px;padding-right:10px}.study-actions{min-width:0!important;flex-basis:100%!important}.study-actions button{min-height:42px;padding-left:12px!important;padding-right:12px!important}}
      @media (max-width:900px){.topbar{grid-template-columns:auto minmax(120px,1fr) auto}.save-button{display:none}#save-status{min-width:70px}.app{grid-template-rows:auto auto minmax(0,1fr)}#toolbar{max-height:132px;overflow:auto}.editor-workspace.split-preview{flex-direction:column}.editor-workspace.split-preview #notes-stage{display:block;flex:1 1 50%!important;width:100%;min-height:0;padding-top:18px;padding-bottom:28px}.editor-workspace.split-preview #split-divider{display:none}.editor-workspace.split-preview #slides-stage{display:block;flex:1 1 50%!important;width:100%;max-width:100%;min-height:0;padding-top:18px;padding-bottom:28px;border-top:2px solid #1c3341}.slides-pdf-page{max-width:100%}}
    `;document.head.appendChild(style);

    // iPad long-press provides the same custom Delete menu as desktop right-click.
    let timer=null,start=null,target=null;
    document.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;const el=e.target.closest('.slide-label-annotation,.slide-text-annotation');if(!el)return;target=el;start={x:e.clientX,y:e.clientY};clearTimeout(timer);timer=setTimeout(()=>{if(!target)return;target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:start.x,clientY:start.y,button:2}));target=null;},620);},{capture:true});
    document.addEventListener('pointermove',e=>{if(!start)return;if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>12){clearTimeout(timer);target=null;}},{capture:true});
    document.addEventListener('pointerup',()=>{clearTimeout(timer);target=null;start=null;},{capture:true});document.addEventListener('pointercancel',()=>{clearTimeout(timer);target=null;start=null;},{capture:true});
  }

  async function boot(){
    if(!profileId||!courseId||!materialId){console.error('Missing editor identifiers.');return;}
    installTouchAdapters();
    const form=document.getElementById('slides-upload-form');if(form)form.submit=assignSelectedPdf;
    const config=await makePdfConfig(); if(window.editorApp?.setPdfServiceConfig)window.editorApp.setPdfServiceConfig(config);else window.__studyHubPdfServiceConfig=config;
    window.dispatchEvent(new Event('pywebviewready'));
  }
  window.addEventListener('load',()=>setTimeout(boot,0),{once:true});
})();
