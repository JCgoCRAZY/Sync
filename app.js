'use strict';

const APP_VERSION = '2026.09.09-keyboard-navigation-1';
const DB_NAME = 'university-study-hub';
const DB_VERSION = 1;
const STORES = { meta: 'meta', documents: 'documents', blobs: 'blobs' };
const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const SCROLL_LEVELS = [50,100,150,200,250,300,350,400];
const MUSIC_TRACKS = ['alex-morgan-study-jazz-study-music-564277.mp3','alex-morgan-study-music-session-559993.mp3'];
const els = {};
let state = null;
let route = {page:'dashboard', courseId:null, tab:'Overview'};
let saveTimer = null;
let stateSavePending = false;
let stateCloudDirtyPending = false;
let toastTimer = null;
let liveTimer = null;
let dbPromise = null;
let audioTrack = null;

const nativePending = new Map();
window.__studyHubNativeResolve = (id, result) => {
  const pending = nativePending.get(String(id));
  if (!pending) return;
  nativePending.delete(String(id));
  pending.resolve(result || {ok:false,error:'Native bridge returned no result.'});
};
function hasNativeBridge(){ return Boolean(window.webkit?.messageHandlers?.studyHub); }
function nativeCall(action, payload={}){
  return new Promise((resolve,reject)=>{
    if(!hasNativeBridge()) return reject(new Error('Native iPad bridge is unavailable.'));
    const id=uid('native'); nativePending.set(id,{resolve,reject});
    window.webkit.messageHandlers.studyHub.postMessage({id,action,...payload});
    setTimeout(()=>{if(nativePending.has(id)){nativePending.delete(id);reject(new Error('Native iPad operation timed out.'));}},120000);
  });
}
function fileToDataUrl(file){ return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=()=>reject(r.error);r.readAsDataURL(file);}); }

function uid(prefix='id') {
  const body = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : `${Date.now()}${Math.random().toString(16).slice(2)}`);
  return `${prefix}_${body.slice(0,18)}`;
}
function nowIso(){ return new Date().toISOString(); }
function escapeHtml(value){ return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function normalizeCourseCode(value){
  const m = String(value||'').toUpperCase().match(/\b([A-Z]{3,4})\s*[- ]?\s*([0-9OIL]{4})\b/);
  if(!m) return String(value||'').trim().toUpperCase();
  return `${m[1]} ${m[2].replace(/O/g,'0').replace(/[IL]/g,'1')}`;
}
function courseColor(course){ return course?.settings?.schedule_box_color || '#A9D18D'; }
function activeProfile(){ return state.profiles[state.active_profile_id]; }
function activeCourse(){ const p=activeProfile(); return route.courseId ? p.courses[route.courseId] : null; }
function orderedCourses(profile=activeProfile()) { return profile.course_order.map(id=>profile.courses[id]).filter(Boolean); }
function formatDateTime(value){ if(!value) return ''; const d=new Date(value); return Number.isNaN(+d)?String(value):d.toLocaleString([], {dateStyle:'medium', timeStyle:'short'}); }
function minutesLabel(minutes){ const h=Math.floor(minutes/60), m=minutes%60; const d=new Date(); d.setHours(h,m,0,0); return d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}); }
function localDateKey(d=new Date()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function mondayOf(date){ const d=new Date(date); d.setHours(0,0,0,0); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); return d; }
function addDays(date,n){ const d=new Date(date); d.setDate(d.getDate()+n); return d; }
function dateKey(d){ return localDateKey(d); }
function parseDateKey(s){ const [y,m,d]=String(s||'').split('-').map(Number); return new Date(y,m-1,d); }
function downloadBlob(blob,name){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); }
function toast(message, ms=2400){ clearTimeout(toastTimer); els.toast.textContent=message; els.toast.hidden=false; toastTimer=setTimeout(()=>els.toast.hidden=true,ms); }


let cloudOfflineBypass = false;
let cloudChoiceModalOpen = false;
let cloudConflictModalOpen = false;
function cloudApi(){ return window.StudyHubCloud || null; }
function cloudStatus(){ return cloudApi()?.getStatus?.() || {available:false,signedIn:false,phase:'local',message:'Local only'}; }
function cloudPhaseLabel(s=cloudStatus()){
  if(!s.available)return '☁ Local';
  if(!s.signedIn)return '☁ Sign in';
  if(s.phase==='synced')return '☁ Synced';
  if(s.phase==='syncing'||s.phase==='pending')return s.pendingChanges?`☁ Syncing (${s.pendingChanges})`:'☁ Syncing';
  if(s.phase==='offline')return s.pendingChanges?`☁ Offline (${s.pendingChanges})`:'☁ Offline';
  if(s.phase==='conflict')return '⚠ Conflict';
  if(s.phase==='needs-choice')return '⚠ Setup';
  if(s.phase==='error')return '⚠ Cloud';
  return '☁ Cloud';
}
function updateCloudIndicator(s=cloudStatus()){
  if(!els.cloudIndicator)return;
  els.cloudIndicator.textContent=cloudPhaseLabel(s);
  els.cloudIndicator.dataset.phase=s.phase||'local';
  els.cloudIndicator.title=s.message||'Cloud sync';
}
function showAuthGate(show=true,message='',kind=''){
  if(!els.authGate)return;
  els.authGate.hidden=!show;
  if(show){
    const msg=els.authMessage; if(msg){msg.textContent=message||'';msg.className=`auth-message ${kind}`.trim();}
    setTimeout(()=>els.authEmail?.focus(),0);
  }
}
function setAuthBusy(busy){
  [els.authSignin,els.authSignup,els.authReset].forEach(b=>{if(b)b.disabled=Boolean(busy);});
}
async function authSignIn(){
  const api=cloudApi(); if(!api)return;
  const email=els.authEmail.value.trim(),password=els.authPassword.value;
  if(!email||!password)return showAuthGate(true,'Enter your email and password.','error');
  setAuthBusy(true);showAuthGate(true,'Signing in…');
  try{await api.signIn(email,password);cloudOfflineBypass=false;showAuthGate(false);}
  catch(err){showAuthGate(true,err.message||String(err),'error');}
  finally{setAuthBusy(false);}
}
async function authSignUp(){
  const api=cloudApi(); if(!api)return;
  const email=els.authEmail.value.trim(),password=els.authPassword.value;
  if(!email||!password)return showAuthGate(true,'Enter an email and password first.','error');
  if(password.length<6)return showAuthGate(true,'Use a password of at least 6 characters.','error');
  setAuthBusy(true);showAuthGate(true,'Creating account…');
  try{const data=await api.signUp(email,password);if(data?.session){cloudOfflineBypass=false;showAuthGate(false);}else showAuthGate(true,'Account created. Check your email for the Supabase confirmation link, then return here and sign in.','success');}
  catch(err){showAuthGate(true,err.message||String(err),'error');}
  finally{setAuthBusy(false);}
}
async function authReset(){
  const api=cloudApi(); if(!api)return;
  const email=els.authEmail.value.trim(); if(!email)return showAuthGate(true,'Enter your email address first.','error');
  setAuthBusy(true);
  try{await api.resetPassword(email);showAuthGate(true,'Password-reset email sent.','success');}
  catch(err){showAuthGate(true,err.message||String(err),'error');}
  finally{setAuthBusy(false);}
}
async function reloadStateFromDisk(){
  state=normalizeState(await idbGet(STORES.meta,'state'));
  const p=activeProfile();
  if(route.page==='course'&&!p.courses[route.courseId])route={page:'dashboard',courseId:null,tab:'Overview'};
  render();
}
function showInitialCloudChoice(){
  const api=cloudApi(); if(!api?.getInitialChoice?.()||cloudChoiceModalOpen)return;
  cloudChoiceModalOpen=true;
  modal(`<h2>Choose your first cloud copy</h2><p class="card-subtitle">This device already contains University Study Hub data, and this account already has cloud data. Choose which copy should become active on this device.</p><div class="cloud-warning"><strong>Secondary device:</strong> choose <b>Use cloud data</b>.<br><strong>Main device with newer work:</strong> choose <b>Upload this device</b>.</div><div class="action-row" style="margin-top:16px"><button id="cloud-choice-cloud" class="primary-button">Use cloud data</button><button id="cloud-choice-local" class="secondary-button">Upload this device</button></div>`,null,{saveLabel:null});
  const finish=async which=>{try{toast(which==='cloud'?'Downloading cloud workspace…':'Uploading this device…',4000);await api.chooseInitialSource(which);closeModal();cloudChoiceModalOpen=false;await reloadStateFromDisk();toast('Cloud setup complete.');}catch(err){cloudChoiceModalOpen=false;toast(`Cloud setup failed: ${err.message||err}`,5000);}};
  document.getElementById('cloud-choice-cloud').onclick=()=>finish('cloud');
  document.getElementById('cloud-choice-local').onclick=()=>finish('local');
  document.querySelector('#modal-root [data-modal-cancel]').onclick=()=>{cloudChoiceModalOpen=false;closeModal();};
}
function showCloudConflict(){
  const api=cloudApi(),conflict=api?.getConflict?.(); if(!conflict||cloudConflictModalOpen)return;
  cloudConflictModalOpen=true;
  const isDoc=conflict.kind==='document';
  const paths=(conflict.conflictPaths||[]).slice(0,5);
  const detail=paths.length?`<div class="cloud-warning"><strong>Conflicting field${paths.length===1?'':'s'}:</strong><br>${paths.map(escapeHtml).join('<br>')}</div>`:'';
  const copy=isDoc
    ? 'The same Lecture changed independently on this device and another device. Only this Lecture is paused; unrelated courses and Lectures keep syncing.'
    : 'The same data field changed independently on two devices. Unrelated changes were already merged automatically; only the field(s) listed below need your choice.';
  const cloudLabel=isDoc?'Use cloud Lecture':'Use cloud for conflicting fields';
  const localLabel=isDoc?'Keep this device Lecture':'Keep this device for conflicting fields';
  modal(`<h2>Cloud sync conflict</h2><p class="card-subtitle">${copy}</p>${detail}<div class="cloud-danger">Nothing outside the conflicting Lecture/field will be overwritten. <b>Export full backup</b> remains available in Settings.</div><div class="action-row" style="margin-top:16px"><button id="cloud-conflict-cloud" class="primary-button">${cloudLabel}</button><button id="cloud-conflict-local" class="secondary-button">${localLabel}</button></div>`,null,{saveLabel:null});
  const finish=async which=>{try{toast('Resolving cloud conflict…',3500);await api.resolveConflict(which);closeModal();cloudConflictModalOpen=false;await reloadStateFromDisk();toast('Conflict resolved.');}catch(err){cloudConflictModalOpen=false;toast(`Conflict resolution failed: ${err.message||err}`,5000);}};
  document.getElementById('cloud-conflict-cloud').onclick=()=>finish('cloud');
  document.getElementById('cloud-conflict-local').onclick=()=>finish('local');
  document.querySelector('#modal-root [data-modal-cancel]').onclick=()=>{cloudConflictModalOpen=false;closeModal();};
}
function cloudSettingsHtml(){
  const s=cloudStatus(),user=cloudApi()?.getUser?.();
  const last=s.lastSync?formatDateTime(s.lastSync):'Not synced yet';
  if(!s.available)return `<section class="card"><div class="card-header"><div><h2>Cloud Sync</h2><div class="card-subtitle">Supabase library is unavailable. The app is still saving locally and will reconnect automatically.</div></div></div></section>`;
  if(!s.signedIn)return `<section class="card"><div class="card-header"><div><h2>Cloud Sync</h2><div class="card-subtitle">Sign in to automatically keep Windows, Mac and iPad synchronized.</div></div><button id="cloud-open-signin" class="primary-button">Sign in</button></div><p class="form-help">Local/offline saving continues even when you are signed out.</p></section>`;
  const pending=Number(s.pendingChanges||0);
  const shortDevice=String(s.deviceId||cloudApi()?.deviceId?.()||'').slice(-10);
  return `<section class="card"><div class="card-header"><div><h2>Cloud Sync</h2><div class="card-subtitle">Phase 7 local-first synchronization • automatic reconnect, offline queue and per-Lecture conflict protection</div></div></div>
    <div class="cloud-status-grid"><div><div class="cloud-status-line"><span class="cloud-status-dot ${escapeHtml(s.phase||'')}"></span><strong>${escapeHtml(s.message||'Cloud')}</strong></div><div class="cloud-account-email">${escapeHtml(user?.email||'')} • Last sync: ${escapeHtml(last)} • Device …${escapeHtml(shortDevice)}</div></div><div class="action-row"><button id="cloud-sync-now" class="primary-button">Sync now</button><button id="cloud-signout" class="secondary-button">Sign out</button></div></div>
    ${pending?`<div class="cloud-warning"><strong>${pending}</strong> local change${pending===1?'':'s'} waiting to finish cloud sync.</div>`:''}
    ${s.needsChoice?'<div class="cloud-warning">Cloud and local data both exist on this device. <button id="cloud-resolve-setup" class="secondary-button" style="margin-left:8px">Choose copy</button></div>':''}
    ${s.conflict?'<div class="cloud-danger">A genuine simultaneous-edit conflict is waiting for your choice. <button id="cloud-resolve-conflict" class="secondary-button" style="margin-left:8px">Resolve</button></div>':''}
    <div class="cloud-warning"><strong>Phase 8 migration:</strong> use this only on the one device containing your complete/authoritative workspace. <button id="cloud-make-master" class="secondary-button" style="margin-left:8px">Make this device cloud master</button></div>
    <p class="form-help">Changes save locally first. Offline work is queued in IndexedDB and uploads automatically after reconnecting. Unrelated course changes merge automatically. The same Lecture edited simultaneously pauses only that Lecture. PDFs use versioned private cloud objects.</p>
  </section>`;
}
function bindCloudSettings(){
  const api=cloudApi();
  document.getElementById('cloud-open-signin')?.addEventListener('click',()=>showAuthGate(true));
  document.getElementById('cloud-sync-now')?.addEventListener('click',async()=>{try{toast('Syncing…');await api?.flushNow?.();renderSettings();}catch(err){toast(`Sync failed: ${err.message||err}`,4500);}});
  document.getElementById('cloud-signout')?.addEventListener('click',async()=>{if(!confirm('Sign out of cloud sync on this device? Local data will remain here.'))return;try{await api.signOut();renderSettings();showAuthGate(true);}catch(err){toast(`Sign out failed: ${err.message||err}`,4500);}});
  document.getElementById('cloud-resolve-setup')?.addEventListener('click',showInitialCloudChoice);
  document.getElementById('cloud-resolve-conflict')?.addEventListener('click',showCloudConflict);
  document.getElementById('cloud-make-master')?.addEventListener('click',async()=>{
    if(!confirm('Phase 8 migration: replace the cloud workspace with EVERYTHING currently stored on this device? Use this only on your one authoritative device.'))return;
    if(!confirm('Final confirmation: this device will become the cloud master. Other devices should use/download the cloud copy afterward.'))return;
    try{toast('Uploading this device as cloud master…',5000);await api?.promoteLocalToCloud?.();renderSettings();toast('Phase 8 complete: this device is now the cloud master.',5000);}catch(err){toast(`Cloud-master upload failed: ${err.message||err}`,6000);}
  });
}
async function setupCloud(){
  const api=cloudApi();
  if(!api){updateCloudIndicator({available:false,phase:'local',message:'Cloud unavailable'});return;}
  api.onStatus(s=>{
    updateCloudIndicator(s);
    if(s.signedIn)showAuthGate(false);
    else if(s.available&&!cloudOfflineBypass)showAuthGate(true);
    if(s.needsChoice)setTimeout(showInitialCloudChoice,0);
    if(s.conflict)setTimeout(showCloudConflict,0);
    if(route.page==='settings'&&state)setTimeout(()=>{try{renderSettings();}catch(_e){}},0);
  });
  window.addEventListener('studyhub-cloud-remote',async()=>{try{await reloadStateFromDisk();toast('Updated from another device.');}catch(err){console.error(err);}});
  await api.init();
  const s=api.getStatus();updateCloudIndicator(s);
  if(s.available&&!s.signedIn&&!cloudOfflineBypass)showAuthGate(true);
}


