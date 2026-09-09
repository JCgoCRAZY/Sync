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
  const SYNC_DEBOUNCE_MS = 900;

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
  let bootstrapPromise = null;
  let initialChoice = null;
  let currentConflict = null;

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
    Object.assign(status, patch, { online: navigator.onLine, email: currentUserEmail });
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
  function queueKey(userId = currentUserId) { return userId ? `cloud:queue:${userId}` : LOCAL_QUEUE_KEY; }
  function conflictKey(userId = currentUserId) { return `cloud:conflict:${userId || 'local'}`; }
  function blankMeta(userId) { return { userId, stateRevision: 0, docRevisions: {}, lastSync: null }; }
  function blankQueue() { return { stateDirty: false, dirtyDocs: [], deletedDocs: [], dirtyBlobs: [], deletedBlobs: [], updatedAt: null }; }

  async function getMeta(userId = currentUserId) {
    if (!userId) return blankMeta(null);
    return { ...blankMeta(userId), ...(await idbGet(STORES.meta, metaKey(userId)) || {}) };
  }
  async function setMeta(meta) {
    if (!meta?.userId) return;
    await idbSet(STORES.meta, metaKey(meta.userId), meta);
  }
  async function getQueue(userId = currentUserId) {
    return { ...blankQueue(), ...(await idbGet(STORES.meta, queueKey(userId)) || {}) };
  }
  async function setQueue(queue, userId = currentUserId) {
    queue.updatedAt = nowIso();
    await idbSet(STORES.meta, queueKey(userId), queue);
  }
  function unique(values) { return [...new Set(values.filter(Boolean).map(String))]; }
  function removeValue(values, value) { return values.filter(x => String(x) !== String(value)); }

  async function migrateLocalQueueToUser(userId) {
    const local = await getQueue(null);
    if (!local.stateDirty && !local.dirtyDocs.length && !local.deletedDocs.length && !local.dirtyBlobs.length && !local.deletedBlobs.length) return;
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

  function loadSupabaseLibrary() {
    if (window.supabase?.createClient) return Promise.resolve(window.supabase);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-studyhub-supabase]');
      const script = existing || document.createElement('script');
      const timer = setTimeout(() => reject(new Error('Supabase library timed out.')), 7000);
      const finish = () => { clearTimeout(timer); window.supabase?.createClient ? resolve(window.supabase) : reject(new Error('Supabase library did not initialize.')); };
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
        emitStatus({ available: false, phase: navigator.onLine ? 'local' : 'offline', message: navigator.onLine ? 'Cloud library unavailable — working locally.' : 'Offline — working locally. Cloud sync will reconnect later.' });
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

  async function applyRemoteStateRow(row, { notify = true } = {}) {
    if (!row?.state) return;
    await idbSet(STORES.meta, 'state', row.state);
    const meta = await getMeta();
    meta.stateRevision = Number(row.revision || 0);
    meta.lastSync = nowIso();
    await setMeta(meta);
    if (notify) emitRemote({ kind: 'state', revision: meta.stateRevision });
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
      if (oldAssigned !== newAssigned || (!row.document?.slides_attachment && before?.slides_attachment)) {
        await idbDelete(STORES.blobs, `pdf:${id}`);
      }
      await idbSet(STORES.documents, id, row.document);
    }
    const meta = await getMeta();
    meta.docRevisions ||= {};
    meta.docRevisions[id] = Number(row.revision || 0);
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
    for (const row of docs) {
      if (!row.deleted_at && row.document) await idbSet(STORES.documents, String(row.document_id), row.document);
      meta.docRevisions[String(row.document_id)] = Number(row.revision || 0);
    }
    meta.stateRevision = Number(remoteState.revision || 0);
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setQueue(blankQueue());
    initialChoice = null;
    emitStatus({ phase: 'synced', message: 'Cloud workspace downloaded.', lastSync: meta.lastSync, needsChoice: false });
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
    await setQueue(queue);
    await flushNow();
  }

  async function replaceCloudFromLocal(remoteState = null) {
    if (!currentUserId || !client) throw new Error('Sign in first.');
    emitStatus({ phase: 'syncing', message: 'Uploading this device to the cloud…', needsChoice: false });
    const localState = await idbGet(STORES.meta, 'state');
    const latest = remoteState || await fetchRemoteState();
    const nextRevision = Number(latest?.revision || 0) + 1;
    const payload = {
      user_id: currentUserId,
      state: localState || {},
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

    for (const [id, doc] of localDocs) {
      const old = remoteMap.get(String(id));
      const revision = Number(old?.revision || 0) + 1;
      const row = { user_id: currentUserId, document_id: String(id), document: doc, revision, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: null };
      const { data, error } = await client.from(CONFIG.documentTable).upsert(row, { onConflict: 'user_id,document_id' }).select().maybeSingle();
      if (error) throw error;
      docRevisions[String(id)] = Number(data?.revision || revision);
    }
    for (const [id, old] of remoteMap) {
      if (localDocs.has(id) || old.deleted_at) continue;
      const revision = Number(old.revision || 0) + 1;
      const { error } = await client.from(CONFIG.documentTable).update({ document: null, revision, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: nowIso() })
        .eq('user_id', currentUserId).eq('document_id', id).eq('revision', Number(old.revision || 0));
      if (error) throw error;
      docRevisions[id] = revision;
    }

    const blobs = await idbEntries(STORES.blobs);
    for (const [key, blob] of blobs) {
      if (String(key).startsWith('pdf:') && blob instanceof Blob) await uploadBlob(String(key), blob);
    }

    const meta = blankMeta(currentUserId);
    meta.stateRevision = Number(result.data.revision || nextRevision);
    meta.docRevisions = docRevisions;
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setQueue(blankQueue());
    initialChoice = null;
    emitStatus({ phase: 'synced', message: 'This device is now the cloud workspace.', lastSync: meta.lastSync, needsChoice: false });
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
      const firstUseForThisAccount = meta.userId !== currentUserId || Number(meta.stateRevision || 0) === 0;

      if (!remote) {
        await setMeta(blankMeta(currentUserId));
        await uploadLocalAsNewCloud();
      } else if (firstUseForThisAccount && localHasMeaningfulData(localState)) {
        initialChoice = { remoteState: remote };
        emitStatus({ phase: 'needs-choice', message: 'Cloud data and local data both exist. Choose which copy to use.', needsChoice: true });
      } else if (firstUseForThisAccount) {
        await setMeta(blankMeta(currentUserId));
        await replaceLocalFromCloud(remote);
      } else {
        if (Number(remote.revision || 0) > Number(meta.stateRevision || 0)) {
          const queue = await getQueue();
          if (queue.stateDirty) {
            await createConflict({ kind: 'state', local: localState, remote });
          } else {
            await applyRemoteStateRow(remote, { notify: false });
          }
        }
        await syncRemoteDocumentsSnapshot();
        await flushNow();
      }
      await subscribeRealtime();
      if (!currentConflict && !initialChoice) {
        const latestMeta = await getMeta();
        emitStatus({ phase: navigator.onLine ? 'synced' : 'offline', message: navigator.onLine ? 'Cloud synced.' : 'Offline — changes are saved locally.', lastSync: latestMeta.lastSync, needsChoice: false, conflict: false });
      }
    })().finally(() => { bootstrapPromise = null; });
    return bootstrapPromise;
  }

  async function syncRemoteDocumentsSnapshot() {
    if (!currentUserId || !client) return;
    const rows = await fetchRemoteDocuments();
    const meta = await getMeta();
    const queue = await getQueue();
    const dirty = new Set([...queue.dirtyDocs, ...queue.deletedDocs].map(String));
    for (const row of rows) {
      const id = String(row.document_id);
      const remoteRev = Number(row.revision || 0);
      const localRev = Number(meta.docRevisions?.[id] || 0);
      if (remoteRev <= localRev) continue;
      if (dirty.has(id)) {
        const local = await idbGet(STORES.documents, id);
        await createConflict({ kind: 'document', id, local, remote: row });
        break;
      }
      await applyRemoteDocumentRow(row, { notify: false });
    }
  }

  async function createConflict(conflict) {
    currentConflict = { ...conflict, createdAt: nowIso() };
    await idbSet(STORES.meta, conflictKey(), currentConflict);
    emitStatus({ phase: 'conflict', message: 'A sync conflict needs your choice before cloud saving can continue.', conflict: true });
    window.dispatchEvent(new CustomEvent('studyhub-cloud-conflict', { detail: clone(currentConflict) }));
  }

  async function loadPersistedConflict() {
    if (!currentUserId) return;
    currentConflict = await idbGet(STORES.meta, conflictKey()) || null;
    if (currentConflict) emitStatus({ phase: 'conflict', message: 'A sync conflict needs your choice.', conflict: true });
  }

  async function resolveConflict(strategy) {
    if (!currentConflict || !currentUserId || !client) return false;
    const conflict = currentConflict;
    if (strategy === 'cloud') {
      if (conflict.kind === 'state') {
        await applyRemoteStateRow(conflict.remote);
        const q = await getQueue(); q.stateDirty = false; await setQueue(q);
      } else if (conflict.kind === 'document') {
        await applyRemoteDocumentRow(conflict.remote);
        const q = await getQueue();
        q.dirtyDocs = removeValue(q.dirtyDocs, conflict.id);
        q.deletedDocs = removeValue(q.deletedDocs, conflict.id);
        await setQueue(q);
      }
    } else if (strategy === 'local') {
      if (conflict.kind === 'state') {
        const local = await idbGet(STORES.meta, 'state');
        const remote = await fetchRemoteState();
        if (!remote) throw new Error('Cloud state disappeared.');
        const revision = Number(remote.revision || 0) + 1;
        const { data, error } = await client.from(CONFIG.stateTable).update({ state: local || {}, revision, updated_at: nowIso(), updated_by_device: deviceId() })
          .eq('user_id', currentUserId).eq('revision', Number(remote.revision || 0)).select().maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Cloud state changed again. Try resolving once more.');
        const meta = await getMeta(); meta.stateRevision = revision; meta.lastSync = nowIso(); await setMeta(meta);
        const q = await getQueue(); q.stateDirty = false; await setQueue(q);
      } else if (conflict.kind === 'document') {
        const remote = (await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', conflict.id).maybeSingle());
        if (remote.error) throw remote.error;
        const base = Number(remote.data?.revision || 0);
        const local = await idbGet(STORES.documents, conflict.id);
        const q = await getQueue();
        const deleting = q.deletedDocs.includes(String(conflict.id));
        const row = { document: deleting ? null : local, revision: base + 1, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: deleting ? nowIso() : null };
        let data = null, error = null;
        if (remote.data) {
          ({ data, error } = await client.from(CONFIG.documentTable).update(row)
            .eq('user_id', currentUserId).eq('document_id', String(conflict.id)).eq('revision', base).select().maybeSingle());
        } else {
          ({ data, error } = await client.from(CONFIG.documentTable).insert({ user_id: currentUserId, document_id: String(conflict.id), ...row }).select().maybeSingle());
        }
        if (error) throw error;
        if (!data) throw new Error('Cloud Lecture changed again. Try resolving once more.');
        const meta = await getMeta(); meta.docRevisions ||= {}; meta.docRevisions[String(conflict.id)] = Number(data.revision || base + 1); meta.lastSync = nowIso(); await setMeta(meta);
        q.dirtyDocs = removeValue(q.dirtyDocs, conflict.id); q.deletedDocs = removeValue(q.deletedDocs, conflict.id); await setQueue(q);
      }
    } else {
      return false;
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
    await setQueue(q);
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
    if (!currentUserId || !navigator.onLine || initialChoice || currentConflict) {
      if (!navigator.onLine) emitStatus({ phase: 'offline', message: 'Offline — changes are saved locally and queued for cloud sync.' });
      return;
    }
    emitStatus({ phase: 'pending', message: 'Saved locally — cloud sync queued.' });
    flushTimer = setTimeout(() => flushNow().catch(err => console.error(err)), SYNC_DEBOUNCE_MS);
  }

  async function pushState(queue, meta) {
    const localState = await idbGet(STORES.meta, 'state');
    const base = Number(meta.stateRevision || 0);
    const updated = nowIso();
    let data = null, error = null;
    if (base === 0) {
      ({ data, error } = await client.from(CONFIG.stateTable).insert({ user_id: currentUserId, state: localState || {}, revision: 1, updated_at: updated, updated_by_device: deviceId() }).select().maybeSingle());
    } else {
      ({ data, error } = await client.from(CONFIG.stateTable).update({ state: localState || {}, revision: base + 1, updated_at: updated, updated_by_device: deviceId() })
        .eq('user_id', currentUserId).eq('revision', base).select().maybeSingle());
    }
    if (error) {
      if (String(error.code) === '23505') data = null;
      else throw error;
    }
    if (!data) {
      const remote = await fetchRemoteState();
      await createConflict({ kind: 'state', local: localState, remote });
      return false;
    }
    meta.stateRevision = Number(data.revision || base + 1);
    meta.lastSync = nowIso();
    queue.stateDirty = false;
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
      await createConflict({ kind: 'document', id, local: doc, remote: remoteResult.data });
      return false;
    }
    meta.docRevisions ||= {};
    meta.docRevisions[id] = Number(data.revision || base + 1);
    meta.lastSync = nowIso();
    queue.dirtyDocs = removeValue(queue.dirtyDocs, id);
    return true;
  }

  async function deleteDocumentRemote(id, queue, meta) {
    const base = Number(meta.docRevisions?.[id] || 0);
    if (!base) {
      queue.deletedDocs = removeValue(queue.deletedDocs, id);
      return true;
    }
    const { data, error } = await client.from(CONFIG.documentTable).update({ document: null, revision: base + 1, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: nowIso() })
      .eq('user_id', currentUserId).eq('document_id', id).eq('revision', base).select().maybeSingle();
    if (error) throw error;
    if (!data) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      await createConflict({ kind: 'document', id, local: null, remote: remoteResult.data });
      return false;
    }
    meta.docRevisions[id] = Number(data.revision || base + 1);
    queue.deletedDocs = removeValue(queue.deletedDocs, id);
    return true;
  }

  function pdfPathFromKey(key) {
    const id = String(key).replace(/^pdf:/, '');
    return `${currentUserId}/pdfs/${encodeURIComponent(id)}.pdf`;
  }
  async function uploadBlob(key, providedBlob = null) {
    if (!String(key).startsWith('pdf:')) return;
    const blob = providedBlob || await idbGet(STORES.blobs, key);
    if (!(blob instanceof Blob)) return;
    const { error } = await client.storage.from(CONFIG.bucket).upload(pdfPathFromKey(key), blob, {
      upsert: true,
      cacheControl: '3600',
      contentType: blob.type || 'application/pdf',
    });
    if (error) throw error;
  }
  async function deleteBlobRemote(key) {
    if (!String(key).startsWith('pdf:')) return;
    const { error } = await client.storage.from(CONFIG.bucket).remove([pdfPathFromKey(key)]);
    if (error && !/not.?found/i.test(String(error.message || ''))) throw error;
  }

  async function flushNow() {
    clearTimeout(flushTimer);
    if (flushPromise) return flushPromise;
    if (!client || !currentUserId || !session || initialChoice || currentConflict) return false;
    if (!navigator.onLine) {
      emitStatus({ phase: 'offline', message: 'Offline — changes are saved locally and queued for cloud sync.' });
      return false;
    }
    flushPromise = (async () => {
      emitStatus({ phase: 'syncing', message: 'Syncing changes…' });
      const queue = await getQueue();
      const meta = await getMeta();
      try {
        // Files first so a remotely received document never points at a PDF that has not uploaded yet.
        for (const key of [...queue.dirtyBlobs]) {
          await uploadBlob(key);
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
        emitStatus({ phase: 'synced', message: 'Cloud synced.', lastSync: meta.lastSync, conflict: false });
        return true;
      } catch (err) {
        console.error('Cloud sync failed:', err);
        emitStatus({ phase: navigator.onLine ? 'error' : 'offline', message: navigator.onLine ? `Cloud sync failed: ${err.message || err}` : 'Offline — changes are queued.' });
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
      const { data, error } = await client.storage.from(CONFIG.bucket).download(pdfPathFromKey(key));
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

  async function subscribeRealtime() {
    if (!client || !currentUserId) return;
    if (channel) { try { await client.removeChannel(channel); } catch (_err) {} channel = null; }
    const uid = currentUserId;
    channel = client.channel(`study-hub-${uid.slice(0, 8)}-${deviceId().slice(-6)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: CONFIG.stateTable, filter: `user_id=eq.${uid}` }, async payload => {
        const row = payload.new || payload.old;
        if (!row || row.updated_by_device === deviceId()) return;
        const q = await getQueue();
        if (q.stateDirty) return createConflict({ kind: 'state', local: await idbGet(STORES.meta, 'state'), remote: row });
        await applyRemoteStateRow(row);
        emitStatus({ phase: 'synced', message: 'Updated from another device.', lastSync: nowIso() });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: CONFIG.documentTable, filter: `user_id=eq.${uid}` }, async payload => {
        const row = payload.new || payload.old;
        const id = String(row?.document_id || '');
        if (!id || row.updated_by_device === deviceId()) return;
        const q = await getQueue();
        if (q.dirtyDocs.includes(id) || q.deletedDocs.includes(id)) return createConflict({ kind: 'document', id, local: await idbGet(STORES.documents, id), remote: row });
        await applyRemoteDocumentRow(row);
        emitStatus({ phase: 'synced', message: 'Lecture updated from another device.', lastSync: nowIso() });
      })
      .subscribe(subscriptionStatus => {
        if (subscriptionStatus === 'SUBSCRIBED' && !initialChoice && !currentConflict) emitStatus({ phase: 'synced', message: 'Cloud synced.' });
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

  async function init() {
    if (initialized) return clone(status);
    initialized = true;
    const c = await ensureClient();
    if (!c) return clone(status);

    c.auth.onAuthStateChange((event, newSession) => {
      session = newSession || null;
      const user = newSession?.user || null;
      if (!user) {
        currentUserId = null;
        currentUserEmail = null;
        if (channel) { c.removeChannel(channel).catch(() => {}); channel = null; }
        emitStatus({ signedIn: false, phase: 'signed-out', message: 'Sign in to sync between devices.', needsChoice: false, conflict: false });
      } else if (user.id !== currentUserId) {
        setTimeout(() => bootstrapUser(user).then(loadPersistedConflict).catch(err => {
          console.error(err); emitStatus({ phase: 'error', message: `Cloud connection failed: ${err.message || err}` });
        }), 0);
      }
    });

    const { data, error } = await c.auth.getSession();
    if (error) console.warn(error);
    session = data?.session || null;
    if (session?.user) {
      await bootstrapUser(session.user);
      await loadPersistedConflict();
    } else {
      emitStatus({ signedIn: false, phase: 'signed-out', message: 'Sign in to sync between devices.' });
    }

    window.addEventListener('online', () => {
      emitStatus({ online: true, phase: currentUserId ? 'pending' : status.phase, message: currentUserId ? 'Internet restored — syncing…' : status.message });
      if (currentUserId) flushNow().catch(console.error);
    });
    window.addEventListener('offline', () => emitStatus({ online: false, phase: 'offline', message: 'Offline — changes are saved locally and will sync later.' }));
    return clone(status);
  }

  async function signIn(email, password) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    const { data, error } = await c.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw error;
    session = data.session; await bootstrapUser(data.user); await loadPersistedConflict(); return data;
  }
  async function signUp(email, password) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    const { data, error } = await c.auth.signUp({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw error;
    if (data.session && data.user) { session = data.session; await bootstrapUser(data.user); }
    return data;
  }
  async function signOut() {
    if (client) await flushNow();
    const { error } = await client.auth.signOut();
    if (error) throw error;
    session = null; currentUserId = null; currentUserEmail = null; initialChoice = null; currentConflict = null;
    emitStatus({ signedIn: false, phase: 'signed-out', message: 'Signed out. Local data remains on this device.', needsChoice: false, conflict: false });
  }
  async function resetPassword(email) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    const redirectTo = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
    const { error } = await c.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo });
    if (error) throw error;
    return true;
  }

  function getStatus() { return clone(status); }
  function getUser() { return session?.user ? { id: session.user.id, email: session.user.email || '' } : null; }
  function getInitialChoice() { return initialChoice ? { exists: true } : null; }
  function getConflict() { return clone(currentConflict); }
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
    deviceId,
  });
})();
