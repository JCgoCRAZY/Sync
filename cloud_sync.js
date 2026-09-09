(() => {
  'use strict';

  const CONFIG = Object.freeze({
    projectUrl: 'https://pvjsxskkwnjpwukrilos.supabase.co',
    publishableKey: 'sb_publishable_sKdJQWOKviE3b2JWNDHSHA_38ez9kdC',
    stateTable: 'app_state',
    documentTable: 'app_documents',
    bucket: 'user-files',
  });

  const DB_NAME = 'university-study-hub';
  const DB_VERSION = 1;
  const STORES = { meta: 'meta', documents: 'documents', blobs: 'blobs' };
  const LOCAL_QUEUE_KEY = 'cloud:queue:local';
  const DEVICE_KEY = 'ushub-cloud-device-id';
  const SYNC_SCHEMA_VERSION = 2;
  const SYNC_DEBOUNCE_MS = 700;
  const AUTH_REDIRECT_URL = 'https://jcgocrazy.github.io/Sync/';
  const MISSING = Symbol('missing');

  let dbPromise = null;
  let client = null;
  let libraryPromise = null;
  let session = null;
  let currentUserId = null;
  let currentUserEmail = null;
  let channel = null;
  let flushTimer = null;
  let flushPromise = null;
  let initialized = false;
  let authListenerBound = false;
  let bootstrapPromise = null;
  let initialChoice = null;
  let currentConflict = null;
  let realtimeSerial = Promise.resolve();
  let connectivityBound = false;

  const listeners = new Set();
  const status = {
    available: false,
    signedIn: false,
    phase: 'starting',
    message: 'Starting cloud sync…',
    lastSync: null,
    email: null,
    needsChoice: false,
    conflict: false,
    online: navigator.onLine,
    pendingChanges: 0,
    deviceId: null,
  };

  function nowIso() { return new Date().toISOString(); }
  function clone(value) { return value == null ? value : structuredClone(value); }
  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      const body = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(16).slice(2)}`;
      id = `device_${body.slice(0, 24)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function emitStatus(patch = {}) {
    Object.assign(status, patch, {
      online: navigator.onLine,
      email: currentUserEmail,
      deviceId: deviceId(),
    });
    const detail = clone(status);
    listeners.forEach(fn => { try { fn(detail); } catch (err) { console.error(err); } });
    window.dispatchEvent(new CustomEvent('studyhub-cloud-status', { detail }));
  }
  function emitRemote(detail) {
    window.dispatchEvent(new CustomEvent('studyhub-cloud-remote', { detail }));
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Object.values(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function idbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(store, key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbEntries(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        out.push([cursor.key, cursor.value]);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
  async function idbClear(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function metaKey(userId) { return `cloud:meta:${userId}`; }
  function stateBaseKey(userId) { return `cloud:base-state:${userId}`; }
  function queueKey(userId = currentUserId) { return userId ? `cloud:queue:${userId}` : LOCAL_QUEUE_KEY; }
  function conflictKey(userId = currentUserId) { return `cloud:conflict:${userId || 'local'}`; }
  function blankMeta(userId) {
    return {
      userId,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      stateRevision: 0,
      stateHash: '',
      docRevisions: {},
      docHashes: {},
      lastSync: null,
    };
  }
  function blankQueue() {
    return {
      stateDirty: false,
      dirtyDocs: [],
      deletedDocs: [],
      dirtyBlobs: [],
      deletedBlobs: [],
      updatedAt: null,
    };
  }
  function unique(values) { return [...new Set((values || []).filter(Boolean).map(String))]; }
  function removeValue(values, value) { return (values || []).filter(x => String(x) !== String(value)); }
  function queueCount(queue) {
    if (!queue) return 0;
    return Number(Boolean(queue.stateDirty))
      + unique(queue.dirtyDocs).length
      + unique(queue.deletedDocs).length
      + unique(queue.dirtyBlobs).length
      + unique(queue.deletedBlobs).length;
  }

  async function getMeta(userId = currentUserId) {
    if (!userId) return blankMeta(null);
    const raw = await idbGet(STORES.meta, metaKey(userId));
    return {
      ...blankMeta(userId),
      ...(raw || {}),
      userId,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      docRevisions: { ...(raw?.docRevisions || {}) },
      docHashes: { ...(raw?.docHashes || {}) },
    };
  }
  async function setMeta(meta) {
    if (!meta?.userId) return;
    meta.syncSchemaVersion = SYNC_SCHEMA_VERSION;
    await idbSet(STORES.meta, metaKey(meta.userId), meta);
  }
  async function getStateBase(userId = currentUserId) {
    if (!userId) return null;
    return await idbGet(STORES.meta, stateBaseKey(userId)) || null;
  }
  async function setStateBase(value, userId = currentUserId) {
    if (!userId) return;
    if (value == null) await idbDelete(STORES.meta, stateBaseKey(userId));
    else await idbSet(STORES.meta, stateBaseKey(userId), clone(value));
  }
  async function getQueue(userId = currentUserId) {
    const raw = await idbGet(STORES.meta, queueKey(userId));
    return {
      ...blankQueue(),
      ...(raw || {}),
      dirtyDocs: unique(raw?.dirtyDocs || []),
      deletedDocs: unique(raw?.deletedDocs || []),
      dirtyBlobs: unique(raw?.dirtyBlobs || []),
      deletedBlobs: unique(raw?.deletedBlobs || []),
    };
  }
  async function setQueue(queue, userId = currentUserId, { emit = false } = {}) {
    queue.dirtyDocs = unique(queue.dirtyDocs);
    queue.deletedDocs = unique(queue.deletedDocs);
    queue.dirtyBlobs = unique(queue.dirtyBlobs);
    queue.deletedBlobs = unique(queue.deletedBlobs);
    queue.updatedAt = nowIso();
    await idbSet(STORES.meta, queueKey(userId), queue);
    if (emit) emitPendingStatus(queue);
  }
  function emitPendingStatus(queue) {
    const pending = queueCount(queue);
    if (!currentUserId) return emitStatus({ pendingChanges: pending });
    if (!navigator.onLine) {
      emitStatus({
        phase: 'offline',
        pendingChanges: pending,
        message: pending ? `Offline — ${pending} change${pending === 1 ? '' : 's'} waiting to sync.` : 'Offline — local data is safe. Cloud sync will resume when internet returns.',
      });
    } else if (pending && !initialChoice && !currentConflict) {
      emitStatus({ phase: 'pending', pendingChanges: pending, message: `${pending} change${pending === 1 ? '' : 's'} saved locally — cloud sync queued.` });
    } else {
      emitStatus({ pendingChanges: pending });
    }
  }

  async function migrateLocalQueueToUser(userId) {
    const local = await getQueue(null);
    if (!queueCount(local)) return;
    const target = await getQueue(userId);
    target.stateDirty ||= local.stateDirty;
    target.dirtyDocs = unique([...target.dirtyDocs, ...local.dirtyDocs]);
    target.deletedDocs = unique([...target.deletedDocs, ...local.deletedDocs]);
    target.dirtyBlobs = unique([...target.dirtyBlobs, ...local.dirtyBlobs]);
    target.deletedBlobs = unique([...target.deletedBlobs, ...local.deletedBlobs]);
    await setQueue(target, userId);
    await idbSet(STORES.meta, LOCAL_QUEUE_KEY, blankQueue());
  }

  function localHasMeaningfulData(state) {
    if (!state?.profiles || typeof state.profiles !== 'object') return false;
    for (const profile of Object.values(state.profiles)) {
      if (Object.keys(profile?.courses || {}).length) return true;
      if ((profile?.personal_notes || []).length) return true;
      if ((profile?.schedule?.personal_events || []).length) return true;
      if (Object.keys(profile?.schedule?.course_meetings || {}).length) return true;
    }
    return false;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Blob);
  }
  function stableStringify(value) {
    const seen = new WeakSet();
    const normalize = item => {
      if (item === undefined) return { __studyHubUndefined: true };
      if (item === null || typeof item !== 'object') return item;
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
      if (Array.isArray(item)) return item.map(normalize);
      const out = {};
      for (const key of Object.keys(item).sort()) out[key] = normalize(item[key]);
      return out;
    };
    return JSON.stringify(normalize(value));
  }
  function quickHash(value) {
    const text = stableStringify(value);
    let h1 = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h1 ^= text.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0');
  }
  function sameValue(a, b) { return stableStringify(a) === stableStringify(b); }
  function sameNode(a, b) {
    if (a === MISSING || b === MISSING) return a === b;
    return sameValue(a, b);
  }

  // UI navigation is device-local. Keeping it out of the cloud prevents a Mac opening
  // a tab from creating a false data conflict with an iPad doing actual schoolwork.
  function stateForCloud(fullState) {
    const out = clone(fullState || {});
    if (out.app) {
      delete out.app.last_saved;
      delete out.app.version;
    }
    delete out.active_profile_id;
    for (const profile of Object.values(out.profiles || {})) {
      delete profile.ui_state;
      if (profile.schedule) { delete profile.schedule.calendar_week; delete profile.schedule._web_view; }
      for (const course of Object.values(profile.courses || {})) delete course.ui_state;
    }
    return out;
  }

  function restoreLocalUi(remoteDurable, localFull) {
    const out = clone(remoteDurable || {});
    const local = localFull || {};
    out.app ||= {};
    if (local.app?.last_saved) out.app.last_saved = local.app.last_saved;
    if (local.app?.version) out.app.version = local.app.version;
    const localActive = local.active_profile_id;
    if (localActive && out.profiles?.[localActive]) out.active_profile_id = localActive;
    else if (!out.active_profile_id) out.active_profile_id = Object.keys(out.profiles || {})[0] || null;

    for (const [profileId, profile] of Object.entries(out.profiles || {})) {
      const localProfile = local.profiles?.[profileId];
      if (localProfile?.ui_state) profile.ui_state = clone(localProfile.ui_state);
      if (profile.schedule && localProfile?.schedule?.calendar_week) profile.schedule.calendar_week = localProfile.schedule.calendar_week;
      for (const [courseId, course] of Object.entries(profile.courses || {})) {
        const localCourse = localProfile?.courses?.[courseId];
        if (localCourse?.ui_state) course.ui_state = clone(localCourse.ui_state);
      }
    }
    return out;
  }

  function isTimestampPath(path) {
    const key = String(path[path.length - 1] || '');
    return /(^|_)(updated|created|opened|saved|tested)_at$/i.test(key) || /_at$/i.test(key);
  }
  function newerTimestamp(a, b) {
    const ta = Date.parse(String(a || ''));
    const tb = Date.parse(String(b || ''));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? a : b;
    return String(a || '') >= String(b || '') ? a : b;
  }
  function arrayHasStableIds(arr) {
    return Array.isArray(arr) && arr.every(item => isPlainObject(item) && item.id != null && String(item.id));
  }
  function isPrimitiveArray(arr) {
    return Array.isArray(arr) && arr.every(item => item == null || ['string', 'number', 'boolean'].includes(typeof item));
  }

  function mergePrimitiveArray(base, local, remote) {
    const b = new Set((base || []).map(x => stableStringify(x)));
    const l = new Map((local || []).map(x => [stableStringify(x), x]));
    const r = new Map((remote || []).map(x => [stableStringify(x), x]));
    const all = new Set([...b, ...l.keys(), ...r.keys()]);
    const include = new Set();
    for (const key of all) {
      const bm = b.has(key), lm = l.has(key), rm = r.has(key);
      if (lm === rm) { if (lm) include.add(key); continue; }
      if (lm === bm) { if (rm) include.add(key); continue; }
      if (rm === bm) { if (lm) include.add(key); continue; }
      if (lm) include.add(key);
    }
    const localChanged = !sameValue(base || [], local || []);
    const preferred = localChanged ? (local || []) : (remote || []);
    const alternate = localChanged ? (remote || []) : (local || []);
    const out = [];
    const push = value => {
      const key = stableStringify(value);
      if (include.has(key) && !out.some(x => stableStringify(x) === key)) out.push(clone(value));
    };
    preferred.forEach(push);
    alternate.forEach(push);
    return out;
  }

  function mergeThreeWay(base, local, remote, path = []) {
    if (sameNode(local, remote)) return { value: local === MISSING ? MISSING : clone(local), conflicts: [] };
    if (sameNode(local, base)) return { value: remote === MISSING ? MISSING : clone(remote), conflicts: [] };
    if (sameNode(remote, base)) return { value: local === MISSING ? MISSING : clone(local), conflicts: [] };

    if (local !== MISSING && remote !== MISSING && isTimestampPath(path) && typeof local === 'string' && typeof remote === 'string') {
      return { value: newerTimestamp(local, remote), conflicts: [] };
    }

    if (local !== MISSING && remote !== MISSING && isPlainObject(local) && isPlainObject(remote) && (base === MISSING || isPlainObject(base))) {
      const b = base === MISSING ? {} : base;
      const keys = new Set([...Object.keys(b), ...Object.keys(local), ...Object.keys(remote)]);
      const out = {};
      const conflicts = [];
      for (const key of keys) {
        const hasB = Object.prototype.hasOwnProperty.call(b, key);
        const hasL = Object.prototype.hasOwnProperty.call(local, key);
        const hasR = Object.prototype.hasOwnProperty.call(remote, key);
        const merged = mergeThreeWay(hasB ? b[key] : MISSING, hasL ? local[key] : MISSING, hasR ? remote[key] : MISSING, [...path, key]);
        conflicts.push(...merged.conflicts);
        if (merged.value !== MISSING) out[key] = merged.value;
      }
      return { value: out, conflicts };
    }

    if (local !== MISSING && remote !== MISSING && Array.isArray(local) && Array.isArray(remote) && (base === MISSING || Array.isArray(base))) {
      const b = base === MISSING ? [] : base;
      if (arrayHasStableIds(local) && arrayHasStableIds(remote) && (b.length === 0 || arrayHasStableIds(b))) {
        const bm = new Map(b.map(item => [String(item.id), item]));
        const lm = new Map(local.map(item => [String(item.id), item]));
        const rm = new Map(remote.map(item => [String(item.id), item]));
        const ids = new Set([...bm.keys(), ...lm.keys(), ...rm.keys()]);
        const resultById = new Map();
        const conflicts = [];
        for (const id of ids) {
          const merged = mergeThreeWay(bm.has(id) ? bm.get(id) : MISSING, lm.has(id) ? lm.get(id) : MISSING, rm.has(id) ? rm.get(id) : MISSING, [...path, `@${id}`]);
          conflicts.push(...merged.conflicts);
          if (merged.value !== MISSING) resultById.set(id, merged.value);
        }
        const out = [];
        const order = [...remote.map(x => String(x.id)), ...local.map(x => String(x.id))];
        for (const id of order) {
          if (!resultById.has(id)) continue;
          out.push(resultById.get(id));
          resultById.delete(id);
        }
        for (const value of resultById.values()) out.push(value);
        return { value: out, conflicts };
      }
      if (isPrimitiveArray(local) && isPrimitiveArray(remote) && isPrimitiveArray(b)) {
        return { value: mergePrimitiveArray(b, local, remote), conflicts: [] };
      }
    }

    return {
      value: local === MISSING ? MISSING : clone(local),
      conflicts: [{
        path: path.map(String),
        localExists: local !== MISSING,
        localValue: local === MISSING ? null : clone(local),
        remoteExists: remote !== MISSING,
        remoteValue: remote === MISSING ? null : clone(remote),
      }],
    };
  }

  function pathLabel(path) {
    return (path || []).map(segment => String(segment).startsWith('@') ? `[${String(segment).slice(1)}]` : String(segment)).join('.');
  }
  function applyPathChoice(root, entry, useRemote) {
    const path = entry.path || [];
    const exists = useRemote ? entry.remoteExists : entry.localExists;
    const value = useRemote ? entry.remoteValue : entry.localValue;
    if (!path.length) return exists ? clone(value) : {};
    let current = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = String(path[i]);
      const next = String(path[i + 1]);
      if (segment.startsWith('@')) {
        if (!Array.isArray(current)) return root;
        const id = segment.slice(1);
        let item = current.find(x => String(x?.id) === id);
        if (!item) {
          item = { id };
          current.push(item);
        }
        current = item;
      } else {
        if (!current[segment] || typeof current[segment] !== 'object') current[segment] = next.startsWith('@') ? [] : {};
        current = current[segment];
      }
    }
    const last = String(path[path.length - 1]);
    if (last.startsWith('@')) {
      if (!Array.isArray(current)) return root;
      const id = last.slice(1);
      const index = current.findIndex(x => String(x?.id) === id);
      if (!exists) { if (index >= 0) current.splice(index, 1); }
      else if (index >= 0) current[index] = clone(value);
      else current.push(clone(value));
    } else if (!exists) {
      delete current[last];
    } else {
      current[last] = clone(value);
    }
    return root;
  }

  function loadSupabaseLibrary() {
    if (window.supabase?.createClient) return Promise.resolve(window.supabase);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-studyhub-supabase]');
      const script = existing || document.createElement('script');
      const timer = setTimeout(() => reject(new Error('Supabase library timed out.')), 7000);
      const finish = () => {
        clearTimeout(timer);
        window.supabase?.createClient ? resolve(window.supabase) : reject(new Error('Supabase library did not initialize.'));
      };
      if (!existing) {
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0';
        script.async = true;
        script.dataset.studyhubSupabase = '1';
        script.onload = finish;
        script.onerror = () => { clearTimeout(timer); reject(new Error('Supabase library could not be downloaded.')); };
        document.head.appendChild(script);
      } else {
        script.addEventListener('load', finish, { once: true });
        script.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Supabase library could not be downloaded.')); }, { once: true });
      }
    }).catch(err => { libraryPromise = null; throw err; });
    return libraryPromise;
  }

  async function ensureClient() {
    if (client) return client;
    let lib = window.supabase;
    if (!lib?.createClient) {
      try { lib = await loadSupabaseLibrary(); }
      catch (err) {
        emitStatus({
          available: false,
          phase: navigator.onLine ? 'local' : 'offline',
          message: navigator.onLine ? 'Cloud library unavailable — working locally.' : 'Offline — working locally. Cloud sync will reconnect automatically.',
        });
        return null;
      }
    }
    client = lib.createClient(CONFIG.projectUrl, CONFIG.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    emitStatus({ available: true, phase: 'ready', message: 'Cloud available.' });
    return client;
  }

  async function fetchRemoteState() {
    if (!client || !currentUserId) return null;
    const { data, error } = await client.from(CONFIG.stateTable)
      .select('user_id,state,revision,updated_at,updated_by_device')
      .eq('user_id', currentUserId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }
  async function fetchRemoteDocuments() {
    if (!client || !currentUserId) return [];
    const { data, error } = await client.from(CONFIG.documentTable)
      .select('document_id,document,revision,updated_at,updated_by_device,deleted_at')
      .eq('user_id', currentUserId);
    if (error) throw error;
    return data || [];
  }

  async function acceptRemoteStateRevision(row, { apply = true, notify = true } = {}) {
    if (!row?.state) return;
    const remoteDurable = stateForCloud(row.state);
    const localFull = await idbGet(STORES.meta, 'state');
    if (apply) await idbSet(STORES.meta, 'state', restoreLocalUi(remoteDurable, localFull));
    const meta = await getMeta();
    meta.stateRevision = Number(row.revision || 0);
    meta.stateHash = quickHash(remoteDurable);
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setStateBase(remoteDurable);
    if (notify && apply) emitRemote({ kind: 'state', revision: meta.stateRevision });
  }

  async function applyRemoteStateRow(row, options = {}) {
    await acceptRemoteStateRevision(row, { apply: true, notify: options.notify !== false });
  }

  async function applyRemoteDocumentRow(row, { notify = true } = {}) {
    const id = String(row?.document_id || '');
    if (!id) return;
    const before = await idbGet(STORES.documents, id);
    if (row.deleted_at || !row.document) {
      await idbDelete(STORES.documents, id);
      await idbDelete(STORES.blobs, `pdf:${id}`);
    } else {
      const oldAssigned = before?.slides_attachment?.assigned_at || null;
      const newAssigned = row.document?.slides_attachment?.assigned_at || null;
      const oldCloudObject = before?.slides_attachment?.cloud_object || null;
      const newCloudObject = row.document?.slides_attachment?.cloud_object || null;
      if (oldAssigned !== newAssigned || oldCloudObject !== newCloudObject || (!row.document?.slides_attachment && before?.slides_attachment)) {
        await idbDelete(STORES.blobs, `pdf:${id}`);
      }
      await idbSet(STORES.documents, id, row.document);
    }
    const meta = await getMeta();
    meta.docRevisions ||= {};
    meta.docHashes ||= {};
    meta.docRevisions[id] = Number(row.revision || 0);
    meta.docHashes[id] = quickHash(row.deleted_at || !row.document ? { deleted: true } : row.document);
    meta.lastSync = nowIso();
    await setMeta(meta);
    if (notify) emitRemote({ kind: 'document', documentId: id, deleted: Boolean(row.deleted_at || !row.document), revision: meta.docRevisions[id] });
  }

  async function replaceLocalFromCloud(remoteState) {
    emitStatus({ phase: 'syncing', message: 'Downloading cloud workspace…', needsChoice: false });
    const docs = await fetchRemoteDocuments();
    await idbClear(STORES.documents);
    await idbClear(STORES.blobs);
    await applyRemoteStateRow(remoteState, { notify: false });
    const meta = await getMeta();
    meta.docRevisions = {};
    meta.docHashes = {};
    for (const row of docs) {
      const id = String(row.document_id);
      if (!row.deleted_at && row.document) await idbSet(STORES.documents, id, row.document);
      meta.docRevisions[id] = Number(row.revision || 0);
      meta.docHashes[id] = quickHash(row.deleted_at || !row.document ? { deleted: true } : row.document);
    }
    meta.stateRevision = Number(remoteState.revision || 0);
    meta.stateHash = quickHash(stateForCloud(remoteState.state));
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setStateBase(stateForCloud(remoteState.state));
    await setQueue(blankQueue());
    initialChoice = null;
    currentConflict = null;
    await idbDelete(STORES.meta, conflictKey());
    emitStatus({ phase: 'synced', message: 'Cloud workspace downloaded.', lastSync: meta.lastSync, needsChoice: false, conflict: false, pendingChanges: 0 });
    emitRemote({ kind: 'workspace' });
  }

  async function uploadLocalAsNewCloud() {
    emitStatus({ phase: 'syncing', message: 'Creating your cloud workspace…' });
    const queue = await getQueue();
    queue.stateDirty = true;
    const docs = await idbEntries(STORES.documents);
    queue.dirtyDocs = unique([...queue.dirtyDocs, ...docs.map(([id]) => id)]);
    const blobs = await idbEntries(STORES.blobs);
    queue.dirtyBlobs = unique([...queue.dirtyBlobs, ...blobs.filter(([key, blob]) => String(key).startsWith('pdf:') && blob instanceof Blob).map(([key]) => key)]);
    await setQueue(queue, currentUserId, { emit: true });
    await flushNow();
  }

  async function replaceCloudFromLocal(remoteState = null) {
    if (!currentUserId || !client) throw new Error('Sign in first.');
    if (!navigator.onLine) throw new Error('Internet connection is required to make this device the cloud master.');
    emitStatus({ phase: 'syncing', message: 'Uploading this device as the cloud master…', needsChoice: false });

    // Version PDFs first and write their cloud object names into the local Lecture document.
    const blobs = await idbEntries(STORES.blobs);
    for (const [key, blob] of blobs) {
      if (String(key).startsWith('pdf:') && blob instanceof Blob) await uploadBlob(String(key), blob);
    }

    const localFullState = await idbGet(STORES.meta, 'state');
    const localDurable = stateForCloud(localFullState || {});
    const latest = remoteState || await fetchRemoteState();
    const nextRevision = Number(latest?.revision || 0) + 1;
    const payload = {
      user_id: currentUserId,
      state: localDurable,
      revision: nextRevision,
      updated_at: nowIso(),
      updated_by_device: deviceId(),
    };
    let result;
    if (latest) {
      result = await client.from(CONFIG.stateTable).update(payload)
        .eq('user_id', currentUserId).eq('revision', Number(latest.revision || 0)).select().maybeSingle();
    } else {
      result = await client.from(CONFIG.stateTable).insert(payload).select().maybeSingle();
    }
    if (result.error) throw result.error;
    if (!result.data) throw new Error('Cloud workspace changed before it could be replaced. Try again.');

    const remoteDocs = await fetchRemoteDocuments();
    const remoteMap = new Map(remoteDocs.map(row => [String(row.document_id), row]));
    const localDocs = new Map(await idbEntries(STORES.documents));
    const docRevisions = {};
    const docHashes = {};

    for (const [id, doc] of localDocs) {
      const old = remoteMap.get(String(id));
      const revision = Number(old?.revision || 0) + 1;
      const row = { user_id: currentUserId, document_id: String(id), document: doc, revision, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: null };
      const { data, error } = await client.from(CONFIG.documentTable).upsert(row, { onConflict: 'user_id,document_id' }).select().maybeSingle();
      if (error) throw error;
      docRevisions[String(id)] = Number(data?.revision || revision);
      docHashes[String(id)] = quickHash(doc);
    }
    for (const [id, old] of remoteMap) {
      if (localDocs.has(id) || old.deleted_at) continue;
      const revision = Number(old.revision || 0) + 1;
      const { data, error } = await client.from(CONFIG.documentTable).update({ document: null, revision, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: nowIso() })
        .eq('user_id', currentUserId).eq('document_id', id).eq('revision', Number(old.revision || 0)).select().maybeSingle();
      if (error) throw error;
      docRevisions[id] = Number(data?.revision || revision);
      docHashes[id] = quickHash({ deleted: true });
    }

    const meta = blankMeta(currentUserId);
    meta.stateRevision = Number(result.data.revision || nextRevision);
    meta.stateHash = quickHash(localDurable);
    meta.docRevisions = docRevisions;
    meta.docHashes = docHashes;
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setStateBase(localDurable);
    await setQueue(blankQueue());
    initialChoice = null;
    currentConflict = null;
    await idbDelete(STORES.meta, conflictKey());
    emitStatus({ phase: 'synced', message: 'This device is now the cloud master.', lastSync: meta.lastSync, needsChoice: false, conflict: false, pendingChanges: 0 });
    return true;
  }

  async function reconcileRemoteStateRow(row, { notify = true } = {}) {
    if (!row?.state) return 'ignored';
    const meta = await getMeta();
    const remoteRevision = Number(row.revision || 0);
    if (remoteRevision < Number(meta.stateRevision || 0)) return 'stale';

    const queue = await getQueue();
    const localFull = await idbGet(STORES.meta, 'state');
    const localDurable = stateForCloud(localFull || {});
    const remoteDurable = stateForCloud(row.state || {});

    if (!queue.stateDirty) {
      if (remoteRevision === Number(meta.stateRevision || 0) && sameValue(localDurable, remoteDurable)) {
        if (!(await getStateBase())) await setStateBase(remoteDurable);
        return 'same';
      }
      await acceptRemoteStateRevision(row, { apply: true, notify });
      return 'applied';
    }

    // The most common false-conflict case: local was marked dirty only by a UI save,
    // while the durable cloud data is already identical.
    if (sameValue(localDurable, remoteDurable)) {
      queue.stateDirty = false;
      await setQueue(queue);
      await acceptRemoteStateRevision(row, { apply: false, notify: false });
      emitPendingStatus(queue);
      return 'same';
    }

    const base = await getStateBase();
    if (!base) {
      await createConflict({
        kind: 'state',
        local: localDurable,
        remote: row,
        remoteDurable,
        base: null,
        autoMerged: localDurable,
        conflictEntries: [{ path: [], localExists: true, localValue: localDurable, remoteExists: true, remoteValue: remoteDurable }],
      });
      return 'conflict';
    }

    const merged = mergeThreeWay(base, localDurable, remoteDurable);
    if (merged.conflicts.length) {
      // Apply all non-conflicting remote changes immediately. The conflict dialog now
      // represents only the exact field(s) that truly overlap, never the whole workspace.
      await idbSet(STORES.meta, 'state', restoreLocalUi(merged.value, localFull));
      meta.stateRevision = remoteRevision;
      meta.stateHash = quickHash(remoteDurable);
      meta.lastSync = nowIso();
      await setMeta(meta);
      await setStateBase(remoteDurable);
      queue.stateDirty = true;
      await setQueue(queue);
      await createConflict({
        kind: 'state',
        local: localDurable,
        remote: row,
        remoteDurable,
        base,
        autoMerged: merged.value,
        conflictEntries: merged.conflicts,
      });
      if (notify) emitRemote({ kind: 'state', revision: remoteRevision, merged: true, conflict: true });
      return 'conflict';
    }

    // Unrelated changes (for example, Mac edits BIO while iPad edits CHM) merge automatically.
    const mergedDurable = merged.value;
    await idbSet(STORES.meta, 'state', restoreLocalUi(mergedDurable, localFull));
    meta.stateRevision = remoteRevision;
    meta.stateHash = quickHash(remoteDurable);
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setStateBase(remoteDurable);
    queue.stateDirty = !sameValue(mergedDurable, remoteDurable);
    await setQueue(queue);
    if (notify) emitRemote({ kind: 'state', revision: remoteRevision, merged: true });
    if (queue.stateDirty) scheduleFlush();
    else emitPendingStatus(queue);
    return queue.stateDirty ? 'merged-pending' : 'applied';
  }

  async function reconcileRemoteDocumentRow(row, { notify = true } = {}) {
    const id = String(row?.document_id || '');
    if (!id) return 'ignored';
    const meta = await getMeta();
    const remoteRevision = Number(row.revision || 0);
    const localRevision = Number(meta.docRevisions?.[id] || 0);
    if (remoteRevision <= localRevision) return 'stale';

    const queue = await getQueue();
    const dirty = queue.dirtyDocs.includes(id) || queue.deletedDocs.includes(id);
    if (!dirty) {
      await applyRemoteDocumentRow(row, { notify });
      return 'applied';
    }

    const deleting = queue.deletedDocs.includes(id);
    const remoteDeleted = Boolean(row.deleted_at || !row.document);
    const localDoc = await idbGet(STORES.documents, id);
    const same = deleting ? remoteDeleted : (!remoteDeleted && sameValue(localDoc || {}, row.document || {}));
    if (same) {
      meta.docRevisions ||= {};
      meta.docHashes ||= {};
      meta.docRevisions[id] = remoteRevision;
      meta.docHashes[id] = quickHash(remoteDeleted ? { deleted: true } : row.document);
      meta.lastSync = nowIso();
      await setMeta(meta);
      queue.dirtyDocs = removeValue(queue.dirtyDocs, id);
      queue.deletedDocs = removeValue(queue.deletedDocs, id);
      await setQueue(queue);
      emitPendingStatus(queue);
      return 'same';
    }

    await createConflict({ kind: 'document', id, local: deleting ? null : localDoc, localDeleting: deleting, remote: row });
    return 'conflict';
  }

  async function bootstrapUser(user) {
    if (!user?.id || !client) return;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      currentUserId = user.id;
      currentUserEmail = user.email || '';
      session = (await client.auth.getSession()).data.session || session;
      await migrateLocalQueueToUser(currentUserId);
      emitStatus({ signedIn: true, phase: 'syncing', message: 'Connecting to your cloud workspace…', email: currentUserEmail });

      let remote;
      try {
        remote = await fetchRemoteState();
      } catch (err) {
        console.error(err);
        emitStatus({ phase: navigator.onLine ? 'error' : 'offline', message: navigator.onLine ? `Cloud setup error: ${err.message || err}` : 'Offline — changes will sync when internet returns.' });
        return;
      }

      const localState = await idbGet(STORES.meta, 'state');
      const meta = await getMeta();
      const base = await getStateBase();
      const firstUseForThisAccount = Number(meta.stateRevision || 0) === 0 && !base;

      if (!remote) {
        await setMeta(blankMeta(currentUserId));
        await setStateBase(null);
        await uploadLocalAsNewCloud();
      } else if (firstUseForThisAccount && localHasMeaningfulData(localState) && !sameValue(stateForCloud(localState), stateForCloud(remote.state))) {
        initialChoice = { remoteState: remote };
        emitStatus({ phase: 'needs-choice', message: 'Cloud data and local data both exist. Choose which copy to use.', needsChoice: true });
      } else if (firstUseForThisAccount) {
        await setMeta(blankMeta(currentUserId));
        await replaceLocalFromCloud(remote);
      } else {
        if (Number(remote.revision || 0) > Number(meta.stateRevision || 0)) await reconcileRemoteStateRow(remote, { notify: false });
        else if (!base) await setStateBase(stateForCloud(remote.state));
        if (!currentConflict) await syncRemoteDocumentsSnapshot();
        if (!currentConflict) await flushNow();
      }
      await subscribeRealtime();
      if (!currentConflict && !initialChoice) {
        const latestMeta = await getMeta();
        const queue = await getQueue();
        emitStatus({
          phase: navigator.onLine ? (queueCount(queue) ? 'pending' : 'synced') : 'offline',
          message: navigator.onLine ? (queueCount(queue) ? `${queueCount(queue)} change${queueCount(queue) === 1 ? '' : 's'} waiting to sync.` : 'Cloud synced.') : 'Offline — changes are saved locally.',
          lastSync: latestMeta.lastSync,
          needsChoice: false,
          conflict: false,
          pendingChanges: queueCount(queue),
        });
        if (queueCount(queue) && navigator.onLine) scheduleFlush();
      }
    })().finally(() => { bootstrapPromise = null; });
    return bootstrapPromise;
  }

  async function syncRemoteDocumentsSnapshot() {
    if (!currentUserId || !client) return;
    const rows = await fetchRemoteDocuments();
    const meta = await getMeta();
    for (const row of rows) {
      const id = String(row.document_id);
      if (Number(row.revision || 0) <= Number(meta.docRevisions?.[id] || 0)) continue;
      const result = await reconcileRemoteDocumentRow(row, { notify: false });
      if (result === 'conflict') break;
    }
  }

  async function createConflict(conflict) {
    const normalized = { ...clone(conflict), syncVersion: SYNC_SCHEMA_VERSION, createdAt: nowIso() };
    currentConflict = normalized;
    await idbSet(STORES.meta, conflictKey(), normalized);
    const label = conflict.kind === 'document' ? 'Lecture' : 'data field';
    emitStatus({ phase: 'conflict', message: `A ${label} sync conflict needs your choice before cloud saving can continue.`, conflict: true });
    window.dispatchEvent(new CustomEvent('studyhub-cloud-conflict', { detail: clone(currentConflict) }));
  }

  async function loadPersistedConflict() {
    if (!currentUserId) return;
    const stored = await idbGet(STORES.meta, conflictKey()) || null;
    // Old Phase-6 conflicts were workspace-wide and could be false positives after a normal reopen.
    if (stored && Number(stored.syncVersion || 0) !== SYNC_SCHEMA_VERSION) {
      await idbDelete(STORES.meta, conflictKey());
      currentConflict = null;
      return;
    }
    currentConflict = stored;
    if (currentConflict) emitStatus({ phase: 'conflict', message: 'A genuine sync conflict needs your choice.', conflict: true });
  }

  async function resolveConflict(strategy) {
    if (!currentConflict || !currentUserId || !client) return false;
    if (!['cloud', 'local'].includes(strategy)) return false;
    const conflict = currentConflict;

    if (conflict.kind === 'state') {
      const localFull = await idbGet(STORES.meta, 'state');
      // The local state already contains all automatically merged non-conflicting changes.
      // Starting from the current copy also preserves edits made while the dialog was open.
      let chosen = stateForCloud(localFull || {});
      if (strategy === 'cloud') {
        for (const entry of conflict.conflictEntries || []) chosen = applyPathChoice(chosen, entry, true);
      }
      const latestRemote = await fetchRemoteState();
      if (!latestRemote) throw new Error('Cloud state disappeared.');
      const latestDurable = stateForCloud(latestRemote.state || {});
      await idbSet(STORES.meta, 'state', restoreLocalUi(chosen, localFull));
      const meta = await getMeta();
      meta.stateRevision = Number(latestRemote.revision || 0);
      meta.stateHash = quickHash(latestDurable);
      meta.lastSync = nowIso();
      await setMeta(meta);
      await setStateBase(latestDurable);
      const queue = await getQueue();
      queue.stateDirty = !sameValue(chosen, latestDurable);
      await setQueue(queue);
    } else if (conflict.kind === 'document') {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', conflict.id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      const remote = remoteResult.data;
      const queue = await getQueue();
      const meta = await getMeta();
      if (strategy === 'cloud') {
        if (remote) await applyRemoteDocumentRow(remote);
        queue.dirtyDocs = removeValue(queue.dirtyDocs, conflict.id);
        queue.deletedDocs = removeValue(queue.deletedDocs, conflict.id);
        await setQueue(queue);
      } else {
        const base = Number(remote?.revision || 0);
        meta.docRevisions ||= {};
        meta.docRevisions[String(conflict.id)] = base;
        await setMeta(meta);
        const currentLocal = await idbGet(STORES.documents, String(conflict.id));
        const deletingNow = queue.deletedDocs.includes(String(conflict.id)) || currentLocal == null;
        if (deletingNow) {
          queue.deletedDocs = unique([...queue.deletedDocs, String(conflict.id)]);
          queue.dirtyDocs = removeValue(queue.dirtyDocs, conflict.id);
        } else {
          queue.dirtyDocs = unique([...queue.dirtyDocs, String(conflict.id)]);
          queue.deletedDocs = removeValue(queue.deletedDocs, conflict.id);
        }
        await setQueue(queue);
      }
    }

    currentConflict = null;
    await idbDelete(STORES.meta, conflictKey());
    emitStatus({ phase: 'syncing', message: 'Conflict resolved. Finishing sync…', conflict: false });
    await flushNow();
    return true;
  }

  async function markQueue(mutator) {
    const q = await getQueue();
    mutator(q);
    q.dirtyDocs = unique(q.dirtyDocs);
    q.deletedDocs = unique(q.deletedDocs);
    q.dirtyBlobs = unique(q.dirtyBlobs);
    q.deletedBlobs = unique(q.deletedBlobs);
    await setQueue(q, currentUserId, { emit: true });
    scheduleFlush();
  }
  async function markStateDirty() { await markQueue(q => { q.stateDirty = true; }); }
  async function markDocumentDirty(id) { await markQueue(q => { q.dirtyDocs.push(String(id)); q.deletedDocs = removeValue(q.deletedDocs, id); }); }
  async function markDocumentDeleted(id) { await markQueue(q => { q.deletedDocs.push(String(id)); q.dirtyDocs = removeValue(q.dirtyDocs, id); }); }
  async function markBlobDirty(key) { await markQueue(q => { q.dirtyBlobs.push(String(key)); q.deletedBlobs = removeValue(q.deletedBlobs, key); }); }
  async function markBlobDeleted(key) { await markQueue(q => { q.deletedBlobs.push(String(key)); q.dirtyBlobs = removeValue(q.dirtyBlobs, key); }); }
  async function markEverythingDirty() {
    const docs = await idbEntries(STORES.documents);
    const blobs = await idbEntries(STORES.blobs);
    await markQueue(q => {
      q.stateDirty = true;
      q.dirtyDocs.push(...docs.map(([id]) => String(id)));
      q.dirtyBlobs.push(...blobs.filter(([key, blob]) => String(key).startsWith('pdf:') && blob instanceof Blob).map(([key]) => String(key)));
    });
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    if (!currentUserId || initialChoice || currentConflict) return;
    if (!navigator.onLine) {
      getQueue().then(emitPendingStatus).catch(() => {});
      return;
    }
    getQueue().then(q => {
      const pending = queueCount(q);
      if (!pending) return emitStatus({ phase: 'synced', message: 'Cloud synced.', pendingChanges: 0 });
      emitStatus({ phase: 'pending', message: `${pending} change${pending === 1 ? '' : 's'} saved locally — cloud sync queued.`, pendingChanges: pending });
    }).catch(() => {});
    flushTimer = setTimeout(() => flushNow().catch(err => console.error(err)), SYNC_DEBOUNCE_MS);
  }

  async function pushState(queue, meta, attempt = 0) {
    const localFull = await idbGet(STORES.meta, 'state');
    const localDurable = stateForCloud(localFull || {});
    const baseState = await getStateBase();

    if (baseState && sameValue(localDurable, baseState)) {
      queue.stateDirty = false;
      return true;
    }

    const base = Number(meta.stateRevision || 0);
    const updated = nowIso();
    let data = null, error = null;
    if (base === 0) {
      ({ data, error } = await client.from(CONFIG.stateTable).insert({ user_id: currentUserId, state: localDurable, revision: 1, updated_at: updated, updated_by_device: deviceId() }).select().maybeSingle());
    } else {
      ({ data, error } = await client.from(CONFIG.stateTable).update({ state: localDurable, revision: base + 1, updated_at: updated, updated_by_device: deviceId() })
        .eq('user_id', currentUserId).eq('revision', base).select().maybeSingle());
    }
    if (error) {
      if (String(error.code) === '23505') data = null;
      else throw error;
    }
    if (!data) {
      const remote = await fetchRemoteState();
      if (!remote) {
        if (attempt >= 2) throw new Error('Cloud state changed repeatedly. Try Sync now again.');
        meta.stateRevision = 0;
        await setStateBase(null);
        return pushState(queue, meta, attempt + 1);
      }
      const result = await reconcileRemoteStateRow(remote, { notify: true });
      if (result === 'conflict') return false;
      const refreshedMeta = await getMeta();
      Object.assign(meta, refreshedMeta);
      const refreshedQueue = await getQueue();
      Object.assign(queue, refreshedQueue);
      if (!queue.stateDirty) return true;
      if (attempt >= 3) throw new Error('Cloud state changed repeatedly while merging. Try again.');
      return pushState(queue, meta, attempt + 1);
    }
    const syncedDurable = stateForCloud(data.state || localDurable);
    meta.stateRevision = Number(data.revision || base + 1);
    meta.stateHash = quickHash(syncedDurable);
    meta.lastSync = nowIso();
    queue.stateDirty = false;
    await setStateBase(syncedDurable);
    return true;
  }

  async function pushDocument(id, queue, meta) {
    const doc = await idbGet(STORES.documents, id);
    const base = Number(meta.docRevisions?.[id] || 0);
    const updated = nowIso();
    let data = null, error = null;
    if (base === 0) {
      ({ data, error } = await client.from(CONFIG.documentTable).insert({ user_id: currentUserId, document_id: id, document: doc || {}, revision: 1, updated_at: updated, updated_by_device: deviceId(), deleted_at: null }).select().maybeSingle());
    } else {
      ({ data, error } = await client.from(CONFIG.documentTable).update({ document: doc || {}, revision: base + 1, updated_at: updated, updated_by_device: deviceId(), deleted_at: null })
        .eq('user_id', currentUserId).eq('document_id', id).eq('revision', base).select().maybeSingle());
    }
    if (error) {
      if (String(error.code) === '23505') data = null;
      else throw error;
    }
    if (!data) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      if (remoteResult.data && !remoteResult.data.deleted_at && sameValue(doc || {}, remoteResult.data.document || {})) {
        meta.docRevisions ||= {};
        meta.docHashes ||= {};
        meta.docRevisions[id] = Number(remoteResult.data.revision || 0);
        meta.docHashes[id] = quickHash(remoteResult.data.document || {});
        queue.dirtyDocs = removeValue(queue.dirtyDocs, id);
        return true;
      }
      await createConflict({ kind: 'document', id, local: doc, localDeleting: false, remote: remoteResult.data });
      return false;
    }
    meta.docRevisions ||= {};
    meta.docHashes ||= {};
    meta.docRevisions[id] = Number(data.revision || base + 1);
    meta.docHashes[id] = quickHash(doc || {});
    meta.lastSync = nowIso();
    queue.dirtyDocs = removeValue(queue.dirtyDocs, id);
    return true;
  }

  async function deleteDocumentRemote(id, queue, meta) {
    const base = Number(meta.docRevisions?.[id] || 0);
    if (!base) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      if (!remoteResult.data || remoteResult.data.deleted_at) {
        queue.deletedDocs = removeValue(queue.deletedDocs, id);
        return true;
      }
      meta.docRevisions[id] = Number(remoteResult.data.revision || 0);
      return deleteDocumentRemote(id, queue, meta);
    }
    const { data, error } = await client.from(CONFIG.documentTable).update({ document: null, revision: base + 1, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: nowIso() })
      .eq('user_id', currentUserId).eq('document_id', id).eq('revision', base).select().maybeSingle();
    if (error) throw error;
    if (!data) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      if (!remoteResult.data || remoteResult.data.deleted_at) {
        meta.docRevisions[id] = Number(remoteResult.data?.revision || base);
        queue.deletedDocs = removeValue(queue.deletedDocs, id);
        return true;
      }
      await createConflict({ kind: 'document', id, local: null, localDeleting: true, remote: remoteResult.data });
      return false;
    }
    meta.docRevisions[id] = Number(data.revision || base + 1);
    meta.docHashes ||= {};
    meta.docHashes[id] = quickHash({ deleted: true });
    queue.deletedDocs = removeValue(queue.deletedDocs, id);
    return true;
  }

  function legacyPdfPathFromKey(key) {
    const id = String(key).replace(/^pdf:/, '');
    return `${currentUserId}/pdfs/${encodeURIComponent(id)}.pdf`;
  }
  function pdfFolderFromKey(key) {
    const id = String(key).replace(/^pdf:/, '');
    return `${currentUserId}/pdfs/${encodeURIComponent(id)}`;
  }
  async function blobSha256(blob) {
    const buffer = await blob.arrayBuffer();
    if (crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    const bytes = new Uint8Array(buffer);
    let hash = 2166136261;
    for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  async function uploadBlob(key, providedBlob = null) {
    if (!String(key).startsWith('pdf:')) return { changedDocument: false };
    const blob = providedBlob || await idbGet(STORES.blobs, key);
    if (!(blob instanceof Blob)) return { changedDocument: false };
    const id = String(key).replace(/^pdf:/, '');
    const hash = await blobSha256(blob);
    const path = `${pdfFolderFromKey(key)}/${hash}.pdf`;
    const { error } = await client.storage.from(CONFIG.bucket).upload(path, blob, {
      upsert: true,
      cacheControl: '3600',
      contentType: blob.type || 'application/pdf',
    });
    if (error) throw error;

    let changedDocument = false;
    const doc = await idbGet(STORES.documents, id);
    if (doc?.slides_attachment) {
      const previous = doc.slides_attachment.previous_cloud_object || doc.slides_attachment.cloud_object || null;
      if (previous !== path || doc.slides_attachment.cloud_blob_hash !== hash || doc.slides_attachment.previous_cloud_object) {
        doc.slides_attachment.cloud_object = path;
        doc.slides_attachment.cloud_blob_hash = hash;
        delete doc.slides_attachment.previous_cloud_object;
        await idbSet(STORES.documents, id, doc);
        changedDocument = true;
      }
      if (previous && previous !== path && previous.startsWith(`${currentUserId}/`)) {
        client.storage.from(CONFIG.bucket).remove([previous]).catch(() => {});
      }
    }
    return { changedDocument, documentId: id, path, hash };
  }
  async function deleteBlobRemote(key) {
    if (!String(key).startsWith('pdf:')) return;
    const folder = pdfFolderFromKey(key);
    try {
      const { data, error } = await client.storage.from(CONFIG.bucket).list(folder, { limit: 100 });
      if (error && !/not.?found|404/i.test(String(error.message || ''))) throw error;
      const paths = (data || []).filter(x => x?.name).map(x => `${folder}/${x.name}`);
      if (paths.length) {
        const { error: removeError } = await client.storage.from(CONFIG.bucket).remove(paths);
        if (removeError && !/not.?found|404/i.test(String(removeError.message || ''))) throw removeError;
      }
      const legacy = legacyPdfPathFromKey(key);
      const { error: legacyError } = await client.storage.from(CONFIG.bucket).remove([legacy]);
      if (legacyError && !/not.?found|404/i.test(String(legacyError.message || ''))) throw legacyError;
    } catch (err) {
      if (!/not.?found|404/i.test(String(err?.message || err))) throw err;
    }
  }

  async function flushNow() {
    clearTimeout(flushTimer);
    if (flushPromise) return flushPromise;
    if (!client || !currentUserId || !session || initialChoice || currentConflict) return false;
    const currentQueue = await getQueue();
    if (!navigator.onLine) {
      emitPendingStatus(currentQueue);
      return false;
    }
    if (!queueCount(currentQueue)) {
      const meta = await getMeta();
      emitStatus({ phase: 'synced', message: 'Cloud synced.', lastSync: meta.lastSync, pendingChanges: 0 });
      return true;
    }

    flushPromise = (async () => {
      emitStatus({ phase: 'syncing', message: 'Syncing changes…', pendingChanges: queueCount(currentQueue) });
      const queue = await getQueue();
      const meta = await getMeta();
      try {
        // Versioned PDF object first. Its exact cloud object name is then saved in the Lecture row.
        for (const key of [...queue.dirtyBlobs]) {
          const result = await uploadBlob(key);
          if (result.changedDocument && result.documentId) queue.dirtyDocs = unique([...queue.dirtyDocs, result.documentId]);
          queue.dirtyBlobs = removeValue(queue.dirtyBlobs, key);
          await setQueue(queue);
        }
        for (const id of [...queue.dirtyDocs]) {
          if (!(await pushDocument(String(id), queue, meta))) return false;
          await setMeta(meta); await setQueue(queue);
        }
        for (const id of [...queue.deletedDocs]) {
          if (!(await deleteDocumentRemote(String(id), queue, meta))) return false;
          await setMeta(meta); await setQueue(queue);
        }
        if (queue.stateDirty) {
          if (!(await pushState(queue, meta))) return false;
          await setMeta(meta); await setQueue(queue);
        }
        for (const key of [...queue.deletedBlobs]) {
          await deleteBlobRemote(key);
          queue.deletedBlobs = removeValue(queue.deletedBlobs, key);
          await setQueue(queue);
        }
        meta.lastSync = nowIso();
        await setMeta(meta);
        await setQueue(queue);
        emitStatus({ phase: 'synced', message: 'Cloud synced.', lastSync: meta.lastSync, conflict: false, pendingChanges: 0 });
        return true;
      } catch (err) {
        console.error('Cloud sync failed:', err);
        const q = await getQueue().catch(() => queue);
        emitStatus({
          phase: navigator.onLine ? 'error' : 'offline',
          message: navigator.onLine ? `Cloud sync failed: ${err.message || err}` : `Offline — ${queueCount(q)} change${queueCount(q) === 1 ? '' : 's'} waiting to sync.`,
          pendingChanges: queueCount(q),
        });
        return false;
      }
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  }

  async function ensurePdfBlob(materialId) {
    const key = `pdf:${materialId}`;
    const local = await idbGet(STORES.blobs, key);
    if (local instanceof Blob) return local;
    if (!client || !currentUserId || !session || !navigator.onLine) return null;
    try {
      const doc = await idbGet(STORES.documents, String(materialId));
      const objectPath = doc?.slides_attachment?.cloud_object || legacyPdfPathFromKey(key);
      const { data, error } = await client.storage.from(CONFIG.bucket).download(objectPath);
      if (error) throw error;
      if (data instanceof Blob) {
        await idbSet(STORES.blobs, key, data);
        return data;
      }
    } catch (err) {
      if (!/not.?found|404/i.test(String(err?.message || err))) console.warn('Could not download PDF:', err);
    }
    return null;
  }

  async function handleRealtimeState(payload) {
    const row = payload.new || payload.old;
    if (!row || row.updated_by_device === deviceId()) return;
    const result = await reconcileRemoteStateRow(row, { notify: true });
    if (result !== 'conflict') {
      const queue = await getQueue();
      if (queue.stateDirty) scheduleFlush();
      else emitStatus({ phase: 'synced', message: result === 'merged-pending' ? 'Merged another device; finishing sync…' : 'Updated from another device.', lastSync: nowIso(), pendingChanges: queueCount(queue) });
    }
  }
  async function handleRealtimeDocument(payload) {
    const row = payload.new || payload.old;
    const id = String(row?.document_id || '');
    if (!id || row.updated_by_device === deviceId()) return;
    const result = await reconcileRemoteDocumentRow(row, { notify: true });
    if (result !== 'conflict') {
      const queue = await getQueue();
      emitStatus({ phase: queueCount(queue) ? 'pending' : 'synced', message: queueCount(queue) ? 'Lecture merged; local changes still waiting to sync.' : 'Lecture updated from another device.', lastSync: nowIso(), pendingChanges: queueCount(queue) });
      if (queueCount(queue)) scheduleFlush();
    }
  }

  async function subscribeRealtime() {
    if (!client || !currentUserId) return;
    if (channel) { try { await client.removeChannel(channel); } catch (_err) {} channel = null; }
    const uid = currentUserId;
    channel = client.channel(`study-hub-${uid.slice(0, 8)}-${deviceId().slice(-6)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: CONFIG.stateTable, filter: `user_id=eq.${uid}` }, payload => {
        realtimeSerial = realtimeSerial.then(() => handleRealtimeState(payload)).catch(err => console.error('Realtime state sync failed:', err));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: CONFIG.documentTable, filter: `user_id=eq.${uid}` }, payload => {
        realtimeSerial = realtimeSerial.then(() => handleRealtimeDocument(payload)).catch(err => console.error('Realtime Lecture sync failed:', err));
      })
      .subscribe(subscriptionStatus => {
        if (subscriptionStatus === 'SUBSCRIBED' && !initialChoice && !currentConflict) {
          getQueue().then(q => {
            if (!queueCount(q)) emitStatus({ phase: 'synced', message: 'Cloud synced.', pendingChanges: 0 });
          }).catch(() => {});
        }
      });
  }

  async function chooseInitialSource(which) {
    if (!initialChoice) return false;
    if (which === 'cloud') await replaceLocalFromCloud(initialChoice.remoteState);
    else if (which === 'local') await replaceCloudFromLocal(initialChoice.remoteState);
    else return false;
    await subscribeRealtime();
    return true;
  }

  async function promoteLocalToCloud() {
    if (!currentUserId || !client || !session) throw new Error('Sign in first.');
    const remote = await fetchRemoteState();
    await replaceCloudFromLocal(remote);
    await subscribeRealtime();
    return true;
  }

  function bindConnectivity() {
    if (connectivityBound) return;
    connectivityBound = true;
    window.addEventListener('online', () => {
      emitStatus({ online: true, phase: currentUserId ? 'pending' : status.phase, message: currentUserId ? 'Internet restored — reconnecting cloud sync…' : status.message });
      if (!client || !initialized) {
        initialized = false;
        init().catch(err => console.error('Cloud reconnect failed:', err));
      } else if (currentUserId) {
        subscribeRealtime().catch(() => {});
        flushNow().catch(console.error);
      }
    });
    window.addEventListener('offline', () => {
      getQueue().then(q => emitStatus({
        online: false,
        phase: 'offline',
        pendingChanges: queueCount(q),
        message: queueCount(q) ? `Offline — ${queueCount(q)} change${queueCount(q) === 1 ? '' : 's'} waiting to sync.` : 'Offline — local data is safe. Cloud sync will resume automatically.',
      })).catch(() => emitStatus({ online: false, phase: 'offline', message: 'Offline — changes are saved locally and will sync later.' }));
    });
  }

  function bindAuthListener(c) {
    if (authListenerBound) return;
    authListenerBound = true;
    c.auth.onAuthStateChange((event, newSession) => {
      session = newSession || null;
      const user = newSession?.user || null;
      if (!user) {
        currentUserId = null;
        currentUserEmail = null;
        initialChoice = null;
        currentConflict = null;
        if (channel) { c.removeChannel(channel).catch(() => {}); channel = null; }
        emitStatus({ signedIn: false, phase: 'signed-out', message: 'Sign in to sync between devices.', needsChoice: false, conflict: false, pendingChanges: 0 });
      } else if (user.id !== currentUserId) {
        setTimeout(() => bootstrapUser(user).then(loadPersistedConflict).catch(err => {
          console.error(err); emitStatus({ phase: 'error', message: `Cloud connection failed: ${err.message || err}` });
        }), 0);
      }
    });
  }

  async function init() {
    bindConnectivity();
    if (initialized && client) return clone(status);
    initialized = true;
    const c = await ensureClient();
    if (!c) {
      initialized = false;
      return clone(status);
    }
    bindAuthListener(c);

    const { data, error } = await c.auth.getSession();
    if (error) console.warn(error);
    session = data?.session || null;
    if (session?.user) {
      await bootstrapUser(session.user);
      await loadPersistedConflict();
    } else {
      emitStatus({ signedIn: false, phase: 'signed-out', message: 'Sign in to sync between devices.' });
    }
    return clone(status);
  }

  async function signIn(email, password) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    bindAuthListener(c);
    const { data, error } = await c.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw error;
    session = data.session;
    await bootstrapUser(data.user);
    await loadPersistedConflict();
    return data;
  }
  async function signUp(email, password) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    bindAuthListener(c);
    const { data, error } = await c.auth.signUp({
      email: String(email || '').trim(),
      password: String(password || ''),
      options: { emailRedirectTo: AUTH_REDIRECT_URL },
    });
    if (error) throw error;
    if (data.session && data.user) {
      session = data.session;
      await bootstrapUser(data.user);
    }
    return data;
  }
  async function signOut() {
    if (client && currentUserId) await flushNow();
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw error;
    session = null; currentUserId = null; currentUserEmail = null; initialChoice = null; currentConflict = null;
    emitStatus({ signedIn: false, phase: 'signed-out', message: 'Signed out. Local data remains on this device.', needsChoice: false, conflict: false, pendingChanges: 0 });
  }
  async function resetPassword(email) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    const { error } = await c.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo: AUTH_REDIRECT_URL });
    if (error) throw error;
    return true;
  }

  async function getSyncDiagnostics() {
    const meta = currentUserId ? await getMeta() : blankMeta(null);
    const queue = await getQueue(currentUserId);
    return {
      deviceId: deviceId(),
      userId: currentUserId,
      stateRevision: Number(meta.stateRevision || 0),
      pendingChanges: queueCount(queue),
      queue: clone(queue),
      lastSync: meta.lastSync,
      online: navigator.onLine,
      conflict: clone(currentConflict),
    };
  }

  function getStatus() { return clone(status); }
  function getUser() { return session?.user ? { id: session.user.id, email: session.user.email || '' } : null; }
  function getInitialChoice() { return initialChoice ? { exists: true } : null; }
  function getConflict() {
    if (!currentConflict) return null;
    const out = clone(currentConflict);
    if (out.kind === 'state') out.conflictPaths = (out.conflictEntries || []).map(entry => pathLabel(entry.path)).filter(Boolean);
    return out;
  }
  function onStatus(fn) { listeners.add(fn); try { fn(clone(status)); } catch (_err) {} return () => listeners.delete(fn); }

  window.StudyHubCloud = Object.freeze({
    CONFIG,
    init,
    signIn,
    signUp,
    signOut,
    resetPassword,
    getStatus,
    getUser,
    getInitialChoice,
    chooseInitialSource,
    promoteLocalToCloud,
    getConflict,
    resolveConflict,
    onStatus,
    flushNow,
    markStateDirty,
    markDocumentDirty,
    markDocumentDeleted,
    markBlobDirty,
    markBlobDeleted,
    markEverythingDirty,
    ensurePdfBlob,
    getSyncDiagnostics,
    deviceId,
    __test: Object.freeze({
      stateForCloud,
      restoreLocalUi,
      mergeThreeWay: (base, local, remote) => {
        const result = mergeThreeWay(base, local, remote);
        return { value: result.value === MISSING ? undefined : result.value, conflicts: clone(result.conflicts) };
      },
      sameValue,
      quickHash,
      queueCount,
      applyPathChoice,
    }),
  });
})();