function bytesToHex(bytes){ return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function hexToBytes(hex){
  const clean=String(hex||'').trim();
  if(!clean || clean.length%2) throw new Error('Invalid deletion PIN salt.');
  const out=new Uint8Array(clean.length/2);
  for(let i=0;i<out.length;i++){ const n=Number.parseInt(clean.slice(i*2,i*2+2),16); if(!Number.isFinite(n))throw new Error('Invalid deletion PIN salt.'); out[i]=n; }
  return out;
}
async function deletionPinDigest(pin,saltHex){
  if(!crypto?.subtle) throw new Error('Deletion PIN verification requires a secure app connection (HTTPS or the native iPad app).');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pin),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:hexToBytes(saltHex),iterations:120000},key,256);
  return bytesToHex(new Uint8Array(bits));
}
function deletionPinConfigured(profile=activeProfile()){
  const settings=profile?.settings||{};
  return Boolean(settings.deletion_pin_salt&&settings.deletion_pin_hash);
}
function validDeletionPin(pin){ return /^\d{1,6}$/.test(String(pin||'')); }
async function storeDeletionPin(pin,profile=activeProfile()){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  profile.settings ||= {};
  profile.settings.deletion_pin_salt=bytesToHex(salt);
  profile.settings.deletion_pin_hash=await deletionPinDigest(pin,profile.settings.deletion_pin_salt);
  queueSave();
}
async function verifyDeletionPinValue(pin,profile=activeProfile()){
  if(!deletionPinConfigured(profile))return false;
  try{return (await deletionPinDigest(pin,profile.settings.deletion_pin_salt))===String(profile.settings.deletion_pin_hash||'').toLowerCase();}
  catch(err){console.error(err);throw err;}
}
function deletionPinDialog({createNew=false,heading,message,profile=activeProfile()}={}){
  return new Promise(resolve=>{
    const finish=value=>{closeModal();resolve(Boolean(value));};
    els.modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal">
      <h2>${escapeHtml(heading||(createNew?'Create Deletion PIN':'Verify Deletion'))}</h2>
      <p class="card-subtitle">${escapeHtml(message||(createNew?'Create a numeric deletion PIN of up to 6 digits. It will be required whenever protected content is deleted.':'Enter your deletion PIN to continue.'))}</p>
      <div class="field" style="margin-top:14px"><label>Deletion PIN</label><input id="deletion-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="1–6 digit PIN"></div>
      ${createNew?'<div class="field" style="margin-top:10px"><label>Confirm PIN</label><input id="deletion-pin-confirm" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="Confirm PIN"></div>':''}
      <div id="deletion-pin-error" class="form-help" style="min-height:20px;color:var(--danger);margin-top:8px"></div>
      <div class="modal-actions"><button class="secondary-button" id="deletion-pin-cancel">Cancel</button><button class="primary-button" id="deletion-pin-save">${createNew?'Save PIN':'Continue'}</button></div>
    </div></div>`;
    const root=els.modalRoot, pin=root.querySelector('#deletion-pin'), error=root.querySelector('#deletion-pin-error');
    root.querySelector('#deletion-pin-cancel').onclick=()=>finish(false);
    root.querySelector('.modal-backdrop').addEventListener('pointerdown',e=>{if(e.target===e.currentTarget)finish(false);});
    const submit=async()=>{
      const value=pin.value.trim();
      if(!validDeletionPin(value)){error.textContent='PIN must contain only 1–6 digits.';pin.focus();return;}
      if(createNew){
        const confirmValue=root.querySelector('#deletion-pin-confirm').value.trim();
        if(value!==confirmValue){error.textContent='PINs do not match.';root.querySelector('#deletion-pin-confirm').focus();return;}
        try{await storeDeletionPin(value,profile);finish(true);}catch(err){error.textContent=err.message||String(err);}
        return;
      }
      try{if(await verifyDeletionPinValue(value,profile))finish(true);else{error.textContent='Incorrect deletion PIN.';pin.value='';pin.focus();}}catch(err){error.textContent=err.message||String(err);}
    };
    root.querySelector('#deletion-pin-save').onclick=submit;
    root.querySelectorAll('input').forEach(input=>input.addEventListener('keydown',e=>{if(e.key==='Enter')submit();}));
    setTimeout(()=>pin.focus(),0);
  });
}
async function requireDeletionPin(actionDescription,profile=activeProfile()){
  if(!deletionPinConfigured(profile)){
    return deletionPinDialog({createNew:true,heading:'Create Deletion PIN',message:'Deletion protection is not configured yet. Create a numeric PIN of up to 6 digits to continue with this deletion.',profile});
  }
  return deletionPinDialog({heading:'Verify Deletion',message:`Enter your deletion PIN to ${actionDescription}.`,profile});
}
async function changeDeletionPin(){
  const p=activeProfile(), already=deletionPinConfigured(p);
  if(already){const ok=await deletionPinDialog({heading:'Verify Current PIN',message:'Enter your current deletion PIN before changing it.',profile:p});if(!ok)return;}
  const ok=await deletionPinDialog({createNew:true,heading:already?'Change Deletion PIN':'Set Deletion PIN',message:'Choose a numeric deletion PIN of up to 6 digits.',profile:p});
  if(ok){await saveStateNow();toast(already?'Deletion PIN changed.':'Deletion PIN set.');renderSettings();}
}

function defaultProfile(name='Default'){
  const id=uid('profile');
  return {
    id, display_name:name, created_at:nowIso(),
    settings:{theme:'Dark',scroll_sensitivity:100,audio:{music_enabled:false,music_paused:false,shuffle:false,music_volume:.3,click_enabled:false,click_volume:.55,music_track:'alex-morgan-study-jazz-study-music-564277.mp3'}},
    courses:{}, course_order:[], recent_activity:[], tasks:[],
    schedule:{term_start_date:localDateKey(),course_meetings:{},imported_occurrences:[],display_options:{show_ampm:true,show_class_title:false,show_instructors:false,days:Object.fromEntries(DAY_NAMES.map(d=>[d,true])),start_minute:480,end_minute:1350},calendar_week:dateKey(mondayOf(new Date())),personal_events:[]},
    ui_state:{last_page:'Dashboard',last_course_id:null}, personal_notes:[]
  };
}
function defaultState(){ const p=defaultProfile(); return {schema_version:2, active_profile_id:p.id, profiles:{[p.id]:p}, app:{last_saved:nowIso(),version:APP_VERSION}}; }
function normalizeState(raw){
  const out = raw && typeof raw==='object' ? structuredClone(raw) : defaultState();
  if(!out.profiles || typeof out.profiles!=='object') return defaultState();
  const ids=Object.keys(out.profiles); if(!ids.length) return defaultState();
  if(!out.active_profile_id || !out.profiles[out.active_profile_id]) out.active_profile_id=ids[0];
  for(const p of Object.values(out.profiles)){
    p.settings ||= {}; p.settings.scroll_sensitivity ||=100; p.settings.audio ||= defaultProfile().settings.audio;
    p.courses ||= {}; p.course_order ||= Object.keys(p.courses); p.personal_notes ||= []; p.recent_activity ||= []; p.tasks ||= [];
    p.schedule ||= defaultProfile().schedule; p.schedule.term_start_date ||= localDateKey(); p.schedule.course_meetings ||= {}; p.schedule.personal_events ||= []; p.schedule.display_options ||= defaultProfile().schedule.display_options; p.schedule.calendar_week ||= dateKey(mondayOf(new Date()));
    p.ui_state ||= {last_page:'Dashboard',last_course_id:null};
    for(const c of Object.values(p.courses)){
      c.id ||= uid('course'); c.code ||= 'COURSE'; c.name ||= ''; c.materials ||= []; c.material_units ||= []; c.notes ||= []; c.questions ||= []; c.test_history ||= []; c.notifications ||= []; c.grading ||= []; c.ui_state ||= {last_tab:'Overview'}; c.settings ||= {schedule_font_color:'#102010',schedule_box_color:'#A9D18D'};
    }
  }
  out.schema_version=2; out.app ||= {}; out.app.version=APP_VERSION;
  return out;
}

function openDb(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{ const db=req.result; for(const name of Object.values(STORES)) if(!db.objectStoreNames.contains(name)) db.createObjectStore(name); };
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}
async function idbGet(store,key){ const db=await openDb(); return new Promise((res,rej)=>{ const tx=db.transaction(store,'readonly'); const r=tx.objectStore(store).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(store,key,value){ const db=await openDb(); return new Promise((res,rej)=>{ const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(value,key); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbDelete(store,key){ const db=await openDb(); return new Promise((res,rej)=>{ const tx=db.transaction(store,'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function idbEntries(store){ const db=await openDb(); return new Promise((res,rej)=>{ const tx=db.transaction(store,'readonly'); const s=tx.objectStore(store); const out=[]; const r=s.openCursor(); r.onsuccess=()=>{ const c=r.result; if(!c) return res(out); out.push([c.key,c.value]); c.continue(); }; r.onerror=()=>rej(r.error); }); }
async function idbClear(store){ const db=await openDb(); return new Promise((res,rej)=>{ const tx=db.transaction(store,'readwrite'); tx.objectStore(store).clear(); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); }
async function loadState(){ state=normalizeState(await idbGet(STORES.meta,'state')); await saveStateNow(false,false); }
function queueSave(cloudDirty=true){
  stateSavePending=true;
  stateCloudDirtyPending ||= Boolean(cloudDirty);
  els.saveIndicator.textContent='Saving…'; els.saveIndicator.style.color='var(--muted)';
  clearTimeout(saveTimer); saveTimer=setTimeout(()=>saveStateNow(true,false),120);
}
async function saveStateNow(show=true,cloudDirty=false){
  clearTimeout(saveTimer); saveTimer=null;
  const pendingCloud=stateCloudDirtyPending; stateSavePending=false; stateCloudDirtyPending=false;
  state.app ||= {}; state.app.last_saved=nowIso(); state.app.version=APP_VERSION;
  await idbSet(STORES.meta,'state',state);
  if(cloudDirty||pendingCloud)cloudApi()?.markStateDirty?.().catch(console.error);
  if(show){ els.saveIndicator.textContent='✓ Saved'; els.saveIndicator.style.color='var(--success)'; }
}

function navTo(page, opts={}){
  route.page=page; route.courseId=opts.courseId ?? (page==='course'?route.courseId:null); route.tab=opts.tab || route.tab || 'Overview';
  const p=activeProfile(); p.ui_state.last_page=page; if(route.courseId) p.ui_state.last_course_id=route.courseId;
  queueSave(false); render();
  if(window.innerWidth<821) closeNav();
}
function normalizeCourseTab(tab){ return ['Overview','Study Material'].includes(tab)?tab:'Overview'; }
function courseTabForSwitch(courseId){
  const target=activeProfile().courses[courseId];
  if(route.page==='course') return normalizeCourseTab(route.tab);
  return normalizeCourseTab(target?.ui_state?.last_tab||'Overview');
}
function keyboardNavigationIsBlocked(event){
  if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return true;
  if(event.repeat)return true;
  if(els.authGate&&!els.authGate.hidden)return true;
  if(els.modalRoot?.children?.length)return true;
  const target=event.target instanceof Element?event.target:null;
  if(target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))return true;
  return false;
}
function keyboardNavigationItems(){
  return [
    {page:'dashboard'},
    {page:'notes'},
    ...orderedCourses().map(course=>({page:'course',courseId:course.id})),
    {page:'schedule'},
    {page:'settings'},
  ];
}
function keyboardNavigationIndex(items){
  if(route.page==='course')return items.findIndex(item=>item.page==='course'&&item.courseId===route.courseId);
  return items.findIndex(item=>item.page===route.page);
}
function moveVerticalNavigation(delta){
  const s=activeProfile().schedule;
  if(route.page==='schedule'&&(s._web_view||'calendar')!=='setup')return false;
  if(!['dashboard','notes','course','schedule','settings'].includes(route.page))return false;
  const items=keyboardNavigationItems(),index=keyboardNavigationIndex(items);
  if(index<0)return false;
  const target=items[index+delta];
  if(!target)return false;
  if(target.page==='course'){
    navTo('course',{courseId:target.courseId,tab:route.page==='course'?normalizeCourseTab(route.tab):courseTabForSwitch(target.courseId)});
  }else{
    if(target.page==='schedule')s._web_view='setup';
    navTo(target.page);
  }
  return true;
}
function changeScheduleCalendarWeek(deltaWeeks){
  const s=activeProfile().schedule;
  const base=parseDateKey(s.calendar_week||dateKey(mondayOf(new Date())));
  s.calendar_week=dateKey(addDays(base,deltaWeeks*7));
  queueSave(false);renderSchedule();
}
function handleGlobalNavigationKeydown(event){
  if(keyboardNavigationIsBlocked(event))return;
  const scheduleView=route.page==='schedule'?(activeProfile().schedule._web_view||'calendar'):null;
  if(scheduleView==='calendar'&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
    event.preventDefault();
    changeScheduleCalendarWeek(event.key==='ArrowLeft'?-1:1);
    return;
  }
  if(event.key==='ArrowUp'||event.key==='ArrowDown'){
    if(moveVerticalNavigation(event.key==='ArrowUp'?-1:1))event.preventDefault();
  }
}
function openNav(){ document.body.classList.add('nav-open'); els.scrim.hidden=false; }
function closeNav(){ document.body.classList.remove('nav-open'); els.scrim.hidden=true; }

function renderSidebar(){
  const p=activeProfile();
  const primary=[['dashboard','⌂','Dashboard'],['notes','✎','Notes']];
  const utility=[['schedule','▦','Schedule'],['settings','⚙','Settings']];
  els.primaryNav.innerHTML=primary.map(([id,icon,label])=>`<button class="nav-item ${route.page===id?'active':''}" data-nav="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`).join('');
  els.utilityNav.innerHTML=utility.map(([id,icon,label])=>`<button class="nav-item ${route.page===id?'active':''}" data-nav="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`).join('');
  els.courseNav.innerHTML=orderedCourses(p).map(c=>`<button class="course-nav-item ${route.page==='course'&&route.courseId===c.id?'active':''}" data-course="${c.id}"><span class="course-dot" style="background:${escapeHtml(courseColor(c))}"></span><span class="course-code">${escapeHtml(c.code)}</span></button>`).join('');
  els.profileSelect.innerHTML=Object.values(state.profiles).map(profile=>`<option value="${profile.id}" ${profile.id===state.active_profile_id?'selected':''}>${escapeHtml(profile.display_name)}</option>`).join('');
}
function setHeader(title,subtitle='') { els.pageTitle.textContent=title; els.pageSubtitle.textContent=subtitle; }
function render(){
  clearInterval(liveTimer); liveTimer=null; renderSidebar(); applySettings();
  const page=route.page;
  if(page==='dashboard') renderDashboard(); else if(page==='notes') renderNotes(); else if(page==='schedule') renderSchedule(); else if(page==='settings') renderSettings(); else if(page==='course') renderCourse(); else renderDashboard();
}

function eventDue(notification){ return notification?.due_at ? new Date(notification.due_at) : null; }
function upcomingEvents(){
  const p=activeProfile(), now=new Date(), out=[];
  for(const c of orderedCourses(p)) for(const e of c.notifications||[]){ const d=eventDue(e); if(d && d>=now) out.push({course:c,event:e,date:d}); }
  return out.sort((a,b)=>a.date-b.date);
}
function needsAttention(){
  const now=Date.now(), out=[]; for(const c of orderedCourses()) for(const m of c.materials||[]){ const t=Date.parse(m.last_opened_at||m.updated_at||m.created_at||''); if(Number.isFinite(t)&&now-t>72*3600*1000) out.push({course:c,material:m,age:now-t}); }
  return out.sort((a,b)=>b.age-a.age).slice(0,12);
}
function renderDashboard(){
  const p=activeProfile(), events=upcomingEvents(), attention=needsAttention();
  setHeader('Dashboard',`${p.display_name} • University workspace`);
  const next=events[0];
  els.page.innerHTML=`<div class="page-stack">
    <section class="card"><div class="card-header"><div><h2>Upcoming Event</h2><div class="card-subtitle">Your closest deadline across all courses</div></div><div id="dashboard-clock" class="event-clock">${next?timeLeft(next.date):'—'}</div></div>
      ${next?`<div class="list-item"><span class="course-dot" style="background:${courseColor(next.course)}"></span><div class="list-main"><div class="list-title">${escapeHtml(next.event.title||next.event.type||'Event')}</div><div class="list-copy">${escapeHtml(next.course.code)} • ${formatDateTime(next.event.due_at)}</div></div><button class="secondary-button" data-course-open="${next.course.id}">Open course</button></div>`:`<div class="empty">No upcoming events.</div>`}
    </section>
    <section class="card"><div class="card-header"><div><h2>Needs attention</h2><div class="card-subtitle">Lecture documents not opened for 72 hours or more</div></div></div>
      <div class="list">${attention.length?attention.map(x=>`<div class="list-item"><span class="material-icon">📄</span><div class="list-main"><div class="list-title">${escapeHtml(x.material.title||'Untitled Document')}</div><div class="list-copy">${escapeHtml(x.course.code)} • ${Math.floor(x.age/86400000)} days since last opened</div></div><button class="secondary-button" data-open-material="${x.course.id}|${x.material.id}">Open</button></div>`).join(''):'<div class="empty">Everything is current.</div>'}</div>
    </section>
    <section class="card"><div class="card-header"><h2>Courses</h2><button id="dashboard-add-course" class="primary-button">＋ Add course</button></div><div class="grid-3">${orderedCourses(p).map(c=>courseCard(c)).join('')||'<div class="empty">Add your first course.</div>'}</div></section>
  </div>`;
  if(next) liveTimer=setInterval(()=>{ const e=document.getElementById('dashboard-clock'); if(e)e.textContent=timeLeft(next.date); },1000);
  bindPageCommon(); document.getElementById('dashboard-add-course')?.addEventListener('click',()=>courseDialog());
}
function timeLeft(target){ let ms=target-new Date(); if(ms<=0) return 'Due'; const d=Math.floor(ms/86400000); ms%=86400000; const h=Math.floor(ms/3600000); ms%=3600000; const m=Math.floor(ms/60000); const s=Math.floor((ms%60000)/1000); return d?`${d}d ${h}h ${m}m`:`${h}h ${m}m ${s}s`; }
function courseCard(c){
  const events=(c.notifications||[]).filter(e=>{const d=eventDue(e);return d&&d>=new Date()}).length;
  return `<button class="card" style="text-align:left;cursor:pointer" data-course-open="${c.id}"><div style="height:8px;border-radius:999px;background:${courseColor(c)};margin-bottom:13px"></div><div style="font-size:20px;font-weight:850">${escapeHtml(c.code)}</div><div class="card-subtitle">${escapeHtml(c.name||'University course')}</div><div class="stat-row" style="grid-template-columns:1fr 1fr;margin-top:15px"><div class="stat"><span>Lectures</span><strong>${c.materials.length}</strong></div><div class="stat"><span>Events</span><strong>${events}</strong></div></div></button>`;
}

function renderCourse(){
  clearInterval(liveTimer); liveTimer=null;
  const c=activeCourse(); if(!c){ route.page='dashboard'; return renderDashboard(); }
  const tabs=['Overview','Study Material'];
  c.ui_state ||= {last_tab:'Overview'};
  if(!route.tab) route.tab=c.ui_state.last_tab||'Overview';
  if(!tabs.includes(route.tab)) route.tab='Overview';
  c.ui_state.last_tab=route.tab;
  setHeader(c.code, c.name||'Course workspace');
  const body=route.tab==='Study Material'?courseMaterials(c):courseOverview(c);
  els.page.innerHTML=`<div class="page-stack"><div class="course-tabs">${tabs.map(t=>`<button class="course-tab ${route.tab===t?'active':''}" data-course-tab="${t}">${t}</button>`).join('')}<button class="course-tab" id="course-menu">•••</button></div>${body}</div>`;
  bindCoursePage(c);
  if(route.tab==='Overview'){
    updateCourseEventCountdowns();
    liveTimer=setInterval(updateCourseEventCountdowns,1000);
  }
}
function courseOverview(c){
  const events=(c.notifications||[]).slice().sort((a,b)=>String(a.due_at||'').localeCompare(String(b.due_at||'')));
  return `<section class="card"><div class="card-header"><div><h2>Events</h2><div class="card-subtitle">Homework, exams and other deadlines for ${escapeHtml(c.code)}</div></div><button id="add-event" class="primary-button">＋ Event</button></div><div class="list">${events.length?events.map(e=>`<div class="list-item course-event-item"><div class="list-main"><div class="list-title">${escapeHtml(e.title||e.type||'Event')}</div><div class="list-copy">${formatDateTime(e.due_at)}${e.note?` • ${escapeHtml(e.note)}`:''}</div></div><span class="event-countdown pill" data-event-countdown="${escapeHtml(e.due_at||'')}">${eventDue(e)?timeLeft(eventDue(e)):'—'}</span><span class="pill">${escapeHtml(e.type||'Event')}</span><button class="danger-button" data-delete-event="${e.id}">Delete</button></div>`).join(''):'<div class="empty">No events saved.</div>'}</div></section>`;
}
function updateCourseEventCountdowns(){
  els.page.querySelectorAll('[data-event-countdown]').forEach(el=>{
    const due=new Date(el.dataset.eventCountdown||'');
    el.textContent=Number.isNaN(+due)?'—':timeLeft(due);
  });
}
function courseMaterials(c){
  const units=c.material_units||[]; const byUnit=new Map(units.map(u=>[u.id,[]])); const loose=[]; for(const m of c.materials){ if(m.unit_id&&byUnit.has(m.unit_id)) byUnit.get(m.unit_id).push(m); else loose.push(m); }
  const unitHtml=units.map(u=>`<section class="material-unit"><div class="material-unit-head"><strong style="flex:1">${escapeHtml(u.title||'Unit')}</strong><button class="secondary-button" data-unit-rename="${u.id}">Rename</button><button class="danger-button" data-unit-delete="${u.id}">Delete</button></div><div class="material-unit-body">${materialCards(c,byUnit.get(u.id))||'<div class="empty">No lectures in this unit.</div>'}</div></section>`).join('');
  return `<section class="card"><div class="card-header"><div><h2>Study Material</h2><div class="card-subtitle">Lecture documents, PDFs, terms and quizzes</div></div><div class="action-row"><button id="add-unit" class="secondary-button">＋ Unit</button><button id="add-lecture" class="primary-button">＋ Lecture</button></div></div><div class="list" style="gap:12px">${unitHtml}${loose.length?`<section class="material-unit"><div class="material-unit-head"><strong>Ungrouped</strong></div><div class="material-unit-body">${materialCards(c,loose)}</div></section>`:''}${!units.length&&!loose.length?'<div class="empty">Create a Lecture to begin taking notes.</div>':''}</div></section>`;
}
function materialCards(c,materials){ return (materials||[]).map(m=>`<div class="material-card"><div class="material-icon">📄</div><div class="list-main"><div class="list-title">${escapeHtml(m.title||'Untitled Document')}</div><div class="list-copy">Updated ${formatDateTime(m.updated_at||m.created_at)}</div></div><div class="material-actions"><button class="primary-button" data-open-material="${c.id}|${m.id}">Open</button><button class="secondary-button" data-material-quiz="${m.id}">Quiz</button><button class="secondary-button" data-material-terms="${m.id}">Terms</button><button class="secondary-button" data-material-remove-pdf="${m.id}" hidden>Remove PDF</button><button class="danger-button" data-material-delete="${m.id}">Delete</button></div></div>`).join(''); }
function courseQuestions(c){
  return `<section class="card"><div class="card-header"><div><h2>Questions</h2><div class="card-subtitle">Questions created manually or from Lecture documents</div></div><button id="add-question" class="primary-button">＋ Question</button></div><div class="list">${c.questions.length?c.questions.map(q=>questionHtml(q,true)).join(''):'<div class="empty">No saved questions.</div>'}</div></section>`;
}
function questionHtml(q,withDelete=false){ return `<div class="question-card"><div class="question-prompt">${escapeHtml(q.prompt)}</div><div class="answer-reveal" data-reveal>Tap to reveal answer</div><div class="answer-value" hidden>${escapeHtml(q.answer)}</div>${withDelete?`<div class="action-row" style="margin-top:10px"><span class="pill">${q.stats?.attempts||0} attempts</span><button class="danger-button" data-question-delete="${q.id}">Delete</button></div>`:''}</div>`; }
function courseTesting(c){
  const qs=c.questions||[]; return `<section class="card"><div class="card-header"><div><h2>Testing</h2><div class="card-subtitle">Reveal answers and grade yourself</div></div></div><div class="list">${qs.length?qs.map(q=>`<div class="question-card" data-test-q="${q.id}"><div class="question-prompt">${escapeHtml(q.prompt)}</div><div class="answer-reveal" data-reveal>Tap to reveal answer</div><div class="answer-value" hidden>${escapeHtml(q.answer)}</div><div class="action-row" style="margin-top:10px"><button class="secondary-button" data-grade="incorrect|${q.id}">Incorrect</button><button class="primary-button" data-grade="correct|${q.id}">Correct</button><span class="pill">${q.stats?.correct||0} ✓ / ${q.stats?.incorrect||0} ✕</span></div></div>`).join(''):'<div class="empty">Add questions before starting a test.</div>'}</div></section>`;
}

function bindPageCommon(){
  els.page.querySelectorAll('[data-course-open]').forEach(b=>b.onclick=()=>navTo('course',{courseId:b.dataset.courseOpen,tab:'Overview'}));
  els.page.querySelectorAll('[data-open-material]').forEach(b=>b.onclick=()=>{ const [cid,mid]=b.dataset.openMaterial.split('|'); openMaterial(cid,mid); });
  els.page.querySelectorAll('[data-reveal]').forEach(b=>b.onclick=()=>{ const value=b.parentElement.querySelector('.answer-value')?.textContent||''; b.textContent=value; b.classList.add('revealed'); });
}
function bindCoursePage(c){
  bindPageCommon();
  els.page.querySelectorAll('[data-course-tab]').forEach(b=>b.onclick=()=>{route.tab=b.dataset.courseTab;c.ui_state.last_tab=route.tab;queueSave(false);renderCourse();});
  document.getElementById('course-menu')?.addEventListener('click',()=>courseMenu(c));
  document.getElementById('add-event')?.addEventListener('click',()=>eventDialog(c));
  els.page.querySelectorAll('[data-delete-event]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this event?'))return;if(!await requireDeletionPin('delete this event'))return;c.notifications=c.notifications.filter(x=>x.id!==b.dataset.deleteEvent);queueSave();renderCourse();});
  document.getElementById('add-lecture')?.addEventListener('click',()=>createLectureDialog(c));
  document.getElementById('add-unit')?.addEventListener('click',()=>unitDialog(c));
  els.page.querySelectorAll('[data-unit-rename]').forEach(b=>b.onclick=()=>unitDialog(c,c.material_units.find(u=>u.id===b.dataset.unitRename)));
  els.page.querySelectorAll('[data-unit-delete]').forEach(b=>b.onclick=()=>deleteUnit(c,b.dataset.unitDelete));
  els.page.querySelectorAll('[data-material-delete]').forEach(b=>b.onclick=()=>deleteMaterial(c,b.dataset.materialDelete));
  els.page.querySelectorAll('[data-material-remove-pdf]').forEach(async b=>{const doc=await idbGet(STORES.documents,b.dataset.materialRemovePdf);if(doc?.slides_attachment)b.hidden=false;b.onclick=()=>removeAssignedPdf(c,b.dataset.materialRemovePdf);});
  els.page.querySelectorAll('[data-material-quiz]').forEach(b=>b.onclick=()=>materialQuiz(c,b.dataset.materialQuiz));
  els.page.querySelectorAll('[data-material-terms]').forEach(b=>b.onclick=()=>materialTerms(c,b.dataset.materialTerms));
  document.getElementById('add-question')?.addEventListener('click',()=>questionDialog(c));
  els.page.querySelectorAll('[data-question-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this question?'))return;if(!await requireDeletionPin('delete this question'))return;c.questions=c.questions.filter(q=>q.id!==b.dataset.questionDelete);queueSave();renderCourse();});
  els.page.querySelectorAll('[data-grade]').forEach(b=>b.onclick=()=>{const [result,id]=b.dataset.grade.split('|');gradeQuestion(c,id,result==='correct');});
}

async function createLectureDialog(c){
  const unitOptions=(c.material_units||[]).map(u=>`<option value="${u.id}">${escapeHtml(u.title)}</option>`).join('');
  modal(`<h2>New Lecture</h2><div class="form-grid"><div class="field full"><label>Title</label><input id="lecture-title" value="" placeholder="Untitled Document"></div><div class="field full"><label>Unit</label><select id="lecture-unit"><option value="">Ungrouped</option>${unitOptions}</select></div></div>`, async root=>{
    const title=root.querySelector('#lecture-title').value.trim()||'Untitled Document'; const materialId=uid('material'); const t=nowIso();
    const material={id:materialId,type:'quill_document',title,file:`browser:${materialId}`,created_at:t,updated_at:t,last_opened_at:t,unit_id:root.querySelector('#lecture-unit').value||null,order:c.materials.length};
    c.materials.push(material); const doc={schema_version:1,id:materialId,title,delta:{ops:[{insert:'\n'}]},slides_attachment:null,editor_layout:{slides_visible:false,split_ratio:.5,slides_scroll_top:0,notes_scroll_top:0,document_format:'normal'},created_at:t,updated_at:t,slide_annotations:{settings:{marker_color:'#2457E6',highlighter_color:'#FFE14F',marker_size:'medium',highlighter_size:'medium',eraser_size:'medium'},strokes:[],texts:[],labels:[]},whiteboard:{exists:false,page_width:1390,page_height:1302,pages_x:1,pages_y:1,scroll_x:0,scroll_y:0,zoom_percent:100,drawings:[],texts:[]},image_occlusion:{reveal_seconds:3,boxes:[]}};
    await idbSet(STORES.documents,materialId,doc); cloudApi()?.markDocumentDirty?.(materialId).catch(console.error); queueSave(); closeModal(); renderCourse(); await openMaterial(c.id,materialId);
  });
}
function unitDialog(c,u=null){ modal(`<h2>${u?'Rename':'Add'} Unit</h2><div class="field"><label>Unit title</label><input id="unit-title" value="${escapeHtml(u?.title||'')}"></div>`,root=>{const title=root.querySelector('#unit-title').value.trim();if(!title)return; if(u)u.title=title; else c.material_units.push({id:uid('unit'),title,collapsed:false,order:c.material_units.length}); queueSave();closeModal();renderCourse();}); }
async function deleteUnit(c,id){ if(!confirm('Delete this unit? Lectures will move to Ungrouped.'))return;if(!await requireDeletionPin('delete this unit'))return;c.material_units=c.material_units.filter(u=>u.id!==id);for(const m of c.materials)if(m.unit_id===id)m.unit_id=null;queueSave();renderCourse(); }
async function deleteMaterial(c,id){ const title=c.materials.find(m=>m.id===id)?.title||'this Lecture';if(!confirm(`Delete ${title}? The Lecture document and assigned PDF will be permanently deleted.`))return;if(!await requireDeletionPin(`delete the lecture '${title}'`))return;c.materials=c.materials.filter(m=>m.id!==id);await idbDelete(STORES.documents,id);await idbDelete(STORES.blobs,`pdf:${id}`);cloudApi()?.markDocumentDeleted?.(id).catch(console.error);cloudApi()?.markBlobDeleted?.(`pdf:${id}`).catch(console.error);queueSave();renderCourse(); }
async function removeAssignedPdf(c,id){ const doc=await idbGet(STORES.documents,id);if(!doc?.slides_attachment)return toast('This Lecture has no assigned PDF.');const filename=doc.slides_attachment.display_name||'the assigned PDF';if(!confirm(`Remove ${filename} from this Lecture? Notes, questions and the Lecture will stay.`))return;if(!await requireDeletionPin(`remove the assigned PDF '${filename}'`))return;doc.slides_attachment=null;doc.editor_layout={...(doc.editor_layout||{}),slides_visible:false};doc.updated_at=nowIso();await idbSet(STORES.documents,id,doc);await idbDelete(STORES.blobs,`pdf:${id}`);cloudApi()?.markDocumentDirty?.(id).catch(console.error);cloudApi()?.markBlobDeleted?.(`pdf:${id}`).catch(console.error);const m=c.materials.find(x=>x.id===id);if(m)m.updated_at=doc.updated_at;queueSave();renderCourse();toast('Assigned PDF removed.'); }
async function openMaterial(courseId,materialId){
  const p=activeProfile(), c=p.courses[courseId], m=c?.materials.find(x=>x.id===materialId); if(!m)return;
  m.last_opened_at=nowIso(); queueSave();
  const params=new URLSearchParams({profile:state.active_profile_id,course:courseId,material:materialId});
  location.href=`editor/editor.html?${params}`;
}
async function materialTerms(c,id){ const doc=await idbGet(STORES.documents,id); const terms=extractTermRecords(doc?.delta); modal(`<h2>Terms — ${escapeHtml(c.materials.find(m=>m.id===id)?.title||'Lecture')}</h2><div class="list">${terms.length?terms.map(t=>`<div class="list-item"><div class="list-main"><div class="list-title">${escapeHtml(t.text)}</div></div><button class="danger-button" data-delete-term="${escapeHtml(t.id)}">Delete</button></div>`).join(''):'<div class="empty">No + Term highlights saved in this Lecture.</div>'}</div>`,null,{saveLabel:null}); document.querySelectorAll('#modal-root [data-delete-term]').forEach(b=>b.onclick=()=>deleteMaterialTerm(c,id,b.dataset.deleteTerm)); }
function extractTermRecords(delta){ const grouped=new Map();for(const op of delta?.ops||[]){if(typeof op.insert!=='string'||!op.attributes?.term)continue;const id=String(op.attributes.term),text=op.insert.replace(/\s+/g,' ');grouped.set(id,(grouped.get(id)||'')+text);}return [...grouped.entries()].map(([id,text])=>({id,text:text.trim()})).filter(x=>x.text); }
function extractTerms(delta){return extractTermRecords(delta).map(x=>x.text);}
async function deleteMaterialTerm(c,materialId,termId){const doc=await idbGet(STORES.documents,materialId);if(!doc)return;const term=extractTermRecords(doc.delta).find(t=>t.id===termId);if(!term)return;if(!confirm(`Remove this term?\n\n${term.text}\n\nIts light-green highlight will also be removed from the Lecture.`))return;if(!await requireDeletionPin('delete this term'))return;let changed=false;doc.delta={ops:(doc.delta?.ops||[]).map(op=>{if(!op||typeof op!=='object'||String(op.attributes?.term||'')!==termId)return op;const copy={...op},attrs={...(copy.attributes||{})};delete attrs.term;if(Object.keys(attrs).length)copy.attributes=attrs;else delete copy.attributes;changed=true;return copy;})};if(changed){doc.updated_at=nowIso();await idbSet(STORES.documents,materialId,doc);cloudApi()?.markDocumentDirty?.(materialId).catch(console.error);const m=c.materials.find(x=>x.id===materialId);if(m)m.updated_at=doc.updated_at;queueSave();}closeModal();materialTerms(c,materialId);}
function materialQuiz(c,id){
  const qs=c.questions.filter(q=>q.source_material_id===id);
  modal(`<h2>Lecture Quiz</h2><div class="list">${qs.length?qs.map(q=>questionHtml(q,true)).join(''):'<div class="empty">No questions have been created from this Lecture.</div>'}</div>`,null,{saveLabel:null,wide:true});
  const root=document.getElementById('modal-root');
  root.querySelectorAll('[data-reveal]').forEach(b=>b.onclick=()=>{const value=b.parentElement.querySelector('.answer-value')?.textContent||'';b.textContent=value;b.classList.add('revealed');});
  root.querySelectorAll('[data-question-delete]').forEach(b=>b.onclick=async()=>{
    const q=c.questions.find(x=>x.id===b.dataset.questionDelete);
    if(!q||!confirm('Delete this question from the Lecture Quiz?'))return;
    if(!await requireDeletionPin('delete this question'))return;
    c.questions=c.questions.filter(x=>x.id!==q.id);
    c.test_history=(c.test_history||[]).filter(x=>x.question_id!==q.id);
    queueSave();
    closeModal();
    materialQuiz(c,id);
  });
}
function questionDialog(c){ modal(`<h2>Add Question</h2><div class="form-grid"><div class="field full"><label>Question</label><textarea id="q-prompt"></textarea></div><div class="field full"><label>Answer</label><textarea id="q-answer"></textarea></div></div>`,root=>{const prompt=root.querySelector('#q-prompt').value.trim(),answer=root.querySelector('#q-answer').value.trim();if(!prompt||!answer)return toast('Question and answer are required.'); c.questions.push(questionRecord(prompt,answer));queueSave();closeModal();renderCourse();}); }
function questionRecord(prompt,answer,extras={}){ const t=nowIso(); return {id:uid('question'),type:'short_answer',prompt,answer,explanation:'',tags:[],created_at:t,updated_at:t,stats:{attempts:0,correct:0,incorrect:0,last_tested:null},...extras}; }
function gradeQuestion(c,id,correct){ const q=c.questions.find(x=>x.id===id);if(!q)return;q.stats||={attempts:0,correct:0,incorrect:0,last_tested:null};q.stats.attempts++;q.stats[correct?'correct':'incorrect']++;q.stats.last_tested=nowIso();q.updated_at=nowIso();c.test_history.push({id:uid('test'),question_id:id,correct,at:nowIso()});queueSave();renderCourse(); }

function eventDialog(c,e=null){
  const due=e?.due_at?new Date(e.due_at):new Date(Date.now()+86400000); const local=`${due.getFullYear()}-${String(due.getMonth()+1).padStart(2,'0')}-${String(due.getDate()).padStart(2,'0')}T${String(due.getHours()).padStart(2,'0')}:${String(due.getMinutes()).padStart(2,'0')}`;
  modal(`<h2>${e?'Edit':'Add'} Event</h2><div class="form-grid"><div class="field"><label>Type</label><select id="event-type">${['Homework','Midterm 1','Midterm 2','Final','Other'].map(x=>`<option ${e?.type===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Due date & time</label><input id="event-due" type="datetime-local" value="${local}"></div><div class="field full"><label>Title</label><input id="event-title" value="${escapeHtml(e?.title||'')}"></div><div class="field full"><label>Note</label><textarea id="event-note">${escapeHtml(e?.note||'')}</textarea></div></div>`,root=>{ const data={id:e?.id||uid('event'),type:root.querySelector('#event-type').value,title:root.querySelector('#event-title').value.trim()||root.querySelector('#event-type').value,due_at:new Date(root.querySelector('#event-due').value).toISOString(),note:root.querySelector('#event-note').value.trim(),created_at:e?.created_at||nowIso(),updated_at:nowIso()}; if(e)Object.assign(e,data); else c.notifications.push(data); queueSave();closeModal();renderCourse(); });
}
function courseDialog(c=null){
  modal(`<h2>${c?'Edit':'Add'} Course</h2><div class="form-grid"><div class="field"><label>Course code</label><input id="course-code" value="${escapeHtml(c?.code||'')}"></div><div class="field"><label>Course name (optional)</label><input id="course-name" value="${escapeHtml(c?.name||'')}"></div><div class="field"><label>Banner colour</label><input id="course-color" type="color" value="${escapeHtml(courseColor(c))}"></div></div>`,root=>{const code=normalizeCourseCode(root.querySelector('#course-code').value);if(!code)return toast('Enter a course code.');const p=activeProfile();if(c){c.code=code;c.name=root.querySelector('#course-name').value.trim();c.settings.schedule_box_color=root.querySelector('#course-color').value;c.updated_at=nowIso();}else{const id=uid('course'),t=nowIso();p.courses[id]={id,code,name:root.querySelector('#course-name').value.trim(),created_at:t,updated_at:t,units:[],material_units:[],materials:[],notes:[],questions:[],test_history:[],notifications:[],grading:[],ui_state:{last_tab:'Overview'},settings:{schedule_font_color:'#102010',schedule_box_color:root.querySelector('#course-color').value}};p.course_order.push(id);p.schedule.course_meetings[id]=[];route={page:'course',courseId:id,tab:'Overview'};}queueSave();closeModal();render();});
}
function courseMenu(c){ modal(`<h2>${escapeHtml(c.code)}</h2><div class="list"><button id="edit-course" class="list-item"><div class="list-main"><div class="list-title">Edit course</div><div class="list-copy">Code, name and colour</div></div></button><button id="grading-course" class="list-item"><div class="list-main"><div class="list-title">Grading</div><div class="list-copy">Course grading scheme</div></div></button><button id="delete-course" class="list-item"><div class="list-main"><div class="list-title" style="color:var(--danger)">Delete course</div><div class="list-copy">Remove this course from the profile</div></div></button></div>`,null,{saveLabel:null}); document.getElementById('edit-course').onclick=()=>{closeModal();courseDialog(c)}; document.getElementById('grading-course').onclick=()=>{closeModal();gradingDialog(c)}; document.getElementById('delete-course').onclick=async()=>{if(!confirm(`Delete ${c.code}?`))return;if(!await requireDeletionPin(`delete the course '${c.code}'`))return;const p=activeProfile();for(const m of c.materials){await idbDelete(STORES.documents,m.id);await idbDelete(STORES.blobs,`pdf:${m.id}`);cloudApi()?.markDocumentDeleted?.(m.id).catch(console.error);cloudApi()?.markBlobDeleted?.(`pdf:${m.id}`).catch(console.error);}delete p.courses[c.id];p.course_order=p.course_order.filter(id=>id!==c.id);delete p.schedule.course_meetings[c.id];route={page:'dashboard',courseId:null,tab:'Overview'};queueSave();closeModal();render();}; }
function gradingDialog(c){
  const rows=(c.grading||[]).map(g=>gradingRow(g.name,g.weight,g.id)).join('');
  modal(`<h2>Grading Scheme — ${escapeHtml(c.code)}</h2><div id="grading-rows" class="list">${rows}</div><button id="add-grade-row" class="secondary-button" style="margin-top:10px">＋ Category</button><div class="form-help" id="grading-total"></div>`,root=>{const out=[];root.querySelectorAll('.grading-row').forEach(r=>{const name=r.querySelector('[data-name]').value.trim();const weight=Number(r.querySelector('[data-weight]').value);if(name&&Number.isFinite(weight))out.push({id:r.dataset.id||uid('grade'),name,weight});});c.grading=out;queueSave();closeModal();renderCourse();},{wide:true});
  const mr=document.getElementById('modal-root'), container=mr.querySelector('#grading-rows'); const update=()=>{const total=[...mr.querySelectorAll('[data-weight]')].reduce((s,i)=>s+(Number(i.value)||0),0);mr.querySelector('#grading-total').textContent=`Total: ${total.toFixed(1)}%`;}; mr.querySelector('#add-grade-row').onclick=()=>{container.insertAdjacentHTML('beforeend',gradingRow('',0));update();};mr.addEventListener('input',update);mr.addEventListener('click',async e=>{const b=e.target.closest('[data-remove-grade]');if(b){if(!confirm('Delete this grading category?'))return;if(!await requireDeletionPin('delete this grading category'))return;b.closest('.grading-row').remove();update();}});update();
}
function gradingRow(name,weight,id=null){ return `<div class="list-item grading-row" data-id="${escapeHtml(id||uid('grade'))}"><div class="field" style="flex:1"><label>Category</label><input data-name value="${escapeHtml(name||'')}"></div><div class="field" style="width:140px"><label>Weight %</label><input data-weight type="number" min="0" max="100" step="0.1" value="${Number(weight)||0}"></div><button class="danger-button" data-remove-grade>Delete</button></div>`; }

function renderNotes(){ const p=activeProfile(); setHeader('Notes','Personal notes across your university workspace'); els.page.innerHTML=`<div class="page-stack"><section class="card"><div class="card-header"><div><h2>Notes</h2><div class="card-subtitle">Personal reminders and scratch notes</div></div><button id="add-personal-note" class="primary-button">＋ Note</button></div><div class="grid-3">${p.personal_notes.length?p.personal_notes.map(n=>`<article class="card note-card" data-note="${n.id}"><div class="card-header"><div><h3>${escapeHtml(n.title||'Untitled Note')}</h3><div class="card-subtitle">${formatDateTime(n.updated_at||n.created_at)}</div></div><button class="danger-button" data-delete-note="${n.id}">Delete</button></div><div class="note-body">${escapeHtml(n.body||'')}</div></article>`).join(''):'<div class="empty">No personal notes.</div>'}</div></section></div>`;
  document.getElementById('add-personal-note').onclick=()=>noteDialog(); els.page.querySelectorAll('[data-note]').forEach(n=>n.onclick=e=>{if(e.target.closest('[data-delete-note]'))return;noteDialog(p.personal_notes.find(x=>x.id===n.dataset.note));}); els.page.querySelectorAll('[data-delete-note]').forEach(b=>b.onclick=async e=>{e.stopPropagation();if(!confirm('Delete this note?'))return;if(!await requireDeletionPin('delete this note'))return;p.personal_notes=p.personal_notes.filter(n=>n.id!==b.dataset.deleteNote);queueSave();renderNotes();});
}
function noteDialog(n=null){ const p=activeProfile(); modal(`<h2>${n?'Edit':'New'} Note</h2><div class="form-grid"><div class="field full"><label>Title</label><input id="note-title" value="${escapeHtml(n?.title||'')}"></div><div class="field full"><label>Note</label><textarea id="note-body" style="min-height:260px">${escapeHtml(n?.body||'')}</textarea></div></div>`,root=>{const data={id:n?.id||uid('note'),title:root.querySelector('#note-title').value.trim()||'Untitled Note',body:root.querySelector('#note-body').value,created_at:n?.created_at||nowIso(),updated_at:nowIso()};if(n)Object.assign(n,data);else p.personal_notes.push(data);queueSave();closeModal();renderNotes();},{wide:true}); }

function renderSchedule(){
  const s=activeProfile().schedule; setHeader('Schedule','Setup classes, import a timetable screenshot, and view your week');
  const view=s._web_view||'calendar'; els.page.innerHTML=`<div class="page-stack"><section class="card"><div class="card-header"><div><h2>Schedule</h2><div class="card-subtitle">Same weekly schedule on desktop and iPad</div></div><div class="schedule-toolbar"><button class="course-tab ${view==='setup'?'active':''}" id="schedule-setup">Setup</button><button class="course-tab ${view==='calendar'?'active':''}" id="schedule-calendar">Calendar</button><button id="schedule-import" class="secondary-button">Import picture</button><button id="schedule-add-event" class="primary-button">＋ Event</button></div></div><div id="schedule-body">${view==='setup'?scheduleSetupHtml():scheduleCalendarHtml()}</div></section></div>`;
  document.getElementById('schedule-setup').onclick=()=>{s._web_view='setup';renderSchedule();};document.getElementById('schedule-calendar').onclick=()=>{s._web_view='calendar';renderSchedule();};document.getElementById('schedule-import').onclick=()=>els.scheduleImageImport.click();document.getElementById('schedule-add-event').onclick=()=>scheduleEventDialog();
  if(view==='setup') bindScheduleSetup(); else bindScheduleCalendar();
}
function scheduleSetupHtml(){
  const p=activeProfile(),s=p.schedule;
  const schoolStart=s.term_start_date||localDateKey();
  const startDate=parseDateKey(schoolStart);
  const startLabel=Number.isNaN(+startDate)?schoolStart:startDate.toLocaleDateString([], {year:'numeric',month:'short',day:'numeric'});
  return `<div class="schedule-start-row"><div><strong>School Start</strong><div class="card-subtitle">No classes are shown before this date.</div></div><div class="action-row"><span class="pill">${escapeHtml(startLabel)}</span><button id="school-start-button" class="secondary-button">School Start</button></div></div><div class="list">${orderedCourses(p).map(c=>`<section class="material-unit"><div class="material-unit-head"><span class="course-dot" style="background:${courseColor(c)}"></span><strong style="flex:1">${escapeHtml(c.code)}</strong><button class="primary-button" data-add-meeting="${c.id}">＋ Time slot</button></div><div class="material-unit-body">${(s.course_meetings[c.id]||[]).map(m=>meetingCard(c,m)).join('')||'<div class="empty">No class times.</div>'}</div></section>`).join('')}</div>`;
}
function meetingCard(c,m){ return `<div class="list-item"><div class="list-main"><div class="list-title">${escapeHtml(m.title||`${c.code} ${m.type||''}`)}</div><div class="list-copy">${escapeHtml(m.day)} • ${minutesLabel(m.start_minute)}–${minutesLabel(m.end_minute)} • ${escapeHtml(m.classroom||'No room')} • ${escapeHtml(m.recurrence||'Weekly')}</div></div><button class="secondary-button" data-edit-meeting="${c.id}|${m.id||''}">Edit</button><button class="danger-button" data-delete-meeting="${c.id}|${m.id||''}">Delete</button></div>`; }
function bindScheduleSetup(){ const s=activeProfile().schedule; document.getElementById('school-start-button')?.addEventListener('click',schoolStartDialog);els.page.querySelectorAll('[data-add-meeting]').forEach(b=>b.onclick=()=>meetingDialog(b.dataset.addMeeting));els.page.querySelectorAll('[data-edit-meeting]').forEach(b=>b.onclick=()=>{const[cid,id]=b.dataset.editMeeting.split('|');meetingDialog(cid,(s.course_meetings[cid]||[]).find(m=>m.id===id));});els.page.querySelectorAll('[data-delete-meeting]').forEach(b=>b.onclick=async()=>{const[cid,id]=b.dataset.deleteMeeting.split('|');if(!confirm('Delete this class time?'))return;if(!await requireDeletionPin('delete this class time'))return;s.course_meetings[cid]=(s.course_meetings[cid]||[]).filter(m=>m.id!==id);queueSave();renderSchedule();}); }
function schoolStartDialog(){
  const s=activeProfile().schedule;
  modal(`<h2>School Start</h2><div class="field"><label>First day of school</label><input id="school-start-date" type="date" value="${escapeHtml(s.term_start_date||localDateKey())}"></div><p class="form-help">Weekly and bi-weekly classes will not appear on the calendar before this date.</p>`,root=>{
    const value=root.querySelector('#school-start-date').value;
    if(!value)return toast('Choose the first day of school.');
    s.term_start_date=value;
    queueSave(); closeModal(); renderSchedule();
  });
}
function meetingDialog(courseId,m=null){ const c=activeProfile().courses[courseId]; const start=m?.start_minute??540,end=m?.end_minute??620; modal(`<h2>${m?'Edit':'Add'} Class Time</h2><div class="form-grid"><div class="field"><label>Title</label><input id="meet-title" value="${escapeHtml(m?.title||c.code)}"></div><div class="field"><label>Type</label><select id="meet-type">${['Lecture','Laboratory','Discussion Group','Tutorial','Other'].map(x=>`<option ${m?.type===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Day</label><select id="meet-day">${DAY_NAMES.map(x=>`<option ${m?.day===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Room</label><input id="meet-room" value="${escapeHtml(m?.classroom||'')}"></div><div class="field"><label>Start</label><input id="meet-start" type="time" value="${minutesToTime(start)}"></div><div class="field"><label>End</label><input id="meet-end" type="time" value="${minutesToTime(end)}"></div><div class="field"><label>Repeats</label><select id="meet-repeat"><option ${m?.recurrence==='Weekly'?'selected':''}>Weekly</option><option ${m?.recurrence==='Bi-weekly'?'selected':''}>Bi-weekly</option><option ${m?.recurrence==='Once'?'selected':''}>Once</option></select></div><div class="field"><label>Start date</label><input id="meet-first" type="date" value="${escapeHtml(m?.first_class_date||'')}"></div><div class="field full"><label>Instructor</label><input id="meet-instructor" value="${escapeHtml(m?.instructor||'')}"></div></div>`,root=>{const start=timeToMinutes(root.querySelector('#meet-start').value),end=timeToMinutes(root.querySelector('#meet-end').value),recurrence=root.querySelector('#meet-repeat').value,firstDate=root.querySelector('#meet-first').value;if(end<=start)return toast('End time must be after start time.');if((recurrence==='Bi-weekly'||recurrence==='Once')&&!firstDate)return toast('Start date is required for Bi-weekly and Once class times.');const data={id:m?.id||uid('meeting'),enabled:true,title:root.querySelector('#meet-title').value.trim()||c.code,type:root.querySelector('#meet-type').value,classroom:root.querySelector('#meet-room').value.trim(),day:root.querySelector('#meet-day').value,start_minute:start,end_minute:end,instructor:root.querySelector('#meet-instructor').value.trim(),recurrence,first_class_date:firstDate};const arr=activeProfile().schedule.course_meetings[courseId] ||= [];if(m)Object.assign(m,data);else arr.push(data);queueSave();closeModal();renderSchedule();}); }
function minutesToTime(n){ return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
function timeToMinutes(v){ const[h,m]=v.split(':').map(Number);return h*60+m; }
function scheduleOccurrences(week){ const p=activeProfile(),s=p.schedule,out=[]; const weekStart=mondayOf(week); const schoolStart=s.term_start_date?parseDateKey(s.term_start_date):null; for(const c of orderedCourses(p)) for(const m of s.course_meetings[c.id]||[]){ if(m.enabled===false)continue; const di=DAY_NAMES.indexOf(m.day);if(di<0)continue; const date=addDays(weekStart,di); if(schoolStart&&!Number.isNaN(+schoolStart)&&date<schoolStart)continue; if(m.recurrence==='Once'&&m.first_class_date!==dateKey(date))continue; if(m.recurrence==='Weekly'&&m.first_class_date){const first=parseDateKey(m.first_class_date);if(!Number.isNaN(+first)&&date<first)continue;} if(m.recurrence==='Bi-weekly'){if(!m.first_class_date)continue;const first=parseDateKey(m.first_class_date);if(Number.isNaN(+first)||date<first)continue;const anchor=mondayOf(first);const diff=Math.round((weekStart-anchor)/604800000);if(diff%2!==0)continue;} out.push({...m,course:c,date}); }
  for(const e of s.personal_events||[]){ if(e.enabled===false)continue; let date=null;if(e.recurrence==='Once'&&e.first_event_date)date=parseDateKey(e.first_event_date);else{const di=DAY_NAMES.indexOf(e.day);date=addDays(weekStart,Math.max(0,di));}if(mondayOf(date).getTime()!==weekStart.getTime()&&e.recurrence==='Once')continue;out.push({...e,course:null,date}); }
  return out;
}
function scheduleCalendarHtml(){ const s=activeProfile().schedule; const week=parseDateKey(s.calendar_week||dateKey(mondayOf(new Date()))); const days=DAY_NAMES.map((d,i)=>({name:d,date:addDays(week,i)})); const start=s.display_options.start_minute||480,end=s.display_options.end_minute||1350; const rows=Math.ceil((end-start)/60); const occ=scheduleOccurrences(week); return `<div class="schedule-toolbar" style="margin-bottom:12px"><button id="week-prev" class="secondary-button">← Week</button><strong style="flex:1;text-align:center">${days[0].date.toLocaleDateString([], {month:'short',day:'numeric'})} – ${days[6].date.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'})}</strong><button id="week-today" class="secondary-button">Today</button><button id="week-next" class="secondary-button">Week →</button></div><div class="week-wrap"><div class="week-grid" style="grid-template-rows:46px repeat(${rows},60px)"><div class="week-head"></div>${days.map(x=>`<div class="week-head">${x.name.slice(0,3)}<br><small>${x.date.getDate()}</small></div>`).join('')}${Array.from({length:rows},(_,r)=>{const minute=start+r*60;return `<div class="time-label">${minutesLabel(minute)}</div>${days.map((_,di)=>`<div class="day-cell" data-daycell="${di}|${minute}"></div>`).join('')}`}).join('')}<div id="schedule-overlay" style="position:absolute;left:64px;right:0;top:46px;bottom:0;display:grid;grid-template-columns:repeat(7,1fr);pointer-events:none">${days.map((_,di)=>`<div style="position:relative;border-left:1px solid transparent" data-overlay-day="${di}"></div>`).join('')}</div></div></div><div id="occ-data" hidden>${escapeHtml(JSON.stringify(occ.map(o=>({...o,date:dateKey(o.date),course:o.course?{id:o.course.id,code:o.course.code,settings:o.course.settings}:null}))))}</div>`; }
function bindScheduleCalendar(){ const s=activeProfile().schedule;document.getElementById('week-prev').onclick=()=>changeScheduleCalendarWeek(-1);document.getElementById('week-next').onclick=()=>changeScheduleCalendarWeek(1);document.getElementById('week-today').onclick=()=>{s.calendar_week=dateKey(mondayOf(new Date()));queueSave(false);renderSchedule();};drawCalendarEvents(); liveTimer=setInterval(drawCalendarLiveLine,60000);drawCalendarLiveLine(); }
function drawCalendarEvents(){ const s=activeProfile().schedule,start=s.display_options.start_minute||480,end=s.display_options.end_minute||1350;const week=parseDateKey(s.calendar_week);for(const o of scheduleOccurrences(week)){const di=Math.round((o.date-mondayOf(week))/86400000);const col=els.page.querySelector(`[data-overlay-day="${di}"]`);if(!col)continue;const top=(o.start_minute-start)/(end-start)*100,height=(o.end_minute-o.start_minute)/(end-start)*100;const el=document.createElement('div');el.className='schedule-event';el.style.top=`${top}%`;el.style.height=`${Math.max(height,2)}%`;el.style.pointerEvents='auto';const bg=o.course?courseColor(o.course):(o.schedule_box_color||'#FFB44A');el.style.background=bg;el.style.color=o.course?.settings?.schedule_font_color||o.schedule_font_color||'#102010';el.innerHTML=`${escapeHtml(o.title||o.type||'Event')}<small>${minutesLabel(o.start_minute)} • ${escapeHtml(o.classroom||'')}</small>`;if(!o.course)el.onclick=()=>scheduleEventDialog(activeProfile().schedule.personal_events.find(e=>e.id===o.id));col.appendChild(el);} }
function drawCalendarLiveLine(){ const old=els.page.querySelector('.live-line');if(old)old.remove();const s=activeProfile().schedule,week=parseDateKey(s.calendar_week),today=new Date();if(mondayOf(today).getTime()!==mondayOf(week).getTime())return;const di=(today.getDay()+6)%7,start=s.display_options.start_minute||480,end=s.display_options.end_minute||1350,now=today.getHours()*60+today.getMinutes();if(now<start||now>end)return;const col=els.page.querySelector(`[data-overlay-day="${di}"]`);if(!col)return;const line=document.createElement('div');line.className='live-line';line.style.top=`${(now-start)/(end-start)*100}%`;col.appendChild(line); }
function scheduleEventDialog(e=null){
  const s=activeProfile().schedule, date=e?.first_event_date||localDateKey();
  modal(`<h2>${e?'Edit':'Add'} Personal Event</h2><div class="form-grid"><div class="field full"><label>Title</label><input id="se-title" value="${escapeHtml(e?.title||'')}"></div><div class="field"><label>Date</label><input id="se-date" type="date" value="${date}"></div><div class="field"><label>Location</label><input id="se-room" value="${escapeHtml(e?.classroom||'')}"></div><div class="field"><label>Start</label><input id="se-start" type="time" value="${minutesToTime(e?.start_minute??720)}"></div><div class="field"><label>End</label><input id="se-end" type="time" value="${minutesToTime(e?.end_minute??780)}"></div><div class="field full"><label>Note</label><textarea id="se-note">${escapeHtml(e?.note||'')}</textarea></div><div class="field"><label>Colour</label><input id="se-color" type="color" value="${escapeHtml(e?.schedule_box_color||'#FFB44A')}"></div></div>${e?'<button id="delete-schedule-event" class="danger-button" style="margin-top:14px">Delete Event</button>':''}`,root=>{const d=parseDateKey(root.querySelector('#se-date').value);const data={id:e?.id||uid('schedule_event'),enabled:true,title:root.querySelector('#se-title').value.trim()||'Personal Event',classroom:root.querySelector('#se-room').value.trim(),type:'Personal Event',day:DAY_NAMES[(d.getDay()+6)%7],recurrence:'Once',first_event_date:root.querySelector('#se-date').value,start_minute:timeToMinutes(root.querySelector('#se-start').value),end_minute:timeToMinutes(root.querySelector('#se-end').value),note:root.querySelector('#se-note').value.trim(),schedule_font_color:'#102010',schedule_box_color:root.querySelector('#se-color').value,created_at:e?.created_at||nowIso(),updated_at:nowIso()};if(data.end_minute<=data.start_minute)return toast('End time must be after start time.');if(e)Object.assign(e,data);else s.personal_events.push(data);queueSave();closeModal();renderSchedule();});
  if(e)document.getElementById('delete-schedule-event').onclick=async()=>{if(!confirm('Delete this personal event?'))return;if(!await requireDeletionPin('delete this personal schedule event'))return;s.personal_events=s.personal_events.filter(x=>x.id!==e.id);queueSave();closeModal();renderSchedule();};
}

async function handleScheduleImage(file){
  if(!file)return; modal(`<h2>Reading schedule picture</h2><p class="card-subtitle">The iPad/Shared version uses in-browser OCR. The first OCR use needs internet so the OCR engine can load; after that Safari can cache it.</p><div class="ocr-progress"><div id="ocr-bar"></div></div><p id="ocr-status">Preparing OCR…</p>`,null,{saveLabel:null});
  try{
    let text='';
    if(hasNativeBridge()){
      const st=document.getElementById('ocr-status'); if(st)st.textContent='Reading with Apple Vision…';
      const bar=document.getElementById('ocr-bar'); if(bar)bar.style.width='35%';
      const nativeResult=await nativeCall('ocrImage',{dataUrl:await fileToDataUrl(file)});
      if(!nativeResult?.ok) throw new Error(nativeResult?.error||'Apple Vision OCR failed.');
      text=String(nativeResult.text||''); if(bar)bar.style.width='100%';
    }else{
      if(!window.Tesseract){ await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'); }
      const result=await Tesseract.recognize(file,'eng',{logger:m=>{const bar=document.getElementById('ocr-bar'),st=document.getElementById('ocr-status');if(bar&&Number.isFinite(m.progress))bar.style.width=`${Math.round(m.progress*100)}%`;if(st)st.textContent=m.status||'Reading…';}});
      text=result.data.text||'';
    }
    closeModal(); showOcrReview(text,file.name);
  }catch(err){console.error(err);closeModal();toast(`Schedule OCR failed: ${err.message||err}`,4500);}
}
function loadScript(src){return new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=()=>rej(new Error('OCR library could not load.'));document.head.appendChild(s);});}
function parseOcrMeetings(text){
  const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean), out=[]; let currentCourse='';
  const courseRe=/\b([A-Z]{3,4})\s*[- ]?\s*([0-9OIL]{4})\b/i; const timeRe=/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i;
  for(const line of lines){ const cm=line.match(courseRe);if(cm)currentCourse=normalizeCourseCode(cm[0]); const day=DAY_NAMES.find(d=>new RegExp(`\\b${d.slice(0,3)}`,'i').test(line)); const tm=line.match(timeRe);if(currentCourse&&day&&tm){const toMin=(h,m,amp)=>{h=Number(h);m=Number(m||0);if(amp){amp=amp.toUpperCase();if(amp==='PM'&&h<12)h+=12;if(amp==='AM'&&h===12)h=0;}return h*60+m;};out.push({courseCode:currentCourse,day,start:toMin(tm[1],tm[2],tm[3]),end:toMin(tm[4],tm[5],tm[6]),raw:line});} }
  return out;
}
function showOcrReview(text,filename){ const found=parseOcrMeetings(text); modal(`<h2>Schedule import review</h2><div class="card-subtitle">Detected ${found.length} class time${found.length===1?'':'s'}. You can import these and then correct anything in Setup.</div><div class="list" style="margin-top:14px">${found.length?found.map((m,i)=>`<label class="list-item"><input type="checkbox" data-ocr="${i}" checked><div class="list-main"><div class="list-title">${escapeHtml(m.courseCode)} • ${m.day} • ${minutesLabel(m.start)}–${minutesLabel(m.end)}</div><div class="list-copy">${escapeHtml(m.raw)}</div></div></label>`).join(''):`<div class="empty">No complete course/day/time lines were detected. The OCR text is shown below so you can verify the screenshot.</div>`}</div><div class="field" style="margin-top:12px"><label>Recognized text</label><textarea style="min-height:220px" readonly>${escapeHtml(text)}</textarea></div>`,root=>{const p=activeProfile(),s=p.schedule;root.querySelectorAll('[data-ocr]:checked').forEach(ch=>{const m=found[Number(ch.dataset.ocr)];let c=orderedCourses(p).find(x=>normalizeCourseCode(x.code)===m.courseCode);if(!c){const id=uid('course'),t=nowIso();c={id,code:m.courseCode,name:'',created_at:t,updated_at:t,units:[],material_units:[],materials:[],notes:[],questions:[],test_history:[],notifications:[],grading:[],ui_state:{last_tab:'Overview'},settings:{schedule_font_color:'#102010',schedule_box_color:'#A9D18D'}};p.courses[id]=c;p.course_order.push(id);} const arr=s.course_meetings[c.id] ||= [];arr.push({id:uid('meeting'),enabled:true,title:c.code,type:'Lecture',classroom:'',day:m.day,start_minute:m.start,end_minute:m.end,instructor:'',recurrence:'Weekly',first_class_date:'',source_file:filename,imported_from_schedule:true});});queueSave();closeModal();s._web_view='setup';renderSchedule();},{saveLabel:found.length?'Import detected classes':'Close',wide:true}); }

function renderSettings(){ const p=activeProfile(),a=p.settings.audio||{}; setHeader('Settings','User settings, appearance, audio, backups and iPad installation'); els.page.innerHTML=`<div class="page-stack">
  <section class="card"><div class="card-header"><div><h2>User settings</h2><div class="card-subtitle">Cross-platform interaction preferences</div></div></div><div class="settings-row"><div><strong>Scroll sensitivity</strong><span>Changes scroll speed throughout supported pages.</span></div><select id="scroll-sensitivity">${SCROLL_LEVELS.map(v=>`<option value="${v}" ${p.settings.scroll_sensitivity===v?'selected':''}>${v}%</option>`).join('')}</select></div><div class="settings-row"><div><strong>Deletion PIN</strong><span>${deletionPinConfigured(p)?'Protects deletion actions with your existing desktop-compatible PIN.':'Set a 1–6 digit PIN before protected deletions.'}</span></div><button id="change-deletion-pin" class="secondary-button">${deletionPinConfigured(p)?'Change PIN':'Set PIN'}</button></div></section>
  <section class="card"><div class="card-header"><h2>Appearance</h2></div><div class="settings-row"><div><strong>Theme</strong><span>The shared interface currently preserves the dark University Study Hub design.</span></div><select id="theme-select"><option>Dark</option></select></div></section>
  <section class="card"><div class="card-header"><h2>Audio</h2></div><div class="settings-row"><div><strong>Study music</strong><span>Uses the same bundled music on Windows, Mac and iPad.</span></div><label><input id="music-enabled" type="checkbox" ${a.music_enabled?'checked':''}> Enabled</label></div><div class="settings-row"><div><strong>Track</strong></div><select id="music-track"><option value="${MUSIC_TRACKS[0]}" ${(a.music_track||MUSIC_TRACKS[0])===MUSIC_TRACKS[0]?'selected':''}>Study Jazz</option><option value="${MUSIC_TRACKS[1]}" ${a.music_track===MUSIC_TRACKS[1]?'selected':''}>Study Session</option></select></div><div class="settings-row"><div><strong>Shuffle</strong><span>Choose another bundled track when a track finishes.</span></div><label><input id="music-shuffle" type="checkbox" ${a.shuffle?'checked':''}> Enabled</label></div><div class="settings-row"><div><strong>Music volume</strong></div><input id="music-volume" type="range" min="0" max="1" step="0.01" value="${Number(a.music_volume??.3)}"></div><div class="settings-row"><div><strong>Click sounds</strong></div><label><input id="click-enabled" type="checkbox" ${a.click_enabled?'checked':''}> Enabled</label></div></section>
  ${cloudSettingsHtml()}
  <section class="card"><div class="card-header"><div><h2>Data & device transfer</h2><div class="card-subtitle">Move the same University Study Hub data between Windows, Mac and iPad.</div></div></div><div class="action-row"><button id="export-transfer" class="primary-button">Export full backup</button><button id="import-transfer" class="secondary-button">Import backup</button></div><p class="form-help">Backups include profiles, courses, Lecture documents, annotations and imported PDFs stored by this shared version.</p></section>
  <section class="card"><div class="card-header"><div><h2>iPad installation</h2><div class="card-subtitle">No App Store required</div></div></div><ol style="line-height:1.7;color:var(--muted)"><li>Open the hosted Study Hub address in Safari.</li><li>Tap Share → Add to Home Screen.</li><li>Open the new Study Hub icon. It runs as a standalone iPad app.</li><li>Use Import backup to bring over your desktop data.</li></ol><p class="form-help">Once installed and cached, the core app and Lecture editor work offline. OCR may require internet the first time its engine is loaded.</p></section>
  </div>`;
  document.getElementById('scroll-sensitivity').onchange=e=>{p.settings.scroll_sensitivity=Number(e.target.value);queueSave();applySettings();};document.getElementById('change-deletion-pin').onclick=changeDeletionPin;document.getElementById('music-enabled').onchange=e=>{a.music_enabled=e.target.checked;queueSave();applyAudio();};document.getElementById('music-track').onchange=e=>{a.music_track=e.target.value;if(audioTrack){audioTrack.pause();audioTrack=null;}queueSave();applyAudio();};document.getElementById('music-shuffle').onchange=e=>{a.shuffle=e.target.checked;queueSave();};document.getElementById('music-volume').oninput=e=>{a.music_volume=Number(e.target.value);queueSave();if(audioTrack)audioTrack.volume=a.music_volume;};document.getElementById('click-enabled').onchange=e=>{a.click_enabled=e.target.checked;queueSave();};document.getElementById('export-transfer').onclick=exportTransfer;document.getElementById('import-transfer').onclick=()=>els.transferImport.click();bindCloudSettings();
}
function applySettings(){ const p=activeProfile();document.documentElement.style.setProperty('--scroll-factor',String((p.settings.scroll_sensitivity||100)/100));applyAudio(); }
function applyAudio(){ const a=activeProfile().settings.audio||{}; const track=MUSIC_TRACKS.includes(a.music_track)?a.music_track:MUSIC_TRACKS[0]; if(a.music_track!==track)a.music_track=track; if(a.music_enabled){ if(!audioTrack){audioTrack=new Audio(`audio/music/${encodeURIComponent(track)}`);audioTrack.loop=!a.shuffle;audioTrack.addEventListener('ended',()=>{if(!a.shuffle)return;const choices=MUSIC_TRACKS.filter(x=>x!==a.music_track);a.music_track=choices[Math.floor(Math.random()*choices.length)]||MUSIC_TRACKS[0];audioTrack=null;queueSave();applyAudio();});}audioTrack.volume=Number(a.music_volume??.3);if(a.music_paused!==true)audioTrack.play().catch(()=>{});}else if(audioTrack){audioTrack.pause();} }
function clickSound(){ const a=activeProfile().settings.audio||{}; if(!a.click_enabled)return;const au=new Audio('audio/clicks/matthewvakaliuk73627-mouse-click-290204.mp3');au.volume=Number(a.click_volume??.55);au.play().catch(()=>{}); }

async function exportTransfer(){
  await saveStateNow(false,false); const docs=Object.fromEntries(await idbEntries(STORES.documents)); const blobs={}; for(const [key,blob] of await idbEntries(STORES.blobs)){ if(blob instanceof Blob) blobs[key]={name:blob.name||`${key}.bin`,type:blob.type||'application/octet-stream',base64:await blobToBase64(blob)}; }
  const payload={format:'university-study-hub-transfer',version:1,created_at:nowIso(),state,documents:docs,blobs}; downloadBlob(new Blob([JSON.stringify(payload)],{type:'application/json'}),`University_Study_Hub_Backup_${localDateKey()}.ushub.json`);toast('Full backup exported.');
}
function blobToBase64(blob){ return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=()=>rej(r.error);r.readAsDataURL(blob);}); }
function base64ToBlob(base64,type){ const bin=atob(base64),len=bin.length,arr=new Uint8Array(len);for(let i=0;i<len;i++)arr[i]=bin.charCodeAt(i);return new Blob([arr],{type:type||'application/octet-stream'}); }
async function importTransferFile(file){
  try{
    const payload=JSON.parse(await file.text());
    if(payload.format!=='university-study-hub-transfer'&&!payload.profiles)throw new Error('This is not a University Study Hub backup.');
    if(payload.state){
      state=normalizeState(payload.state);
      await idbClear(STORES.documents);await idbClear(STORES.blobs);
      for(const [k,v] of Object.entries(payload.documents||{}))await idbSet(STORES.documents,k,v);
      for(const [k,v] of Object.entries(payload.blobs||{}))await idbSet(STORES.blobs,k,base64ToBlob(v.base64,v.type));
    }else state=normalizeState(payload);
    await saveStateNow(false,false);
    route={page:'dashboard',courseId:null,tab:'Overview'};render();
    const api=cloudApi();
    if(cloudStatus().signedIn&&api?.promoteLocalToCloud){
      modal(`<h2>Backup imported</h2><p class="card-subtitle">The backup is now safely stored on this device.</p><div class="cloud-warning"><strong>Phase 8:</strong> If this is the one device containing the complete workspace you want everywhere, make this imported backup the cloud master now. Other signed-in devices will then download it automatically.</div><div class="action-row" style="margin-top:16px"><button id="import-cloud-master" class="primary-button">Make imported backup cloud master</button><button id="import-normal-sync" class="secondary-button">Merge normally</button></div>`,null,{saveLabel:null});
      document.getElementById('import-cloud-master').onclick=async()=>{try{toast('Uploading imported backup as cloud master…',5000);await api.promoteLocalToCloud();closeModal();await reloadStateFromDisk();toast('Phase 8 complete — cloud master created.',5000);}catch(err){toast(`Migration failed: ${err.message||err}`,6000);}};
      document.getElementById('import-normal-sync').onclick=async()=>{await api.markEverythingDirty?.();closeModal();toast('Backup imported; normal cloud merge queued.');};
    }else{
      await api?.markEverythingDirty?.();
      toast(cloudStatus().signedIn?'Backup imported; cloud upload queued.':'Backup imported. Sign in to upload it to your cloud workspace.');
    }
  }catch(err){console.error(err);toast(`Import failed: ${err.message||err}`,4500);}finally{els.transferImport.value='';}
}

function profileManager(){ const profiles=Object.values(state.profiles); modal(`<h2>Profiles</h2><div class="list">${profiles.map(p=>`<div class="list-item"><div class="list-main"><div class="list-title">${escapeHtml(p.display_name)}</div></div><button class="secondary-button" data-profile-rename="${p.id}">Rename</button>${profiles.length>1?`<button class="danger-button" data-profile-delete="${p.id}">Delete</button>`:''}</div>`).join('')}</div><button id="profile-add" class="secondary-button" style="margin-top:10px">＋ Profile</button>`,null,{saveLabel:null});const root=document.getElementById('modal-root');root.querySelector('#profile-add').onclick=()=>{const name=prompt('Profile name','New Profile');if(!name)return;const p=defaultProfile(name.trim());state.profiles[p.id]=p;state.active_profile_id=p.id;route={page:'dashboard',courseId:null,tab:'Overview'};queueSave();closeModal();render();};root.querySelectorAll('[data-profile-rename]').forEach(b=>b.onclick=()=>{const p=state.profiles[b.dataset.profileRename],n=prompt('Profile name',p.display_name);if(n){p.display_name=n.trim()||p.display_name;queueSave();closeModal();render();}});root.querySelectorAll('[data-profile-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this profile and all of its shared-version data?'))return;if(!await requireDeletionPin('delete this profile'))return;const doomed=state.profiles[b.dataset.profileDelete];for(const course of Object.values(doomed?.courses||{})){for(const m of course.materials||[]){await idbDelete(STORES.documents,m.id);await idbDelete(STORES.blobs,`pdf:${m.id}`);cloudApi()?.markDocumentDeleted?.(m.id).catch(console.error);cloudApi()?.markBlobDeleted?.(`pdf:${m.id}`).catch(console.error);}}delete state.profiles[b.dataset.profileDelete];state.active_profile_id=Object.keys(state.profiles)[0];route={page:'dashboard',courseId:null,tab:'Overview'};queueSave();closeModal();render();}); }

function modal(content,onSave,opts={}){ const saveLabel=opts.saveLabel===undefined?'Save':opts.saveLabel; els.modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal ${opts.wide?'wide':''}">${content}<div class="modal-actions"><button class="secondary-button" data-modal-cancel>${saveLabel? 'Cancel':'Close'}</button>${saveLabel?`<button class="primary-button" data-modal-save>${escapeHtml(saveLabel)}</button>`:''}</div></div></div>`; const root=els.modalRoot;root.querySelector('[data-modal-cancel]').onclick=closeModal;if(saveLabel&&onSave)root.querySelector('[data-modal-save]').onclick=()=>onSave(root);root.querySelector('.modal-backdrop').addEventListener('pointerdown',e=>{if(e.target===e.currentTarget)closeModal();});setTimeout(()=>root.querySelector('input,textarea,select')?.focus(),0); }
function closeModal(){ els.modalRoot.innerHTML=''; }

async function init(){
  Object.assign(els,{sidebar:document.getElementById('sidebar'),scrim:document.getElementById('scrim'),primaryNav:document.getElementById('primary-nav'),utilityNav:document.getElementById('utility-nav'),courseNav:document.getElementById('course-nav'),profileSelect:document.getElementById('profile-select'),page:document.getElementById('page'),pageTitle:document.getElementById('page-title'),pageSubtitle:document.getElementById('page-subtitle'),saveIndicator:document.getElementById('save-indicator'),modalRoot:document.getElementById('modal-root'),toast:document.getElementById('toast'),transferImport:document.getElementById('transfer-import'),scheduleImageImport:document.getElementById('schedule-image-import'),cloudIndicator:document.getElementById('cloud-indicator'),authGate:document.getElementById('auth-gate'),authEmail:document.getElementById('auth-email'),authPassword:document.getElementById('auth-password'),authMessage:document.getElementById('auth-message'),authSignin:document.getElementById('auth-signin'),authSignup:document.getElementById('auth-signup'),authReset:document.getElementById('auth-reset'),authOffline:document.getElementById('auth-offline')});
  await loadState(); const p=activeProfile(); route.page=(p.ui_state?.last_page||'Dashboard').toLowerCase().replace(' ','_'); if(!['dashboard','notes','schedule','settings','course'].includes(route.page))route.page='dashboard'; route.courseId=p.ui_state?.last_course_id||null;if(route.page==='course'&&!p.courses[route.courseId])route.page='dashboard';route.tab=route.courseId?p.courses[route.courseId]?.ui_state?.last_tab||'Overview':'Overview';
  document.getElementById('sidebar-open').onclick=openNav;document.getElementById('sidebar-close').onclick=closeNav;els.scrim.onclick=closeNav;
  els.primaryNav.addEventListener('click',e=>{const b=e.target.closest('[data-nav]');if(b)navTo(b.dataset.nav);});els.utilityNav.addEventListener('click',e=>{const b=e.target.closest('[data-nav]');if(b)navTo(b.dataset.nav);});els.courseNav.addEventListener('click',e=>{const b=e.target.closest('[data-course]');if(b)navTo('course',{courseId:b.dataset.course,tab:courseTabForSwitch(b.dataset.course)});});document.getElementById('add-course-nav').onclick=()=>courseDialog();document.getElementById('global-add').onclick=()=>route.page==='course'?createLectureDialog(activeCourse()):courseDialog();
  els.profileSelect.onchange=()=>{state.active_profile_id=els.profileSelect.value;const p=activeProfile();route={page:'dashboard',courseId:p.ui_state?.last_course_id||null,tab:'Overview'};queueSave(false);render();};document.getElementById('manage-profiles').onclick=profileManager;
  els.transferImport.onchange=()=>importTransferFile(els.transferImport.files?.[0]);els.scheduleImageImport.onchange=()=>{const f=els.scheduleImageImport.files?.[0];els.scheduleImageImport.value='';if(f)handleScheduleImage(f);};
  document.addEventListener('click',e=>{if(e.target.closest('button,.nav-item,.course-nav-item'))clickSound();});
  document.addEventListener('keydown',handleGlobalNavigationKeydown);
  els.cloudIndicator.onclick=()=>navTo('settings');els.authSignin.onclick=authSignIn;els.authSignup.onclick=authSignUp;els.authReset.onclick=authReset;els.authOffline.onclick=()=>{cloudOfflineBypass=true;showAuthGate(false);toast('Working locally. Sign in from Settings whenever you want cloud sync.');};els.authPassword.addEventListener('keydown',e=>{if(e.key==='Enter')authSignIn();});
  window.addEventListener('pagehide',()=>{if(stateSavePending)saveStateNow(false,false).catch(()=>{});});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&stateSavePending)saveStateNow(false,true).catch(()=>{});});
  window.addEventListener('beforeunload',()=>{if(stateSavePending)saveStateNow(false,false).catch(()=>{});});
  window.addEventListener('pageshow',async event=>{if(event.persisted&&state){state=normalizeState(await idbGet(STORES.meta,'state'));render();}});
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('service-worker.js').catch(console.warn);
  render();
  setupCloud().catch(err=>{console.error(err);toast(`Cloud startup failed: ${err.message||err}`,4500);});
}

document.addEventListener('DOMContentLoaded',init);
