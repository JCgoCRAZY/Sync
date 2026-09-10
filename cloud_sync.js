(() => {
  'use strict';

  const CONFIG = Object.freeze({
    projectUrl: 'https://pvjsxskkwnjpwukrilos.supabase.co',
    publishableKey: 'sb_publishable_sKdJQWOKviE3b2JWNDHSHA_38ez9kdC',
    stateTable: 'app_state',
    documentTable: 'app_documents',
    entityTable: 'app_entities',
    historyTable: 'app_history',
    bucket: 'user-files',
  });

  const DB_NAME = 'university-study-hub';
  const DB_VERSION = 1;
  const STORES = { meta: 'meta', documents: 'documents', blobs: 'blobs' };
  const LOCAL_QUEUE_KEY = 'cloud:queue:local';
  const DEVICE_KEY = 'ushub-cloud-device-id';
  const SYNC_SCHEMA_VERSION = 4;
  const SYNC_DEBOUNCE_MS = 450;
  const RETRY_BASE_MS = 1500;
  const RETRY_MAX_MS = 60000;
  const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
  const MAX_LOCAL_HISTORY = 10;
  const SAVE_LOG_LIMIT = 200;
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
  let queueMutationSerial = Promise.resolve();
  let connectivityBound = false;
  let retryTimer = null;
  let watchdogTimer = null;
  let checkpointTimer = null;

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
    lastLocalSaveAt: null,
    lastLocalSaveId: null,
    lastCloudConfirmedAt: null,
    lastCloudConfirmedSaveId: null,
    lastError: null,
    retryAt: null,
    syncMode: 'granular-v2',
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

  function newSaveId(kind = 'save', target = '') {
    const body = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(16).slice(2)}`;
    const safeKind = String(kind).replace(/[^a-z0-9_-]/gi, '').slice(0, 18) || 'save';
    const safeTarget = String(target).replace(/[^a-z0-9_-]/gi, '').slice(-18);
    return `${safeKind}_${safeTarget ? `${safeTarget}_` : ''}${body.slice(0, 20)}`;
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
  function entityBaseKey(userId) { return `cloud:base-entities:${userId}`; }
  function saveLogKey(userId = currentUserId) { return `cloud:save-log:${userId || 'local'}`; }
  function queueKey(userId = currentUserId) { return userId ? `cloud:queue:${userId}` : LOCAL_QUEUE_KEY; }
  function conflictKey(userId = currentUserId) { return `cloud:conflict:${userId || 'local'}`; }
  function lectureRecoveryKey(id) { return `lecture-recovery:${String(id)}`; }
  function lectureHistoryKey(id) { return `lecture-history:${String(id)}`; }
  function blankMeta(userId) {
    return {
      userId,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      stateRevision: 0,
      stateHash: '',
      entityRevisions: {},
      entityHashes: {},
      docRevisions: {},
      docHashes: {},
      lastSync: null,
      lastLocalSaveAt: null,
      lastLocalSaveId: null,
      lastCloudConfirmedAt: null,
      lastCloudConfirmedSaveId: null,
      lastCheckpointAt: null,
    };
  }
  function blankQueue() {
    return {
      // stateDirty is now reserved for an occasional full-workspace checkpoint.
      // Everyday app changes use dirtyEntities/deletedEntities instead.
      stateDirty: false,
      dirtyEntities: [],
      deletedEntities: [],
      dirtyDocs: [],
      deletedDocs: [],
      dirtyBlobs: [],
      deletedBlobs: [],
      saveIds: {
        state: null,
        entities: {},
        deletedEntities: {},
        docs: {},
        deletedDocs: {},
        blobs: {},
        deletedBlobs: {},
      },
      retry: {},
      updatedAt: null,
    };
  }
  function unique(values) { return [...new Set((values || []).filter(Boolean).map(String))]; }
  function removeValue(values, value) { return (values || []).filter(x => String(x) !== String(value)); }
  function queueCount(queue) {
    if (!queue) return 0;
    return Number(Boolean(queue.stateDirty))
      + unique(queue.dirtyEntities).length
      + unique(queue.deletedEntities).length
      + unique(queue.dirtyDocs).length
      + unique(queue.deletedDocs).length
      + unique(queue.dirtyBlobs).length
      + unique(queue.deletedBlobs).length;
  }

  async function getMeta(userId = currentUserId) {
    if (!userId) return blankMeta(null);
    const raw = await idbGet(STORES.meta, metaKey(userId));
    const sameSchema = Number(raw?.syncSchemaVersion || 0) === SYNC_SCHEMA_VERSION;
    return {
      ...blankMeta(userId),
      ...(raw || {}),
      userId,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      entityRevisions: { ...(raw?.entityRevisions || {}) },
      entityHashes: sameSchema ? { ...(raw?.entityHashes || {}) } : {},
      docRevisions: { ...(raw?.docRevisions || {}) },
      // v4 hashes intentionally exclude device-local editor_layout. Do not compare
      // them against older full-document hashes.
      docHashes: sameSchema ? { ...(raw?.docHashes || {}) } : {},
    };
  }
  async function setMeta(meta) {
    if (!meta?.userId) return;
    // Save-confirmation timestamps are written from several async paths (PDF,
    // entity, document and checkpoint uploads). Never let an older in-memory
    // meta object erase a newer confirmation that already reached IndexedDB.
    const existing = await idbGet(STORES.meta, metaKey(meta.userId));
    const merged = { ...meta, syncSchemaVersion: SYNC_SCHEMA_VERSION };
    const preserveNewerTimestamp = (timeField, idField) => {
      const oldAt = existing?.[timeField] || null;
      const newAt = merged?.[timeField] || null;
      if (oldAt && (!newAt || Date.parse(oldAt) > Date.parse(newAt))) {
        merged[timeField] = oldAt;
        if (idField) merged[idField] = existing?.[idField] || merged?.[idField] || null;
      }
    };
    preserveNewerTimestamp('lastLocalSaveAt', 'lastLocalSaveId');
    preserveNewerTimestamp('lastCloudConfirmedAt', 'lastCloudConfirmedSaveId');
    preserveNewerTimestamp('lastSync', null);
    Object.assign(meta, merged);
    await idbSet(STORES.meta, metaKey(meta.userId), merged);
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

  async function getEntityBase(userId = currentUserId) {
    if (!userId) return {};
    return await idbGet(STORES.meta, entityBaseKey(userId)) || {};
  }
  async function setEntityBase(value, userId = currentUserId) {
    if (!userId) return;
    await idbSet(STORES.meta, entityBaseKey(userId), clone(value || {}));
  }
  async function getSaveLog(userId = currentUserId) {
    return await idbGet(STORES.meta, saveLogKey(userId)) || [];
  }
  async function setSaveLog(entries, userId = currentUserId) {
    await idbSet(STORES.meta, saveLogKey(userId), (entries || []).slice(-SAVE_LOG_LIMIT));
  }
  async function recordSaveLog(entry, userId = currentUserId) {
    const log = await getSaveLog(userId);
    const idx = log.findIndex(x => x.saveId === entry.saveId);
    const next = { ...(idx >= 0 ? log[idx] : {}), ...clone(entry) };
    if (idx >= 0) log.splice(idx, 1);
    log.push(next);
    await setSaveLog(log, userId);
    return next;
  }
  async function recordLocalSave(saveId, kind, targetId, contentHash = '') {
    const at = nowIso();
    await recordSaveLog({ saveId, kind, targetId: String(targetId || ''), contentHash, status: 'local', localSavedAt: at, deviceId: deviceId() });
    if (currentUserId) {
      const meta = await getMeta();
      meta.lastLocalSaveAt = at;
      meta.lastLocalSaveId = saveId;
      await setMeta(meta);
    }
    emitStatus({ lastLocalSaveAt: at, lastLocalSaveId: saveId });
    return at;
  }
  async function recordCloudConfirmation(saveId, kind, targetId, revision = null) {
    const at = nowIso();
    await recordSaveLog({ saveId, kind, targetId: String(targetId || ''), status: 'confirmed', cloudConfirmedAt: at, revision, deviceId: deviceId() });
    if (currentUserId) {
      const meta = await getMeta();
      meta.lastCloudConfirmedAt = at;
      meta.lastCloudConfirmedSaveId = saveId;
      meta.lastSync = at;
      await setMeta(meta);
    }
    emitStatus({ lastCloudConfirmedAt: at, lastCloudConfirmedSaveId: saveId, lastSync: at, lastError: null, retryAt: null });
    return at;
  }
  async function recordSaveFailure(saveId, error, attempts = 1, nextRetryAt = null) {
    if (saveId) await recordSaveLog({ saveId, status: 'retrying', lastError: String(error?.message || error || ''), attempts, nextRetryAt });
    emitStatus({ lastError: String(error?.message || error || ''), retryAt: nextRetryAt });
  }
  async function getQueue(userId = currentUserId) {
    const raw = await idbGet(STORES.meta, queueKey(userId));
    const defaults = blankQueue();
    return {
      ...defaults,
      ...(raw || {}),
      dirtyEntities: unique(raw?.dirtyEntities || []),
      deletedEntities: unique(raw?.deletedEntities || []),
      dirtyDocs: unique(raw?.dirtyDocs || []),
      deletedDocs: unique(raw?.deletedDocs || []),
      dirtyBlobs: unique(raw?.dirtyBlobs || []),
      deletedBlobs: unique(raw?.deletedBlobs || []),
      saveIds: {
        ...defaults.saveIds,
        ...(raw?.saveIds || {}),
        entities: { ...(raw?.saveIds?.entities || {}) },
        deletedEntities: { ...(raw?.saveIds?.deletedEntities || {}) },
        docs: { ...(raw?.saveIds?.docs || {}) },
        deletedDocs: { ...(raw?.saveIds?.deletedDocs || {}) },
        blobs: { ...(raw?.saveIds?.blobs || {}) },
        deletedBlobs: { ...(raw?.saveIds?.deletedBlobs || {}) },
      },
      retry: { ...(raw?.retry || {}) },
    };
  }
  async function setQueue(queue, userId = currentUserId, { emit = false } = {}) {
    queue.dirtyEntities = unique(queue.dirtyEntities);
    queue.deletedEntities = unique(queue.deletedEntities);
    queue.dirtyDocs = unique(queue.dirtyDocs);
    queue.deletedDocs = unique(queue.deletedDocs);
    queue.dirtyBlobs = unique(queue.dirtyBlobs);
    queue.deletedBlobs = unique(queue.deletedBlobs);
    queue.saveIds ||= blankQueue().saveIds;
    queue.retry ||= {};
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
    target.dirtyEntities = unique([...target.dirtyEntities, ...local.dirtyEntities]);
    target.deletedEntities = unique([...target.deletedEntities, ...local.deletedEntities]);
    target.dirtyDocs = unique([...target.dirtyDocs, ...local.dirtyDocs]);
    target.deletedDocs = unique([...target.deletedDocs, ...local.deletedDocs]);
    target.dirtyBlobs = unique([...target.dirtyBlobs, ...local.dirtyBlobs]);
    target.deletedBlobs = unique([...target.deletedBlobs, ...local.deletedBlobs]);
    target.saveIds = {
      ...target.saveIds,
      state: local.saveIds?.state || target.saveIds?.state || null,
      entities: { ...(target.saveIds?.entities || {}), ...(local.saveIds?.entities || {}) },
      deletedEntities: { ...(target.saveIds?.deletedEntities || {}), ...(local.saveIds?.deletedEntities || {}) },
      docs: { ...(target.saveIds?.docs || {}), ...(local.saveIds?.docs || {}) },
      deletedDocs: { ...(target.saveIds?.deletedDocs || {}), ...(local.saveIds?.deletedDocs || {}) },
      blobs: { ...(target.saveIds?.blobs || {}), ...(local.saveIds?.blobs || {}) },
      deletedBlobs: { ...(target.saveIds?.deletedBlobs || {}), ...(local.saveIds?.deletedBlobs || {}) },
    };
    target.retry = { ...(target.retry || {}), ...(local.retry || {}) };
    await setQueue(target, userId);
    const localLog = await getSaveLog(null);
    if (localLog.length) {
      const userLog = await getSaveLog(userId);
      await setSaveLog([...userLog, ...localLog].slice(-SAVE_LOG_LIMIT), userId);
      await idbDelete(STORES.meta, saveLogKey(null));
    }
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
      for (const course of Object.values(profile.courses || {})) {
        delete course.ui_state;
        // Which Lecture a device opened most recently is local navigation state,
        // not shared academic data. Exclude it so a later real course edit does
        // not accidentally ship stale per-device navigation metadata.
        for (const material of course.materials || []) delete material.last_opened_at;
      }
    }
    return out;
  }

  function documentForCloud(document) {
    const out = clone(document || {});
    // Split ratio, slide visibility and scroll positions are device-local UI state.
    // Excluding them keeps note-taking changes from generating cloud traffic/conflicts
    // every time the user scrolls or resizes the editor.
    delete out.editor_layout;
    return out;
  }

  function restoreLocalDocumentUi(remoteDocument, localDocument) {
    const out = clone(remoteDocument || {});
    if (localDocument?.editor_layout) out.editor_layout = clone(localDocument.editor_layout);
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
        // Preserve per-device Lecture-open timestamps that are intentionally
        // excluded from cloud payloads.
        const localOpened = new Map((localCourse?.materials || []).map(m => [String(m.id), m.last_opened_at]));
        for (const material of course.materials || []) {
          const opened = localOpened.get(String(material.id));
          if (opened) material.last_opened_at = opened;
        }
      }
    }
    return out;
  }

  function entityKeyWorkspace() { return 'workspace'; }
  function entityKeyProfile(profileId) { return `profile:${String(profileId)}`; }
  function entityKeySchedule(profileId) { return `schedule:${String(profileId)}`; }
  function entityKeyNotes(profileId) { return `notes:${String(profileId)}`; }
  function entityKeyCourse(profileId, courseId) { return `course:${String(profileId)}:${String(courseId)}`; }

  function stateToEntities(fullState) {
    const durable = stateForCloud(fullState || {});
    const out = {};
    out[entityKeyWorkspace()] = {
      entityType: 'workspace',
      payload: {
        schema_version: durable.schema_version || 2,
        app: clone(durable.app || {}),
      },
    };
    for (const [profileId, profile] of Object.entries(durable.profiles || {})) {
      const profilePayload = clone(profile || {});
      delete profilePayload.courses;
      delete profilePayload.schedule;
      delete profilePayload.personal_notes;
      delete profilePayload.ui_state;
      out[entityKeyProfile(profileId)] = { entityType: 'profile', payload: profilePayload };
      out[entityKeySchedule(profileId)] = { entityType: 'schedule', payload: clone(profile?.schedule || {}) };
      out[entityKeyNotes(profileId)] = { entityType: 'notes', payload: clone(profile?.personal_notes || []) };
      for (const [courseId, course] of Object.entries(profile?.courses || {})) {
        const coursePayload = clone(course || {});
        delete coursePayload.ui_state;
        out[entityKeyCourse(profileId, courseId)] = { entityType: 'course', payload: coursePayload };
      }
    }
    return out;
  }

  function activeEntitySnapshotFromRows(rows) {
    const out = {};
    for (const row of rows || []) {
      if (!row?.entity_key || row.deleted_at || row.payload == null) continue;
      out[String(row.entity_key)] = { entityType: row.entity_type || 'unknown', payload: clone(row.payload) };
    }
    return out;
  }

  function ensureProfileShell(state, profileId) {
    state.profiles ||= {};
    if (!state.profiles[profileId]) {
      state.profiles[profileId] = {
        id: profileId,
        display_name: 'Profile',
        course_order: [],
        courses: {},
        personal_notes: [],
        schedule: { course_meetings: {}, personal_events: [] },
      };
    }
    const profile = state.profiles[profileId];
    profile.courses ||= {};
    profile.course_order ||= [];
    profile.personal_notes ||= [];
    profile.schedule ||= { course_meetings: {}, personal_events: [] };
    return profile;
  }

  function stateFromEntitySnapshot(snapshot, localFull = null) {
    const workspace = snapshot?.[entityKeyWorkspace()]?.payload || {};
    const durable = {
      schema_version: workspace.schema_version || 2,
      app: clone(workspace.app || {}),
      profiles: {},
    };
    for (const [key, entry] of Object.entries(snapshot || {})) {
      const parts = String(key).split(':');
      const kind = parts[0];
      if (kind === 'profile' && parts[1]) {
        const profileId = parts.slice(1).join(':');
        durable.profiles[profileId] = {
          ...clone(entry.payload || {}),
          id: entry.payload?.id || profileId,
          courses: {},
          personal_notes: [],
          schedule: { course_meetings: {}, personal_events: [] },
        };
      }
    }
    for (const [key, entry] of Object.entries(snapshot || {})) {
      const parts = String(key).split(':');
      const kind = parts[0];
      if (kind === 'schedule' && parts[1]) {
        const profileId = parts.slice(1).join(':');
        ensureProfileShell(durable, profileId).schedule = clone(entry.payload || {});
      } else if (kind === 'notes' && parts[1]) {
        const profileId = parts.slice(1).join(':');
        ensureProfileShell(durable, profileId).personal_notes = clone(entry.payload || []);
      } else if (kind === 'course' && parts.length >= 3) {
        const profileId = parts[1];
        const courseId = parts.slice(2).join(':');
        const profile = ensureProfileShell(durable, profileId);
        profile.courses[courseId] = clone(entry.payload || {});
        profile.courses[courseId].id ||= courseId;
        if (!profile.course_order.includes(courseId)) profile.course_order.push(courseId);
      }
    }
    for (const profile of Object.values(durable.profiles || {})) {
      profile.course_order = (profile.course_order || []).filter(id => profile.courses?.[id]);
      for (const id of Object.keys(profile.courses || {})) if (!profile.course_order.includes(id)) profile.course_order.push(id);
    }
    return restoreLocalUi(durable, localFull || {});
  }

  function applyEntityRowToState(fullState, row) {
    const state = clone(fullState || {});
    state.profiles ||= {};
    const key = String(row?.entity_key || '');
    const parts = key.split(':');
    const kind = parts[0];
    const deleted = Boolean(row?.deleted_at || row?.payload == null);
    if (kind === 'workspace') {
      if (!deleted) {
        const payload = row.payload || {};
        state.schema_version = payload.schema_version || state.schema_version || 2;
        state.app = { ...(state.app || {}), ...clone(payload.app || {}) };
      }
      return state;
    }
    if (kind === 'profile' && parts[1]) {
      const profileId = parts.slice(1).join(':');
      if (deleted) {
        delete state.profiles[profileId];
        if (state.active_profile_id === profileId) state.active_profile_id = Object.keys(state.profiles)[0] || null;
      } else {
        const existing = state.profiles[profileId] || {};
        state.profiles[profileId] = {
          ...clone(row.payload || {}),
          id: row.payload?.id || profileId,
          courses: existing.courses || {},
          personal_notes: existing.personal_notes || [],
          schedule: existing.schedule || { course_meetings: {}, personal_events: [] },
          ...(existing.ui_state ? { ui_state: existing.ui_state } : {}),
        };
      }
      return state;
    }
    if (kind === 'schedule' && parts[1]) {
      const profileId = parts.slice(1).join(':');
      if (!deleted) {
        const profile = ensureProfileShell(state, profileId);
        const localWeek = profile.schedule?.calendar_week;
        const localView = profile.schedule?._web_view;
        profile.schedule = clone(row.payload || {});
        if (localWeek) profile.schedule.calendar_week = localWeek;
        if (localView) profile.schedule._web_view = localView;
      }
      return state;
    }
    if (kind === 'notes' && parts[1]) {
      const profileId = parts.slice(1).join(':');
      const profile = ensureProfileShell(state, profileId);
      profile.personal_notes = deleted ? [] : clone(row.payload || []);
      return state;
    }
    if (kind === 'course' && parts.length >= 3) {
      const profileId = parts[1];
      const courseId = parts.slice(2).join(':');
      const profile = ensureProfileShell(state, profileId);
      if (deleted) {
        delete profile.courses[courseId];
        profile.course_order = (profile.course_order || []).filter(id => id !== courseId);
        if (profile.schedule?.course_meetings) delete profile.schedule.course_meetings[courseId];
      } else {
        const localCourse = profile.courses?.[courseId] || null;
        const localUi = localCourse?.ui_state;
        const localOpened = new Map((localCourse?.materials || []).map(m => [String(m.id), m.last_opened_at]));
        profile.courses[courseId] = clone(row.payload || {});
        profile.courses[courseId].id ||= courseId;
        if (localUi) profile.courses[courseId].ui_state = localUi;
        for (const material of profile.courses[courseId].materials || []) {
          const opened = localOpened.get(String(material.id));
          if (opened) material.last_opened_at = opened;
        }
        if (!profile.course_order.includes(courseId)) profile.course_order.push(courseId);
      }
      return state;
    }
    return state;
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
      .select('user_id,state,revision,save_id,updated_at,updated_by_device')
      .eq('user_id', currentUserId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }
  async function fetchRemoteDocuments() {
    if (!client || !currentUserId) return [];
    const { data, error } = await client.from(CONFIG.documentTable)
      .select('document_id,document,revision,save_id,updated_at,updated_by_device,deleted_at')
      .eq('user_id', currentUserId);
    if (error) throw error;
    return data || [];
  }

  async function fetchRemoteEntities() {
    if (!client || !currentUserId) return [];
    const { data, error } = await client.from(CONFIG.entityTable)
      .select('entity_key,entity_type,payload,revision,save_id,updated_at,updated_by_device,deleted_at')
      .eq('user_id', currentUserId);
    if (error) throw error;
    return data || [];
  }

  async function fetchCloudHistory(kind, itemId, limit = 10) {
    if (!client || !currentUserId) return [];
    const { data, error } = await client.from(CONFIG.historyTable)
      .select('id,item_kind,item_id,revision,save_id,payload,deleted_at,saved_at,source_device')
      .eq('user_id', currentUserId)
      .eq('item_kind', String(kind))
      .eq('item_id', String(itemId))
      .order('saved_at', { ascending: false })
      .limit(Math.max(1, Math.min(Number(limit) || 10, 20)));
    if (error) throw error;
    return data || [];
  }

  async function appendLocalHistory(kind, itemId, payload, saveId = null, { force = false } = {}) {
    const key = kind === 'document' ? lectureHistoryKey(itemId) : `local-history:${String(kind)}:${String(itemId)}`;
    const current = await idbGet(STORES.meta, key) || [];
    const hash = quickHash(payload);
    if (current[0]?.hash === hash) return;
    const entry = {
      kind: String(kind),
      itemId: String(itemId),
      payload: clone(payload),
      saveId,
      hash,
      savedAt: nowIso(),
      deviceId: deviceId(),
    };
    // Keep recovery points useful. Autosave can fire several times per minute;
    // without coalescing, 10 versions could represent only a few seconds of typing.
    // Within a 30-second window keep the newest snapshot in that window, while
    // forced safety checkpoints (before remote replace/restore) are never coalesced.
    const newestMs = Date.parse(current[0]?.savedAt || 0);
    if (!force && newestMs && Date.now() - newestMs < 30000) current[0] = entry;
    else current.unshift(entry);
    await idbSet(STORES.meta, key, current.slice(0, MAX_LOCAL_HISTORY));
  }

  async function getLocalHistory(kind, itemId, limit = 10) {
    const key = kind === 'document' ? lectureHistoryKey(itemId) : `local-history:${String(kind)}:${String(itemId)}`;
    const current = await idbGet(STORES.meta, key) || [];
    return clone(current.slice(0, Math.max(1, Math.min(Number(limit) || 10, MAX_LOCAL_HISTORY))));
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
    if (before) await appendLocalHistory('document', id, documentForCloud(before), null, { force: true });
    if (row.deleted_at || !row.document) {
      await idbDelete(STORES.documents, id);
      await idbDelete(STORES.meta, lectureRecoveryKey(id));
      await idbDelete(STORES.blobs, `pdf:${id}`);
    } else {
      const oldAssigned = before?.slides_attachment?.assigned_at || null;
      const newAssigned = row.document?.slides_attachment?.assigned_at || null;
      const oldCloudObject = before?.slides_attachment?.cloud_object || null;
      const newCloudObject = row.document?.slides_attachment?.cloud_object || null;
      if (oldAssigned !== newAssigned || oldCloudObject !== newCloudObject || (!row.document?.slides_attachment && before?.slides_attachment)) {
        await idbDelete(STORES.blobs, `pdf:${id}`);
      }
      const restored = restoreLocalDocumentUi(row.document, before);
      await idbSet(STORES.documents, id, restored);
      await idbSet(STORES.meta, lectureRecoveryKey(id), { document: clone(restored), saved_at: nowIso() });
      await appendLocalHistory('document', id, documentForCloud(restored), row.save_id || null, { force: true });
    }
    const meta = await getMeta();
    meta.docRevisions ||= {};
    meta.docHashes ||= {};
    meta.docRevisions[id] = Number(row.revision || 0);
    meta.docHashes[id] = quickHash(row.deleted_at || !row.document ? { deleted: true } : documentForCloud(row.document));
    meta.lastSync = nowIso();
    await setMeta(meta);
    if (notify) emitRemote({ kind: 'document', documentId: id, deleted: Boolean(row.deleted_at || !row.document), revision: meta.docRevisions[id] });
  }

  async function applyRemoteEntityRow(row, { notify = true } = {}) {
    const key = String(row?.entity_key || '');
    if (!key) return;
    const localFull = await idbGet(STORES.meta, 'state');
    const next = applyEntityRowToState(localFull || {}, row);
    await idbSet(STORES.meta, 'state', next);
    const meta = await getMeta();
    meta.entityRevisions ||= {};
    meta.entityHashes ||= {};
    meta.entityRevisions[key] = Number(row.revision || 0);
    meta.entityHashes[key] = quickHash(row.deleted_at || row.payload == null ? { deleted: true } : row.payload);
    meta.lastSync = nowIso();
    await setMeta(meta);
    const base = await getEntityBase();
    if (row.deleted_at || row.payload == null) delete base[key];
    else base[key] = { entityType: row.entity_type || 'unknown', payload: clone(row.payload) };
    await setEntityBase(base);
    if (notify) emitRemote({ kind: 'entity', entityKey: key, entityType: row.entity_type || 'unknown', deleted: Boolean(row.deleted_at || row.payload == null), revision: meta.entityRevisions[key] });
  }

  async function replaceLocalFromEntityCloud(rows, remoteState = null) {
    emitStatus({ phase: 'syncing', message: 'Downloading cloud workspace…', needsChoice: false });
    const localFull = await idbGet(STORES.meta, 'state');
    const snapshot = activeEntitySnapshotFromRows(rows || []);
    const rebuilt = stateFromEntitySnapshot(snapshot, localFull || {});
    await idbSet(STORES.meta, 'state', rebuilt);
    const meta = await getMeta();
    meta.entityRevisions = {};
    meta.entityHashes = {};
    for (const row of rows || []) {
      const key = String(row.entity_key || '');
      if (!key) continue;
      meta.entityRevisions[key] = Number(row.revision || 0);
      meta.entityHashes[key] = quickHash(row.deleted_at || row.payload == null ? { deleted: true } : row.payload);
    }
    if (remoteState) {
      meta.stateRevision = Number(remoteState.revision || 0);
      meta.stateHash = quickHash(stateForCloud(remoteState.state || rebuilt));
      await setStateBase(stateForCloud(remoteState.state || rebuilt));
    }
    meta.lastSync = nowIso();
    await setMeta(meta);
    await setEntityBase(snapshot);
    emitRemote({ kind: 'workspace' });
  }

  async function seedEntitiesFromState(fullState, { force = false } = {}) {
    if (!client || !currentUserId) return [];
    const entities = stateToEntities(fullState || {});
    const existing = force ? [] : await fetchRemoteEntities();
    const existingMap = new Map(existing.map(row => [String(row.entity_key), row]));
    const written = [];
    for (const [key, entry] of Object.entries(entities)) {
      const old = existingMap.get(key);
      if (old && !old.deleted_at && sameValue(old.payload, entry.payload)) {
        written.push(old);
        continue;
      }
      const revision = Number(old?.revision || 0) + 1;
      const saveId = newSaveId('seed', key);
      const payload = {
        user_id: currentUserId,
        entity_key: key,
        entity_type: entry.entityType,
        payload: entry.payload,
        revision,
        save_id: saveId,
        updated_at: nowIso(),
        updated_by_device: deviceId(),
        deleted_at: null,
      };
      let result;
      if (old) {
        result = await client.from(CONFIG.entityTable).update(payload)
          .eq('user_id', currentUserId).eq('entity_key', key).eq('revision', Number(old.revision || 0)).select().maybeSingle();
      } else {
        result = await client.from(CONFIG.entityTable).insert(payload).select().maybeSingle();
      }
      if (result.error) throw result.error;
      if (result.data) written.push(result.data);
    }
    const keep = new Set(Object.keys(entities));
    for (const old of existing) {
      const key = String(old.entity_key || '');
      if (!key || keep.has(key) || old.deleted_at) continue;
      const saveId = newSaveId('seed-delete', key);
      const result = await client.from(CONFIG.entityTable).update({
        payload: null,
        revision: Number(old.revision || 0) + 1,
        save_id: saveId,
        updated_at: nowIso(),
        updated_by_device: deviceId(),
        deleted_at: nowIso(),
      }).eq('user_id', currentUserId).eq('entity_key', key).eq('revision', Number(old.revision || 0)).select().maybeSingle();
      if (result.error) throw result.error;
      if (result.data) written.push(result.data);
    }
    const rows = await fetchRemoteEntities();
    const meta = await getMeta();
    meta.entityRevisions = {};
    meta.entityHashes = {};
    for (const row of rows) {
      const key = String(row.entity_key || '');
      if (!key) continue;
      meta.entityRevisions[key] = Number(row.revision || 0);
      meta.entityHashes[key] = quickHash(row.deleted_at || row.payload == null ? { deleted: true } : row.payload);
    }
    await setMeta(meta);
    await setEntityBase(activeEntitySnapshotFromRows(rows));
    return rows;
  }

  async function replaceLocalFromCloud(remoteState) {
    emitStatus({ phase: 'syncing', message: 'Downloading cloud workspace…', needsChoice: false });
    const docs = await fetchRemoteDocuments();
    let entities = [];
    try { entities = await fetchRemoteEntities(); } catch (err) { console.warn('Entity sync unavailable during download:', err); }
    const previousLocalDocs = await idbEntries(STORES.documents);
    await idbClear(STORES.documents);
    await idbClear(STORES.blobs);
    for (const [id] of previousLocalDocs) await idbDelete(STORES.meta, lectureRecoveryKey(id));
    if (entities.length) await replaceLocalFromEntityCloud(entities, remoteState);
    else await applyRemoteStateRow(remoteState, { notify: false });
    const meta = await getMeta();
    meta.docRevisions = {};
    meta.docHashes = {};
    for (const row of docs) {
      const id = String(row.document_id);
      if (!row.deleted_at && row.document) {
        await idbSet(STORES.documents, id, row.document);
        await idbSet(STORES.meta, lectureRecoveryKey(id), { document: clone(row.document), saved_at: nowIso() });
      }
      meta.docRevisions[id] = Number(row.revision || 0);
      meta.docHashes[id] = quickHash(row.deleted_at || !row.document ? { deleted: true } : documentForCloud(row.document));
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
    await replaceCloudFromLocal(null);
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
    const masterSaveId = newSaveId('master', 'workspace');
    const payload = {
      user_id: currentUserId,
      state: localDurable,
      revision: nextRevision,
      save_id: masterSaveId,
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

    await seedEntitiesFromState(localFullState || {});

    const remoteDocs = await fetchRemoteDocuments();
    const remoteMap = new Map(remoteDocs.map(row => [String(row.document_id), row]));
    const localDocs = new Map(await idbEntries(STORES.documents));
    const docRevisions = {};
    const docHashes = {};

    for (const [id, doc] of localDocs) {
      const old = remoteMap.get(String(id));
      const revision = Number(old?.revision || 0) + 1;
      const cloudDoc = documentForCloud(doc);
      const docSaveId = newSaveId('master-doc', id);
      const row = { user_id: currentUserId, document_id: String(id), document: cloudDoc, revision, save_id: docSaveId, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: null };
      const { data, error } = await client.from(CONFIG.documentTable).upsert(row, { onConflict: 'user_id,document_id' }).select().maybeSingle();
      if (error) throw error;
      docRevisions[String(id)] = Number(data?.revision || revision);
      docHashes[String(id)] = quickHash(cloudDoc);
    }
    for (const [id, old] of remoteMap) {
      if (localDocs.has(id) || old.deleted_at) continue;
      const revision = Number(old.revision || 0) + 1;
      const deleteSaveId = newSaveId('master-del-doc', id);
      const { data, error } = await client.from(CONFIG.documentTable).update({ document: null, revision, save_id: deleteSaveId, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: nowIso() })
        .eq('user_id', currentUserId).eq('document_id', id).eq('revision', Number(old.revision || 0)).select().maybeSingle();
      if (error) throw error;
      docRevisions[id] = Number(data?.revision || revision);
      docHashes[id] = quickHash({ deleted: true });
    }

    const meta = await getMeta();
    meta.stateRevision = Number(result.data.revision || nextRevision);
    meta.stateHash = quickHash(localDurable);
    meta.docRevisions = docRevisions;
    meta.docHashes = docHashes;
    meta.lastSync = nowIso();
    meta.lastCloudConfirmedAt = meta.lastSync;
    meta.lastCloudConfirmedSaveId = masterSaveId;
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
      const queuedSaveId = queue.saveIds?.state || null;
      await acceptRemoteStateRevision(row, { apply: false, notify: false });
      if (!queuedSaveId || String(row.save_id || '') === String(queuedSaveId)) {
        queue.stateDirty = false;
        queue.saveIds.state = null;
        await setQueue(queue);
        if (queuedSaveId) await recordCloudConfirmation(queuedSaveId, 'checkpoint', 'workspace', remoteRevision);
        emitPendingStatus(queue);
        return 'same';
      }
      // Equivalent server data with a different save_id is not an exact ACK of
      // this checkpoint. Keep it queued and stamp our save_id from this now-known
      // revision on the next push.
      queue.stateDirty = true;
      await setQueue(queue);
      scheduleFlush();
      return 'merged-pending';
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
    const localDoc = await idbGet(STORES.documents, id);
    const lastSyncedHash = meta.docHashes?.[id] || '';
    const localHash = localDoc == null ? '' : quickHash(documentForCloud(localDoc));
    const implicitDirty = Boolean(lastSyncedHash && localHash && localHash !== lastSyncedHash);
    if (implicitDirty && !queue.dirtyDocs.includes(id) && !queue.deletedDocs.includes(id)) {
      // A local IndexedDB commit happened before its dirty marker finished persisting.
      // Treat the document as dirty rather than allowing Realtime to overwrite it.
      queue.dirtyDocs = unique([...queue.dirtyDocs, id]);
      await setQueue(queue);
    }
    const dirty = implicitDirty || queue.dirtyDocs.includes(id) || queue.deletedDocs.includes(id);
    if (!dirty) {
      await applyRemoteDocumentRow(row, { notify });
      return 'applied';
    }

    const deleting = queue.deletedDocs.includes(id);
    const remoteDeleted = Boolean(row.deleted_at || !row.document);
    const same = deleting ? remoteDeleted : (!remoteDeleted && sameValue(documentForCloud(localDoc || {}), documentForCloud(row.document || {})));
    if (same) {
      meta.docRevisions ||= {};
      meta.docHashes ||= {};
      meta.docRevisions[id] = remoteRevision;
      meta.docHashes[id] = quickHash(remoteDeleted ? { deleted: true } : documentForCloud(row.document));
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

  async function reconcileRemoteEntityRow(row, { notify = true } = {}) {
    const key = String(row?.entity_key || '');
    if (!key) return 'ignored';
    const meta = await getMeta();
    const remoteRevision = Number(row.revision || 0);
    const localRevision = Number(meta.entityRevisions?.[key] || 0);
    if (remoteRevision <= localRevision) return 'stale';

    const queue = await getQueue();
    const localFull = await idbGet(STORES.meta, 'state');
    const localEntities = stateToEntities(localFull || {});
    const localEntry = localEntities[key] || null;
    const localDeleting = queue.deletedEntities.includes(key) || !localEntry;
    const dirty = queue.dirtyEntities.includes(key) || queue.deletedEntities.includes(key);
    if (!dirty) {
      await applyRemoteEntityRow(row, { notify });
      return 'applied';
    }

    const remoteDeleted = Boolean(row.deleted_at || row.payload == null);
    const same = localDeleting
      ? remoteDeleted
      : (!remoteDeleted && sameValue(localEntry?.payload, row.payload));
    if (same) {
      meta.entityRevisions ||= {};
      meta.entityHashes ||= {};
      meta.entityRevisions[key] = remoteRevision;
      meta.entityHashes[key] = quickHash(remoteDeleted ? { deleted: true } : row.payload);
      meta.lastSync = nowIso();
      await setMeta(meta);
      const base = await getEntityBase();
      if (remoteDeleted) delete base[key];
      else base[key] = { entityType: row.entity_type || localEntry?.entityType || 'unknown', payload: clone(row.payload) };
      await setEntityBase(base);
      queue.dirtyEntities = removeValue(queue.dirtyEntities, key);
      queue.deletedEntities = removeValue(queue.deletedEntities, key);
      delete queue.saveIds?.entities?.[key];
      delete queue.saveIds?.deletedEntities?.[key];
      await setQueue(queue);
      emitPendingStatus(queue);
      return 'same';
    }

    const base = await getEntityBase();
    const baseEntry = base[key] || null;
    if (!baseEntry) {
      await createConflict({
        kind: 'entity',
        entityKey: key,
        entityType: row.entity_type || localEntry?.entityType || 'unknown',
        local: localDeleting ? null : localEntry?.payload,
        localDeleting,
        remote: row,
        conflictEntries: [{ path: [], localExists: !localDeleting, localValue: localEntry?.payload ?? null, remoteExists: !remoteDeleted, remoteValue: row.payload ?? null }],
      });
      return 'conflict';
    }

    const merged = mergeThreeWay(
      baseEntry?.payload ?? MISSING,
      localDeleting ? MISSING : (localEntry?.payload ?? MISSING),
      remoteDeleted ? MISSING : row.payload,
      [key],
    );
    if (merged.conflicts.length) {
      await createConflict({
        kind: 'entity',
        entityKey: key,
        entityType: row.entity_type || localEntry?.entityType || baseEntry?.entityType || 'unknown',
        local: localDeleting ? null : localEntry?.payload,
        localDeleting,
        remote: row,
        base: baseEntry?.payload,
        autoMerged: merged.value === MISSING ? null : merged.value,
        conflictEntries: merged.conflicts,
      });
      return 'conflict';
    }

    // Apply the merged value locally, but retain a dirty marker so our local side
    // is acknowledged by Supabase after the remote revision becomes the new base.
    const mergedRow = {
      ...row,
      payload: merged.value === MISSING ? null : merged.value,
      deleted_at: merged.value === MISSING ? (row.deleted_at || nowIso()) : null,
    };
    await applyRemoteEntityRow(mergedRow, { notify: false });
    // Three-way merge base must remain the actual server revision we merged
    // against, not the merged local result. If another remote revision arrives
    // before our retry is acknowledged, this preserves a correct ancestor for
    // the next merge instead of manufacturing a false conflict.
    const remoteBase = await getEntityBase();
    if (remoteDeleted) delete remoteBase[key];
    else remoteBase[key] = { entityType: row.entity_type || localEntry?.entityType || baseEntry?.entityType || 'unknown', payload: clone(row.payload) };
    await setEntityBase(remoteBase);
    const freshQueue = await getQueue();
    if (merged.value === MISSING) {
      freshQueue.deletedEntities = unique([...freshQueue.deletedEntities, key]);
      freshQueue.dirtyEntities = removeValue(freshQueue.dirtyEntities, key);
      freshQueue.saveIds.deletedEntities[key] ||= newSaveId('entity-delete', key);
    } else {
      freshQueue.dirtyEntities = unique([...freshQueue.dirtyEntities, key]);
      freshQueue.deletedEntities = removeValue(freshQueue.deletedEntities, key);
      freshQueue.saveIds.entities[key] ||= newSaveId('entity', key);
    }
    await setQueue(freshQueue);
    if (notify) emitRemote({ kind: 'entity', entityKey: key, merged: true, revision: remoteRevision });
    return 'merged-pending';
  }

  async function bootstrapUser(user) {
    if (!user?.id || !client) return;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      currentUserId = user.id;
      currentUserEmail = user.email || '';
      session = (await client.auth.getSession()).data.session || session;
      await migrateLocalQueueToUser(currentUserId);
      emitStatus({ signedIn: true, phase: 'syncing', message: 'Reconciling local saves with cloud…', email: currentUserEmail });

      let remote = null;
      let remoteEntities = [];
      try {
        [remote, remoteEntities] = await Promise.all([
          fetchRemoteState(),
          fetchRemoteEntities(),
        ]);
      } catch (err) {
        console.error(err);
        emitStatus({
          phase: navigator.onLine ? 'error' : 'offline',
          message: navigator.onLine
            ? `Cloud setup error: ${err.message || err}. If this is the first hardened-sync build, run SUPABASE_SYNC_HARDENING.sql once.`
            : 'Offline — local changes remain queued and will sync when internet returns.',
        });
        startWatchdog();
        return;
      }

      const localState = await idbGet(STORES.meta, 'state');
      let meta = await getMeta();
      const stateBase = await getStateBase();
      const entityBase = await getEntityBase();
      // Capture first-use status BEFORE a v3→v4 cloud-format upgrade seeds
      // entity revisions. Otherwise the migration itself can make a genuinely
      // new device look previously reconciled and skip the local/cloud choice.
      const firstUseBeforeEntityUpgrade =
        Object.keys(meta.entityRevisions || {}).length === 0 &&
        Object.keys(entityBase || {}).length === 0 &&
        Number(meta.stateRevision || 0) === 0 &&
        !stateBase;

      // One-time migration from the original whole-workspace cloud record into
      // granular state entities. This is safe to repeat because seedEntitiesFromState
      // compares existing rows and uses revision checks.
      if (!remoteEntities.length && remote?.state) {
        emitStatus({ phase: 'syncing', message: 'Upgrading cloud save format…' });
        remoteEntities = await seedEntitiesFromState(remote.state);
        meta = await getMeta();
      }

      const firstUseForThisAccount = firstUseBeforeEntityUpgrade;

      if (!remote && !remoteEntities.length) {
        await setMeta(blankMeta(currentUserId));
        await setStateBase(null);
        await setEntityBase({});
        await uploadLocalAsNewCloud();
      } else if (
        firstUseForThisAccount &&
        localHasMeaningfulData(localState) &&
        remote?.state &&
        !sameValue(stateForCloud(localState), stateForCloud(remote.state))
      ) {
        initialChoice = { remoteState: remote };
        emitStatus({ phase: 'needs-choice', message: 'Cloud data and local data both exist. Choose which copy to use.', needsChoice: true });
      } else if (firstUseForThisAccount) {
        await setMeta(blankMeta(currentUserId));
        await replaceLocalFromCloud(remote || {
          state: stateFromEntitySnapshot(activeEntitySnapshotFromRows(remoteEntities), localState || {}),
          revision: 0,
        });
      } else {
        // Recover the tiny transactional-outbox gap first: a force-close may
        // have persisted content but not yet persisted its cloud queue marker.
        await recoverUnqueuedLocalChanges();
        // Startup reconciliation order is deliberate:
        // 1) preserve all local pending work,
        // 2) accept/merge newer entity/document revisions,
        // 3) flush the persistent queue,
        // 4) only then report cloud-confirmed.
        if (remoteEntities.length) await syncRemoteEntitiesSnapshot(remoteEntities);
        else if (remote && Number(remote.revision || 0) > Number(meta.stateRevision || 0)) {
          await reconcileRemoteStateRow(remote, { notify: false });
        }
        if (!currentConflict) await syncRemoteDocumentsSnapshot();
        if (!currentConflict) await flushNow();
      }

      await subscribeRealtime();
      startWatchdog();
      schedulePeriodicCheckpoint();

      if (!currentConflict && !initialChoice) {
        const latestMeta = await getMeta();
        const queue = await getQueue();
        const pending = queueCount(queue);
        emitStatus({
          phase: navigator.onLine ? (pending ? 'pending' : 'synced') : 'offline',
          message: navigator.onLine
            ? (pending ? `${pending} change${pending === 1 ? '' : 's'} safely queued for cloud confirmation.` : 'Cloud confirmed.')
            : 'Offline — changes are saved locally.',
          lastSync: latestMeta.lastSync,
          lastLocalSaveAt: latestMeta.lastLocalSaveAt,
          lastLocalSaveId: latestMeta.lastLocalSaveId,
          lastCloudConfirmedAt: latestMeta.lastCloudConfirmedAt,
          lastCloudConfirmedSaveId: latestMeta.lastCloudConfirmedSaveId,
          needsChoice: false,
          conflict: false,
          pendingChanges: pending,
        });
        if (pending && navigator.onLine) scheduleFlush();
      }
    })().finally(() => { bootstrapPromise = null; });
    return bootstrapPromise;
  }


  async function syncRemoteEntitiesSnapshot(rows = null) {
    if (!currentUserId || !client) return;
    const remoteRows = rows || await fetchRemoteEntities();
    const meta = await getMeta();
    for (const row of remoteRows) {
      const key = String(row.entity_key || '');
      if (!key) continue;
      if (Number(row.revision || 0) <= Number(meta.entityRevisions?.[key] || 0)) continue;
      const result = await reconcileRemoteEntityRow(row, { notify: false });
      if (result === 'conflict') break;
    }
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
    const label = conflict.kind === 'document' ? 'Lecture' : (conflict.kind === 'entity' ? 'app item' : 'data field');
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
    } else if (conflict.kind === 'entity') {
      const key = String(conflict.entityKey || '');
      const remoteResult = await client.from(CONFIG.entityTable)
        .select('entity_key,entity_type,payload,revision,save_id,updated_at,updated_by_device,deleted_at')
        .eq('user_id', currentUserId).eq('entity_key', key).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      const remote = remoteResult.data;
      const queue = await getQueue();
      const meta = await getMeta();
      if (strategy === 'cloud') {
        if (remote) await applyRemoteEntityRow(remote);
        queue.dirtyEntities = removeValue(queue.dirtyEntities, key);
        queue.deletedEntities = removeValue(queue.deletedEntities, key);
        delete queue.saveIds.entities[key];
        delete queue.saveIds.deletedEntities[key];
        await setQueue(queue);
      } else {
        const currentState = await idbGet(STORES.meta, 'state');
        const currentEntry = stateToEntities(currentState || {})[key] || null;
        meta.entityRevisions ||= {};
        meta.entityHashes ||= {};
        meta.entityRevisions[key] = Number(remote?.revision || 0);
        meta.entityHashes[key] = quickHash(remote?.deleted_at || remote?.payload == null ? { deleted: true } : remote.payload);
        await setMeta(meta);
        const baseMap = await getEntityBase();
        if (!remote || remote.deleted_at || remote.payload == null) delete baseMap[key];
        else baseMap[key] = { entityType: remote.entity_type || conflict.entityType || 'unknown', payload: clone(remote.payload) };
        await setEntityBase(baseMap);
        if (currentEntry) {
          queue.dirtyEntities = unique([...queue.dirtyEntities, key]);
          queue.deletedEntities = removeValue(queue.deletedEntities, key);
          queue.saveIds.entities[key] = newSaveId('entity', key);
          delete queue.saveIds.deletedEntities[key];
        } else {
          queue.deletedEntities = unique([...queue.deletedEntities, key]);
          queue.dirtyEntities = removeValue(queue.dirtyEntities, key);
          queue.saveIds.deletedEntities[key] = newSaveId('entity-delete', key);
          delete queue.saveIds.entities[key];
        }
        await setQueue(queue);
      }
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

  async function enqueueMutation(mutator, { kind = 'save', targetId = '', contentHash = '' } = {}) {
    const saveId = newSaveId(kind, targetId);
    const task = queueMutationSerial.then(async () => {
      const q = await getQueue();
      mutator(q, saveId);
      q.dirtyEntities = unique(q.dirtyEntities);
      q.deletedEntities = unique(q.deletedEntities);
      q.dirtyDocs = unique(q.dirtyDocs);
      q.deletedDocs = unique(q.deletedDocs);
      q.dirtyBlobs = unique(q.dirtyBlobs);
      q.deletedBlobs = unique(q.deletedBlobs);
      const retryKey = `${kind}:${String(targetId)}`;
      delete q.retry[retryKey];
      await setQueue(q, currentUserId, { emit: true });
      await recordLocalSave(saveId, kind, targetId, contentHash);
      return { q, saveId };
    });
    queueMutationSerial = task.catch(err => { console.error('Cloud queue update failed:', err); });
    const result = await task;
    scheduleFlush();
    return result.saveId;
  }

  async function markStateDirty() {
    const localFull = await idbGet(STORES.meta, 'state');
    const current = stateToEntities(localFull || {});
    const base = await getEntityBase(currentUserId);
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(current)]);
    const changed = [];
    const deleted = [];
    for (const key of keys) {
      const before = base?.[key];
      const after = current[key];
      if (!after && before) deleted.push(key);
      else if (after && (!before || !sameValue(after.payload, before.payload))) changed.push(key);
    }
    if (!changed.length && !deleted.length) return null;

    // One save ID maps to exactly one server row. This makes acknowledgements
    // unambiguous in diagnostics and lets a crash/retry prove precisely which
    // local item Supabase accepted.
    const localRecords = [];
    const task = queueMutationSerial.then(async () => {
      const q = await getQueue();
      for (const key of changed) {
        const saveId = newSaveId('entity', key);
        q.dirtyEntities = unique([...q.dirtyEntities, key]);
        q.deletedEntities = removeValue(q.deletedEntities, key);
        q.saveIds.entities[key] = saveId;
        delete q.saveIds.deletedEntities[key];
        localRecords.push({ saveId, kind: 'entity', key, hash: quickHash(current[key]?.payload || {}) });
      }
      for (const key of deleted) {
        const saveId = newSaveId('entity-delete', key);
        q.deletedEntities = unique([...q.deletedEntities, key]);
        q.dirtyEntities = removeValue(q.dirtyEntities, key);
        q.saveIds.deletedEntities[key] = saveId;
        delete q.saveIds.entities[key];
        localRecords.push({ saveId, kind: 'entity-delete', key, hash: quickHash({ deleted: true }) });
      }
      clearGlobalRetry(q);
      await setQueue(q, currentUserId, { emit: true });
      for (const record of localRecords) await recordLocalSave(record.saveId, record.kind, record.key, record.hash);
      return q;
    });
    queueMutationSerial = task.catch(err => { console.error('Cloud entity queue update failed:', err); });
    await task;
    for (const record of localRecords) {
      if (record.kind === 'entity' && current[record.key]) await appendLocalHistory('entity', record.key, current[record.key].payload, record.saveId);
    }
    scheduleFlush();
    return localRecords.at(-1)?.saveId || null;
  }

  async function markDocumentDirty(id) {
    const target = String(id);
    const doc = await idbGet(STORES.documents, target);
    const hash = quickHash(documentForCloud(doc || {}));
    const saveId = await enqueueMutation((q, sid) => {
      q.dirtyDocs = unique([...q.dirtyDocs, target]);
      q.deletedDocs = removeValue(q.deletedDocs, target);
      q.saveIds.docs[target] = sid;
      delete q.saveIds.deletedDocs[target];
    }, { kind: 'document', targetId: target, contentHash: hash });
    if (doc) await appendLocalHistory('document', target, documentForCloud(doc), saveId);
    return saveId;
  }

  async function markDocumentDeleted(id) {
    const target = String(id);
    return enqueueMutation((q, sid) => {
      q.deletedDocs = unique([...q.deletedDocs, target]);
      q.dirtyDocs = removeValue(q.dirtyDocs, target);
      q.saveIds.deletedDocs[target] = sid;
      delete q.saveIds.docs[target];
    }, { kind: 'document-delete', targetId: target, contentHash: quickHash({ deleted: true }) });
  }

  async function markBlobDirty(key) {
    const target = String(key);
    const blob = await idbGet(STORES.blobs, target);
    const hash = blob instanceof Blob ? `${blob.size}:${blob.type || ''}:${blob.lastModified || ''}` : '';
    return enqueueMutation((q, sid) => {
      q.dirtyBlobs = unique([...q.dirtyBlobs, target]);
      q.deletedBlobs = removeValue(q.deletedBlobs, target);
      q.saveIds.blobs[target] = sid;
      delete q.saveIds.deletedBlobs[target];
    }, { kind: 'blob', targetId: target, contentHash: hash });
  }

  async function markBlobDeleted(key) {
    const target = String(key);
    return enqueueMutation((q, sid) => {
      q.deletedBlobs = unique([...q.deletedBlobs, target]);
      q.dirtyBlobs = removeValue(q.dirtyBlobs, target);
      q.saveIds.deletedBlobs[target] = sid;
      delete q.saveIds.blobs[target];
    }, { kind: 'blob-delete', targetId: target, contentHash: quickHash({ deleted: true }) });
  }

  async function recoverUnqueuedLocalChanges() {
    // Transactional-outbox safety net: local content and the cloud queue live in
    // separate IndexedDB records. If the browser is killed in the few ms after
    // a local content commit but before its outbox marker is written, detect the
    // mismatch against the last cloud-confirmed bases on the next startup.
    if (!currentUserId) return { recovered: 0, entities: 0, documents: 0, deletions: 0 };
    let recovered = 0, entityCount = 0, documentCount = 0, deletionCount = 0;

    const beforeQueue = await getQueue();
    const beforeEntityIds = new Set([...(beforeQueue.dirtyEntities || []), ...(beforeQueue.deletedEntities || [])]);
    await markStateDirty();
    let queue = await getQueue();
    for (const key of [...queue.dirtyEntities, ...queue.deletedEntities]) {
      if (!beforeEntityIds.has(String(key))) { recovered += 1; entityCount += 1; }
    }

    const meta = await getMeta();
    const localDocEntries = await idbEntries(STORES.documents);
    const localDocs = new Map(localDocEntries.map(([id, doc]) => [String(id), doc]));
    queue = await getQueue();
    for (const [id, doc] of localDocs) {
      const hash = quickHash(documentForCloud(doc || {}));
      const confirmedHash = String(meta.docHashes?.[id] || '');
      const alreadyQueued = queue.dirtyDocs.includes(id) || queue.deletedDocs.includes(id);
      if (!alreadyQueued && (!confirmedHash || confirmedHash !== hash)) {
        await markDocumentDirty(id);
        recovered += 1; documentCount += 1;
        queue = await getQueue();
      }
    }

    for (const [id, confirmedHash] of Object.entries(meta.docHashes || {})) {
      if (!confirmedHash || localDocs.has(String(id))) continue;
      const alreadyQueued = queue.dirtyDocs.includes(String(id)) || queue.deletedDocs.includes(String(id));
      if (!alreadyQueued && Number(meta.docRevisions?.[id] || 0) > 0) {
        await markDocumentDeleted(String(id));
        recovered += 1; deletionCount += 1;
        queue = await getQueue();
      }
    }

    if (recovered) {
      emitStatus({
        phase: navigator.onLine ? 'pending' : 'offline',
        message: `${recovered} locally saved change${recovered === 1 ? '' : 's'} recovered into the sync queue after an interrupted save.`,
        pendingChanges: queueCount(queue),
      });
    }
    return { recovered, entities: entityCount, documents: documentCount, deletions: deletionCount };
  }

  async function markEverythingDirty() {
    const localFull = await idbGet(STORES.meta, 'state');
    const entities = stateToEntities(localFull || {});
    const docs = await idbEntries(STORES.documents);
    const blobs = await idbEntries(STORES.blobs);
    const records = [];
    const task = queueMutationSerial.then(async () => {
      const q = await getQueue();
      for (const key of Object.keys(entities)) {
        const sid = newSaveId('entity', key);
        q.dirtyEntities = unique([...q.dirtyEntities, key]);
        q.deletedEntities = removeValue(q.deletedEntities, key);
        q.saveIds.entities[key] = sid;
        records.push({ saveId: sid, kind: 'entity', target: key, hash: quickHash(entities[key].payload) });
      }
      for (const [id, doc] of docs) {
        const key = String(id), sid = newSaveId('document', key);
        q.dirtyDocs = unique([...q.dirtyDocs, key]);
        q.deletedDocs = removeValue(q.deletedDocs, key);
        q.saveIds.docs[key] = sid;
        records.push({ saveId: sid, kind: 'document', target: key, hash: quickHash(documentForCloud(doc || {})) });
      }
      for (const [keyRaw, blob] of blobs) {
        const key = String(keyRaw);
        if (!key.startsWith('pdf:') || !(blob instanceof Blob)) continue;
        const sid = newSaveId('blob', key);
        q.dirtyBlobs = unique([...q.dirtyBlobs, key]);
        q.deletedBlobs = removeValue(q.deletedBlobs, key);
        q.saveIds.blobs[key] = sid;
        records.push({ saveId: sid, kind: 'blob', target: key, hash: `${blob.size}:${blob.type || ''}:${blob.lastModified || ''}` });
      }
      clearGlobalRetry(q);
      await setQueue(q, currentUserId, { emit: true });
      for (const record of records) await recordLocalSave(record.saveId, record.kind, record.target, record.hash);
      return q;
    });
    queueMutationSerial = task.catch(err => { console.error('Full cloud queue update failed:', err); });
    await task;
    for (const record of records) {
      if (record.kind === 'entity' && entities[record.target]) await appendLocalHistory('entity', record.target, entities[record.target].payload, record.saveId);
      if (record.kind === 'document') {
        const doc = await idbGet(STORES.documents, record.target);
        if (doc) await appendLocalHistory('document', record.target, documentForCloud(doc), record.saveId);
      }
    }
    scheduleFlush();
    return records.at(-1)?.saveId || null;
  }

  function queueLastSaveId(queue) {
    const ids = [
      queue?.saveIds?.state,
      ...Object.values(queue?.saveIds?.entities || {}),
      ...Object.values(queue?.saveIds?.deletedEntities || {}),
      ...Object.values(queue?.saveIds?.docs || {}),
      ...Object.values(queue?.saveIds?.deletedDocs || {}),
      ...Object.values(queue?.saveIds?.blobs || {}),
      ...Object.values(queue?.saveIds?.deletedBlobs || {}),
    ].filter(Boolean);
    return ids[ids.length - 1] || null;
  }

  function retryDelay(attempts) {
    const exp = Math.max(0, Math.min(Number(attempts || 1) - 1, 6));
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exp));
  }

  function scheduleRetry(queue) {
    clearTimeout(retryTimer);
    const retry = queue?.retry?.global;
    if (!retry?.nextRetryAt || !currentUserId || initialChoice || currentConflict) return;
    const delay = Math.max(50, Date.parse(retry.nextRetryAt) - Date.now());
    retryTimer = setTimeout(() => {
      flushNow().catch(err => console.error('Automatic retry failed:', err));
    }, delay);
  }

  async function setGlobalRetry(queue, error) {
    const previous = queue.retry?.global || {};
    const attempts = Number(previous.attempts || 0) + 1;
    const nextRetryAt = new Date(Date.now() + retryDelay(attempts)).toISOString();
    queue.retry ||= {};
    queue.retry.global = {
      attempts,
      nextRetryAt,
      lastError: String(error?.message || error || 'Cloud request failed'),
      at: nowIso(),
    };
    await setQueue(queue);
    await recordSaveFailure(queueLastSaveId(queue), error, attempts, nextRetryAt);
    scheduleRetry(queue);
    return queue.retry.global;
  }

  function clearGlobalRetry(queue) {
    if (queue?.retry?.global) delete queue.retry.global;
    clearTimeout(retryTimer);
    retryTimer = null;
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
      if (!pending) return emitStatus({ phase: 'synced', message: 'Cloud confirmed.', pendingChanges: 0 });
      const retry = q.retry?.global;
      if (retry?.nextRetryAt && Date.parse(retry.nextRetryAt) > Date.now()) {
        emitStatus({
          phase: 'pending',
          message: `${pending} change${pending === 1 ? '' : 's'} saved locally — retry scheduled.`,
          pendingChanges: pending,
          lastError: retry.lastError || null,
          retryAt: retry.nextRetryAt,
        });
        scheduleRetry(q);
        return;
      }
      emitStatus({ phase: 'pending', message: `${pending} change${pending === 1 ? '' : 's'} saved locally — awaiting cloud confirmation.`, pendingChanges: pending });
      flushTimer = setTimeout(() => flushNow().catch(err => console.error(err)), SYNC_DEBOUNCE_MS);
    }).catch(() => {});
  }

  async function queueWorkspaceCheckpoint() {
    if (!currentUserId) return null;
    const localFull = await idbGet(STORES.meta, 'state');
    const hash = quickHash(stateForCloud(localFull || {}));
    const saveId = await enqueueMutation((q, sid) => {
      q.stateDirty = true;
      q.saveIds.state = sid;
    }, { kind: 'checkpoint', targetId: 'workspace', contentHash: hash });
    const meta = await getMeta();
    meta.lastCheckpointAt = nowIso();
    await setMeta(meta);
    return saveId;
  }

  function schedulePeriodicCheckpoint() {
    clearTimeout(checkpointTimer);
    if (!currentUserId) return;
    checkpointTimer = setTimeout(async () => {
      try {
        if (currentUserId && !initialChoice && !currentConflict) await queueWorkspaceCheckpoint();
      } catch (err) {
        console.warn('Periodic cloud checkpoint could not be queued:', err);
      } finally {
        schedulePeriodicCheckpoint();
      }
    }, CHECKPOINT_INTERVAL_MS);
  }

  async function probeCloud() {
    if (!client || !currentUserId || !session || !navigator.onLine) return false;
    const request = client.from(CONFIG.entityTable).select('entity_key').eq('user_id', currentUserId).limit(1);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Cloud connectivity check timed out.')), 8000));
    const result = await Promise.race([request, timeout]);
    if (result?.error) throw result.error;
    return true;
  }

  function startWatchdog() {
    clearTimeout(watchdogTimer);
    if (!currentUserId) return;
    const tick = async () => {
      try {
        const ok = await probeCloud();
        if (ok) {
          const q = await getQueue();
          if (q.retry?.global) {
            clearGlobalRetry(q);
            await setQueue(q);
          }
          if (queueCount(q)) await flushNow();
        }
      } catch (err) {
        const q = await getQueue().catch(() => blankQueue());
        emitStatus({
          phase: navigator.onLine ? 'degraded' : 'offline',
          message: navigator.onLine
            ? `Cloud temporarily unreachable — ${queueCount(q)} local change${queueCount(q) === 1 ? '' : 's'} remain safe.`
            : 'Offline — local changes remain safe.',
          pendingChanges: queueCount(q),
          lastError: String(err?.message || err),
        });
      } finally {
        watchdogTimer = setTimeout(tick, 60000);
      }
    };
    watchdogTimer = setTimeout(tick, 15000);
  }

  async function pushEntity(key, queue, meta, attempt = 0) {
    const entityKey = String(key);
    const localFull = await idbGet(STORES.meta, 'state');
    const entities = stateToEntities(localFull || {});
    const localEntry = entities[entityKey] || null;
    const deleting = queue.deletedEntities.includes(entityKey) || !localEntry;
    const saveId = deleting
      ? (queue.saveIds?.deletedEntities?.[entityKey] || newSaveId('entity-delete', entityKey))
      : (queue.saveIds?.entities?.[entityKey] || newSaveId('entity', entityKey));
    if (deleting) queue.saveIds.deletedEntities[entityKey] = saveId;
    else queue.saveIds.entities[entityKey] = saveId;

    const base = Number(meta.entityRevisions?.[entityKey] || 0);
    const updated = nowIso();
    let data = null, error = null;

    if (deleting) {
      if (!base) {
        const remoteResult = await client.from(CONFIG.entityTable)
          .select('entity_key,entity_type,payload,revision,save_id,updated_at,updated_by_device,deleted_at')
          .eq('user_id', currentUserId).eq('entity_key', entityKey).maybeSingle();
        if (remoteResult.error) throw remoteResult.error;
        if (!remoteResult.data) {
          queue.deletedEntities = removeValue(queue.deletedEntities, entityKey);
          delete queue.saveIds.deletedEntities[entityKey];
          await recordCloudConfirmation(saveId, 'entity-delete', entityKey, 0);
          return true;
        }
        if (remoteResult.data.deleted_at) {
          if (String(remoteResult.data.save_id || '') !== String(saveId)) {
            if (attempt >= 3) throw new Error(`Cloud could not acknowledge delete ${saveId} for ${entityKey}.`);
            meta.entityRevisions ||= {};
            meta.entityRevisions[entityKey] = Number(remoteResult.data.revision || 0);
            return pushEntity(entityKey, queue, meta, attempt + 1);
          }
          queue.deletedEntities = removeValue(queue.deletedEntities, entityKey);
          delete queue.saveIds.deletedEntities[entityKey];
          await recordCloudConfirmation(saveId, 'entity-delete', entityKey, Number(remoteResult.data.revision || 0));
          return true;
        }
        meta.entityRevisions ||= {};
        meta.entityRevisions[entityKey] = Number(remoteResult.data.revision || 0);
        return pushEntity(entityKey, queue, meta, attempt + 1);
      }
      ({ data, error } = await client.from(CONFIG.entityTable).update({
        payload: null,
        revision: base + 1,
        save_id: saveId,
        updated_at: updated,
        updated_by_device: deviceId(),
        deleted_at: updated,
      }).eq('user_id', currentUserId).eq('entity_key', entityKey).eq('revision', base).select().maybeSingle());
    } else if (base === 0) {
      ({ data, error } = await client.from(CONFIG.entityTable).insert({
        user_id: currentUserId,
        entity_key: entityKey,
        entity_type: localEntry.entityType,
        payload: localEntry.payload,
        revision: 1,
        save_id: saveId,
        updated_at: updated,
        updated_by_device: deviceId(),
        deleted_at: null,
      }).select().maybeSingle());
    } else {
      ({ data, error } = await client.from(CONFIG.entityTable).update({
        entity_type: localEntry.entityType,
        payload: localEntry.payload,
        revision: base + 1,
        save_id: saveId,
        updated_at: updated,
        updated_by_device: deviceId(),
        deleted_at: null,
      }).eq('user_id', currentUserId).eq('entity_key', entityKey).eq('revision', base).select().maybeSingle());
    }

    if (error) {
      if (String(error.code) === '23505') data = null;
      else throw error;
    }

    if (!data) {
      const remoteResult = await client.from(CONFIG.entityTable)
        .select('entity_key,entity_type,payload,revision,save_id,updated_at,updated_by_device,deleted_at')
        .eq('user_id', currentUserId).eq('entity_key', entityKey).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      const remote = remoteResult.data;
      const same = deleting
        ? (!remote || remote.deleted_at || remote.payload == null)
        : (remote && !remote.deleted_at && sameValue(localEntry.payload, remote.payload));
      if (same) {
        // If the request response was lost, the row itself proves exact
        // acknowledgement only when it carries our save_id. If equivalent data
        // came from an older/different save, advance from that revision once so
        // this exact local save gets an auditable server acknowledgement.
        if (remote && String(remote.save_id || '') !== String(saveId)) {
          if (attempt >= 3) throw new Error(`Cloud could not acknowledge save ${saveId} for ${entityKey}.`);
          meta.entityRevisions ||= {};
          meta.entityRevisions[entityKey] = Number(remote.revision || 0);
          const serverBase = await getEntityBase();
          if (remote.deleted_at || remote.payload == null) delete serverBase[entityKey];
          else serverBase[entityKey] = { entityType: remote.entity_type || localEntry?.entityType || 'unknown', payload: clone(remote.payload) };
          await setEntityBase(serverBase);
          return pushEntity(entityKey, queue, meta, attempt + 1);
        }
        meta.entityRevisions ||= {};
        meta.entityHashes ||= {};
        meta.entityRevisions[entityKey] = Number(remote?.revision || base);
        meta.entityHashes[entityKey] = quickHash(deleting ? { deleted: true } : localEntry.payload);
        if (deleting) {
          queue.deletedEntities = removeValue(queue.deletedEntities, entityKey);
          delete queue.saveIds.deletedEntities[entityKey];
        } else {
          const latest = stateToEntities(await idbGet(STORES.meta, 'state') || {})[entityKey];
          if (latest && quickHash(latest.payload) === quickHash(localEntry.payload) && queue.saveIds.entities[entityKey] === saveId) {
            queue.dirtyEntities = removeValue(queue.dirtyEntities, entityKey);
            delete queue.saveIds.entities[entityKey];
          }
        }
        const baseMap = await getEntityBase();
        if (deleting) delete baseMap[entityKey];
        else baseMap[entityKey] = clone(localEntry);
        await setEntityBase(baseMap);
        await recordCloudConfirmation(saveId, deleting ? 'entity-delete' : 'entity', entityKey, Number(remote?.revision || base));
        return true;
      }
      if (remote) {
        const result = await reconcileRemoteEntityRow(remote, { notify: true });
        if (result === 'conflict') return false;
        const freshMeta = await getMeta();
        Object.assign(meta, freshMeta);
        const freshQueue = await getQueue();
        Object.assign(queue, freshQueue);
        if (attempt >= 3) throw new Error(`Cloud entity ${entityKey} changed repeatedly while syncing.`);
        return pushEntity(entityKey, queue, meta, attempt + 1);
      }
      if (attempt >= 2) throw new Error(`Could not create cloud entity ${entityKey}.`);
      meta.entityRevisions[entityKey] = 0;
      return pushEntity(entityKey, queue, meta, attempt + 1);
    }

    if (data.save_id && String(data.save_id) !== String(saveId)) {
      throw new Error(`Cloud acknowledgement mismatch for ${entityKey}.`);
    }

    meta.entityRevisions ||= {};
    meta.entityHashes ||= {};
    meta.entityRevisions[entityKey] = Number(data.revision || base + 1);
    meta.entityHashes[entityKey] = quickHash(deleting ? { deleted: true } : localEntry.payload);
    meta.lastSync = nowIso();

    const baseMap = await getEntityBase();
    if (deleting) delete baseMap[entityKey];
    else baseMap[entityKey] = clone(localEntry);
    await setEntityBase(baseMap);

    if (deleting) {
      if (queue.saveIds.deletedEntities[entityKey] === saveId) {
        queue.deletedEntities = removeValue(queue.deletedEntities, entityKey);
        delete queue.saveIds.deletedEntities[entityKey];
      }
    } else {
      const latest = stateToEntities(await idbGet(STORES.meta, 'state') || {})[entityKey];
      const latestHash = latest ? quickHash(latest.payload) : '';
      const pushedHash = quickHash(localEntry.payload);
      if (latestHash === pushedHash && queue.saveIds.entities[entityKey] === saveId) {
        queue.dirtyEntities = removeValue(queue.dirtyEntities, entityKey);
        delete queue.saveIds.entities[entityKey];
      }
    }
    await recordCloudConfirmation(saveId, deleting ? 'entity-delete' : 'entity', entityKey, meta.entityRevisions[entityKey]);
    return true;
  }

  async function pushState(queue, meta, attempt = 0) {
    const localFull = await idbGet(STORES.meta, 'state');
    const localDurable = stateForCloud(localFull || {});
    const pushedStateHash = quickHash(localDurable);
    const baseState = await getStateBase();
    const saveId = queue.saveIds?.state || newSaveId('checkpoint', 'workspace');
    queue.saveIds.state = saveId;

    if (baseState && sameValue(localDurable, baseState)) {
      queue.stateDirty = false;
      queue.saveIds.state = null;
      return true;
    }

    const base = Number(meta.stateRevision || 0);
    const updated = nowIso();
    let data = null, error = null;
    if (base === 0) {
      ({ data, error } = await client.from(CONFIG.stateTable).insert({ user_id: currentUserId, state: localDurable, revision: 1, save_id: saveId, updated_at: updated, updated_by_device: deviceId() }).select().maybeSingle());
    } else {
      ({ data, error } = await client.from(CONFIG.stateTable).update({ state: localDurable, revision: base + 1, save_id: saveId, updated_at: updated, updated_by_device: deviceId() })
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
    if (data.save_id && String(data.save_id) !== String(saveId)) throw new Error('Cloud checkpoint acknowledgement mismatch.');
    const syncedDurable = stateForCloud(data.state || localDurable);
    meta.stateRevision = Number(data.revision || base + 1);
    meta.stateHash = quickHash(syncedDurable);
    meta.lastSync = nowIso();
    await setStateBase(syncedDurable);

    // If the user changed app state while this network request was in flight,
    // keep it dirty so the newer local change is sent in the next pass.
    const latestFull = await idbGet(STORES.meta, 'state');
    const latestDurable = stateForCloud(latestFull || {});
    queue.stateDirty = quickHash(latestDurable) !== pushedStateHash;
    if (!queue.stateDirty && queue.saveIds.state === saveId) queue.saveIds.state = null;
    await recordCloudConfirmation(saveId, 'checkpoint', 'workspace', meta.stateRevision);
    return true;
  }

  async function pushDocument(id, queue, meta, attempt = 0) {
    const doc = await idbGet(STORES.documents, id);
    const cloudDoc = documentForCloud(doc || {});
    const pushedHash = quickHash(cloudDoc);
    const base = Number(meta.docRevisions?.[id] || 0);
    const saveId = queue.saveIds?.docs?.[id] || newSaveId('document', id);
    queue.saveIds.docs[id] = saveId;
    const updated = nowIso();
    let data = null, error = null;
    if (base === 0) {
      ({ data, error } = await client.from(CONFIG.documentTable).insert({ user_id: currentUserId, document_id: id, document: cloudDoc, revision: 1, save_id: saveId, updated_at: updated, updated_by_device: deviceId(), deleted_at: null }).select().maybeSingle());
    } else {
      ({ data, error } = await client.from(CONFIG.documentTable).update({ document: cloudDoc, revision: base + 1, save_id: saveId, updated_at: updated, updated_by_device: deviceId(), deleted_at: null })
        .eq('user_id', currentUserId).eq('document_id', id).eq('revision', base).select().maybeSingle());
    }
    if (error) {
      if (String(error.code) === '23505') data = null;
      else throw error;
    }
    if (!data) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      if (remoteResult.data && !remoteResult.data.deleted_at && sameValue(cloudDoc, documentForCloud(remoteResult.data.document || {}))) {
        if (String(remoteResult.data.save_id || '') !== String(saveId)) {
          if (attempt >= 3) throw new Error(`Cloud could not acknowledge save ${saveId} for Lecture ${id}.`);
          meta.docRevisions ||= {};
          meta.docRevisions[id] = Number(remoteResult.data.revision || 0);
          return pushDocument(id, queue, meta, attempt + 1);
        }
        meta.docRevisions ||= {};
        meta.docHashes ||= {};
        meta.docRevisions[id] = Number(remoteResult.data.revision || 0);
        meta.docHashes[id] = pushedHash;
        const latestDoc = await idbGet(STORES.documents, id);
        const unchanged = quickHash(documentForCloud(latestDoc || {})) === pushedHash && queue.saveIds.docs[id] === saveId;
        queue.dirtyDocs = unchanged ? removeValue(queue.dirtyDocs, id) : unique([...queue.dirtyDocs, id]);
        if (unchanged) delete queue.saveIds.docs[id];
        await recordCloudConfirmation(saveId, 'document', id, Number(remoteResult.data.revision || 0));
        return true;
      }
      await createConflict({ kind: 'document', id, local: doc, localDeleting: false, remote: remoteResult.data });
      return false;
    }
    if (data.save_id && String(data.save_id) !== String(saveId)) throw new Error(`Cloud acknowledgement mismatch for Lecture ${id}.`);
    meta.docRevisions ||= {};
    meta.docHashes ||= {};
    meta.docRevisions[id] = Number(data.revision || base + 1);
    meta.docHashes[id] = pushedHash;
    meta.lastSync = nowIso();

    // Do not clear a newer local edit that landed while the cloud request was running.
    const latestDoc = await idbGet(STORES.documents, id);
    const unchanged = quickHash(documentForCloud(latestDoc || {})) === pushedHash && queue.saveIds.docs[id] === saveId;
    queue.dirtyDocs = unchanged
      ? removeValue(queue.dirtyDocs, id)
      : unique([...queue.dirtyDocs, id]);
    if (unchanged) delete queue.saveIds.docs[id];
    await recordCloudConfirmation(saveId, 'document', id, meta.docRevisions[id]);
    return true;
  }

  async function deleteDocumentRemote(id, queue, meta, attempt = 0) {
    const saveId = queue.saveIds?.deletedDocs?.[id] || newSaveId('document-delete', id);
    queue.saveIds.deletedDocs[id] = saveId;
    const base = Number(meta.docRevisions?.[id] || 0);
    if (!base) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      if (!remoteResult.data) {
        // There is no server row left to stamp; absence itself is the durable
        // acknowledgement for a delete operation.
        queue.deletedDocs = removeValue(queue.deletedDocs, id);
        if (queue.saveIds.deletedDocs[id] === saveId) delete queue.saveIds.deletedDocs[id];
        await recordCloudConfirmation(saveId, 'document-delete', id, 0);
        return true;
      }
      if (remoteResult.data.deleted_at) {
        if (String(remoteResult.data.save_id || '') !== String(saveId)) {
          if (attempt >= 3) throw new Error(`Cloud could not acknowledge deleted Lecture ${id}.`);
          meta.docRevisions[id] = Number(remoteResult.data.revision || 0);
          return deleteDocumentRemote(id, queue, meta, attempt + 1);
        }
        queue.deletedDocs = removeValue(queue.deletedDocs, id);
        if (queue.saveIds.deletedDocs[id] === saveId) delete queue.saveIds.deletedDocs[id];
        await recordCloudConfirmation(saveId, 'document-delete', id, Number(remoteResult.data.revision || 0));
        return true;
      }
      meta.docRevisions[id] = Number(remoteResult.data.revision || 0);
      return deleteDocumentRemote(id, queue, meta, attempt + 1);
    }
    const { data, error } = await client.from(CONFIG.documentTable).update({ document: null, revision: base + 1, save_id: saveId, updated_at: nowIso(), updated_by_device: deviceId(), deleted_at: nowIso() })
      .eq('user_id', currentUserId).eq('document_id', id).eq('revision', base).select().maybeSingle();
    if (error) throw error;
    if (!data) {
      const remoteResult = await client.from(CONFIG.documentTable).select('*').eq('user_id', currentUserId).eq('document_id', id).maybeSingle();
      if (remoteResult.error) throw remoteResult.error;
      if (!remoteResult.data) {
        meta.docRevisions[id] = 0;
        queue.deletedDocs = removeValue(queue.deletedDocs, id);
        if (queue.saveIds.deletedDocs[id] === saveId) delete queue.saveIds.deletedDocs[id];
        await recordCloudConfirmation(saveId, 'document-delete', id, 0);
        return true;
      }
      if (remoteResult.data.deleted_at) {
        if (String(remoteResult.data.save_id || '') !== String(saveId)) {
          if (attempt >= 3) throw new Error(`Cloud could not acknowledge deleted Lecture ${id}.`);
          meta.docRevisions[id] = Number(remoteResult.data.revision || base);
          return deleteDocumentRemote(id, queue, meta, attempt + 1);
        }
        meta.docRevisions[id] = Number(remoteResult.data.revision || base);
        queue.deletedDocs = removeValue(queue.deletedDocs, id);
        if (queue.saveIds.deletedDocs[id] === saveId) delete queue.saveIds.deletedDocs[id];
        await recordCloudConfirmation(saveId, 'document-delete', id, meta.docRevisions[id]);
        return true;
      }
      await createConflict({ kind: 'document', id, local: null, localDeleting: true, remote: remoteResult.data });
      return false;
    }
    if (data.save_id && String(data.save_id) !== String(saveId)) throw new Error(`Cloud acknowledgement mismatch for deleted Lecture ${id}.`);
    meta.docRevisions[id] = Number(data.revision || base + 1);
    meta.docHashes ||= {};
    meta.docHashes[id] = quickHash({ deleted: true });
    if (queue.saveIds.deletedDocs[id] === saveId) {
      queue.deletedDocs = removeValue(queue.deletedDocs, id);
      delete queue.saveIds.deletedDocs[id];
    }
    await recordCloudConfirmation(saveId, 'document-delete', id, meta.docRevisions[id]);
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
      emitStatus({
        phase: 'synced',
        message: 'Cloud confirmed.',
        lastSync: meta.lastSync,
        lastLocalSaveAt: meta.lastLocalSaveAt,
        lastLocalSaveId: meta.lastLocalSaveId,
        lastCloudConfirmedAt: meta.lastCloudConfirmedAt,
        lastCloudConfirmedSaveId: meta.lastCloudConfirmedSaveId,
        pendingChanges: 0,
        lastError: null,
        retryAt: null,
      });
      return true;
    }

    flushPromise = (async () => {
      emitStatus({
        phase: 'syncing',
        message: 'Uploading saved changes for cloud confirmation…',
        pendingChanges: queueCount(currentQueue),
      });
      const queue = await getQueue();
      const meta = await getMeta();
      clearGlobalRetry(queue);
      try {
        // PDFs are uploaded first because the exact versioned object path is written
        // into the corresponding Lecture document before that document is confirmed.
        for (const key of [...queue.dirtyBlobs]) {
          const saveId = queue.saveIds?.blobs?.[key] || newSaveId('blob', key);
          queue.saveIds.blobs[key] = saveId;
          const result = await uploadBlob(key);
          if (result.changedDocument && result.documentId) {
            const docId = String(result.documentId);
            queue.dirtyDocs = unique([...queue.dirtyDocs, docId]);
            if (!queue.saveIds.docs[docId]) {
              const docSaveId = newSaveId('document', docId);
              queue.saveIds.docs[docId] = docSaveId;
              const changedDoc = await idbGet(STORES.documents, docId);
              await recordLocalSave(docSaveId, 'document', docId, quickHash(documentForCloud(changedDoc || {})));
              if (changedDoc) await appendLocalHistory('document', docId, documentForCloud(changedDoc), docSaveId);
            }
          }
          if (queue.saveIds.blobs[key] === saveId) {
            queue.dirtyBlobs = removeValue(queue.dirtyBlobs, key);
            delete queue.saveIds.blobs[key];
          }
          await recordCloudConfirmation(saveId, 'blob', key, null);
          await setQueue(queue);
        }

        // Everyday app data is granular: profile, course, schedule, notes, etc.
        // A small change no longer rewrites the entire workspace.
        for (const key of [...queue.dirtyEntities]) {
          if (!(await pushEntity(String(key), queue, meta))) return false;
          await setMeta(meta);
          await setQueue(queue);
        }
        for (const key of [...queue.deletedEntities]) {
          if (!(await pushEntity(String(key), queue, meta))) return false;
          await setMeta(meta);
          await setQueue(queue);
        }

        for (const id of [...queue.dirtyDocs]) {
          if (!(await pushDocument(String(id), queue, meta))) return false;
          await setMeta(meta);
          await setQueue(queue);
        }
        for (const id of [...queue.deletedDocs]) {
          if (!(await deleteDocumentRemote(String(id), queue, meta))) return false;
          await setMeta(meta);
          await setQueue(queue);
        }

        // Whole-workspace state is now only a periodic/manual recovery checkpoint.
        if (queue.stateDirty) {
          if (!(await pushState(queue, meta))) return false;
          await setMeta(meta);
          await setQueue(queue);
        }

        for (const key of [...queue.deletedBlobs]) {
          const saveId = queue.saveIds?.deletedBlobs?.[key] || newSaveId('blob-delete', key);
          queue.saveIds.deletedBlobs[key] = saveId;
          await deleteBlobRemote(key);
          if (queue.saveIds.deletedBlobs[key] === saveId) {
            queue.deletedBlobs = removeValue(queue.deletedBlobs, key);
            delete queue.saveIds.deletedBlobs[key];
          }
          await recordCloudConfirmation(saveId, 'blob-delete', key, null);
          await setQueue(queue);
        }

        clearGlobalRetry(queue);
        meta.lastSync = nowIso();
        await setMeta(meta);
        await setQueue(queue);
        const remaining = queueCount(queue);
        if (remaining) {
          emitStatus({
            phase: 'pending',
            message: `${remaining} newer local change${remaining === 1 ? '' : 's'} still awaiting cloud confirmation.`,
            lastSync: meta.lastSync,
            conflict: false,
            pendingChanges: remaining,
            lastError: null,
            retryAt: null,
          });
          scheduleFlush();
        } else {
          const latestMeta = await getMeta();
          emitStatus({
            phase: 'synced',
            message: 'Cloud confirmed.',
            lastSync: latestMeta.lastSync,
            lastLocalSaveAt: latestMeta.lastLocalSaveAt,
            lastLocalSaveId: latestMeta.lastLocalSaveId,
            lastCloudConfirmedAt: latestMeta.lastCloudConfirmedAt,
            lastCloudConfirmedSaveId: latestMeta.lastCloudConfirmedSaveId,
            conflict: false,
            pendingChanges: 0,
            lastError: null,
            retryAt: null,
          });
        }
        return true;
      } catch (err) {
        console.error('Cloud sync failed:', err);
        const q = await getQueue().catch(() => queue);
        const retry = await setGlobalRetry(q, err).catch(() => null);
        emitStatus({
          phase: navigator.onLine ? 'pending' : 'offline',
          message: navigator.onLine
            ? `Cloud confirmation delayed — ${queueCount(q)} local change${queueCount(q) === 1 ? '' : 's'} safe; retrying automatically.`
            : `Offline — ${queueCount(q)} change${queueCount(q) === 1 ? '' : 's'} waiting to sync.`,
          pendingChanges: queueCount(q),
          lastError: String(err?.message || err),
          retryAt: retry?.nextRetryAt || null,
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
    const meta = await getMeta();
    // In granular mode app_state is a recovery checkpoint, not the live data channel.
    if (Object.keys(meta.entityRevisions || {}).length) {
      await acceptRemoteStateRevision(row, { apply: false, notify: false });
      return;
    }
    const result = await reconcileRemoteStateRow(row, { notify: true });
    if (result !== 'conflict') {
      const queue = await getQueue();
      if (queue.stateDirty) scheduleFlush();
      else emitStatus({ phase: 'synced', message: result === 'merged-pending' ? 'Merged another device; finishing sync…' : 'Updated from another device.', lastSync: nowIso(), pendingChanges: queueCount(queue) });
    }
  }

  async function handleRealtimeEntity(payload) {
    const row = payload.new || payload.old;
    const key = String(row?.entity_key || '');
    if (!key || row.updated_by_device === deviceId()) return;
    const result = await reconcileRemoteEntityRow(row, { notify: true });
    if (result !== 'conflict') {
      const queue = await getQueue();
      const pending = queueCount(queue);
      emitStatus({
        phase: pending ? 'pending' : 'synced',
        message: pending ? 'Another device update merged; local changes still await cloud confirmation.' : 'Updated from another device.',
        lastSync: nowIso(),
        pendingChanges: pending,
      });
      if (pending) scheduleFlush();
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
        realtimeSerial = realtimeSerial.then(() => handleRealtimeState(payload)).catch(err => console.error('Realtime checkpoint sync failed:', err));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: CONFIG.entityTable, filter: `user_id=eq.${uid}` }, payload => {
        realtimeSerial = realtimeSerial.then(() => handleRealtimeEntity(payload)).catch(err => console.error('Realtime entity sync failed:', err));
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

  function stopBackgroundSyncTimers() {
    clearTimeout(flushTimer); flushTimer = null;
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(watchdogTimer); watchdogTimer = null;
    clearTimeout(checkpointTimer); checkpointTimer = null;
  }

  function bindAuthListener(c) {
    if (authListenerBound) return;
    authListenerBound = true;
    c.auth.onAuthStateChange((event, newSession) => {
      session = newSession || null;
      const user = newSession?.user || null;
      if (!user) {
        stopBackgroundSyncTimers();
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
    stopBackgroundSyncTimers();
    session = null; currentUserId = null; currentUserEmail = null; initialChoice = null; currentConflict = null;
    emitStatus({ signedIn: false, phase: 'signed-out', message: 'Signed out. Local data remains on this device.', needsChoice: false, conflict: false, pendingChanges: 0 });
  }
  async function resetPassword(email) {
    const c = await ensureClient(); if (!c) throw new Error('Cloud library is unavailable.');
    const { error } = await c.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo: AUTH_REDIRECT_URL });
    if (error) throw error;
    return true;
  }

  async function retrySync() {
    const queue = await getQueue(currentUserId);
    clearGlobalRetry(queue);
    await setQueue(queue, currentUserId, { emit: true });
    emitStatus({ phase: queueCount(queue) ? 'pending' : 'synced', message: queueCount(queue) ? 'Retrying cloud confirmation now…' : 'Cloud confirmed.', lastError: null, retryAt: null });
    return flushNow();
  }

  async function verifyCloudCopy() {
    if (!currentUserId || !client || !session) throw new Error('Sign in first.');
    if (!navigator.onLine) throw new Error('Internet connection is required to verify the cloud copy.');
    await flushNow();
    const queue = await getQueue();
    if (queueCount(queue)) {
      return {
        ok: false,
        pendingChanges: queueCount(queue),
        message: `${queueCount(queue)} local change${queueCount(queue) === 1 ? '' : 's'} still await cloud confirmation.`,
        entityMismatches: [],
        documentMismatches: [],
      };
    }

    const [rows, docRows] = await Promise.all([fetchRemoteEntities(), fetchRemoteDocuments()]);
    const remoteEntities = activeEntitySnapshotFromRows(rows);
    const localFull = await idbGet(STORES.meta, 'state');
    const localEntities = stateToEntities(localFull || {});
    const entityMismatches = [];
    const entityKeys = new Set([...Object.keys(localEntities), ...Object.keys(remoteEntities)]);
    for (const key of entityKeys) {
      const local = localEntities[key];
      const remote = remoteEntities[key];
      if (!local || !remote || !sameValue(local.payload, remote.payload)) entityMismatches.push(key);
    }

    const remoteDocs = new Map(docRows.map(row => [String(row.document_id), row]));
    const localDocs = new Map(await idbEntries(STORES.documents));
    const documentMismatches = [];
    const docKeys = new Set([...localDocs.keys(), ...remoteDocs.keys()]);
    for (const key of docKeys) {
      const local = localDocs.get(key);
      const remote = remoteDocs.get(key);
      if (!local) {
        if (remote && !remote.deleted_at && remote.document) documentMismatches.push(key);
        continue;
      }
      if (!remote || remote.deleted_at || !remote.document || !sameValue(documentForCloud(local), documentForCloud(remote.document))) documentMismatches.push(key);
    }

    const ok = entityMismatches.length === 0 && documentMismatches.length === 0;
    return {
      ok,
      pendingChanges: 0,
      checkedAt: nowIso(),
      entityCount: Object.keys(localEntities).length,
      documentCount: localDocs.size,
      entityMismatches,
      documentMismatches,
      message: ok ? 'Local data and the cloud copy match.' : 'The cloud copy does not fully match this device.',
    };
  }

  async function getDocumentRecoveryHistory(materialId, limit = 10) {
    const id = String(materialId);
    const local = await getLocalHistory('document', id, limit);
    let cloudRows = [];
    if (currentUserId && client && navigator.onLine) {
      try { cloudRows = await fetchCloudHistory('document', id, limit); }
      catch (err) { console.warn('Could not load cloud recovery history:', err); }
    }
    const localItems = local.map((entry, index) => ({
      source: 'local',
      token: `${entry.savedAt || ''}|${entry.hash || ''}|${index}`,
      savedAt: entry.savedAt,
      saveId: entry.saveId || null,
      revision: null,
      title: entry.payload?.title || 'Untitled Document',
      deviceId: entry.deviceId || null,
    }));
    const cloudItems = cloudRows.map(row => ({
      source: 'cloud',
      token: String(row.id),
      savedAt: row.saved_at,
      saveId: row.save_id || null,
      revision: Number(row.revision || 0),
      title: row.payload?.title || 'Untitled Document',
      deviceId: row.source_device || null,
    }));
    return [...localItems, ...cloudItems]
      .sort((a, b) => Date.parse(b.savedAt || 0) - Date.parse(a.savedAt || 0))
      .slice(0, Math.max(1, Math.min(Number(limit) || 10, 20)));
  }

  async function restoreDocumentVersion(materialId, source, token) {
    const id = String(materialId);
    const current = await idbGet(STORES.documents, id);
    if (current) await appendLocalHistory('document', id, documentForCloud(current), null, { force: true });

    let payload = null;
    if (source === 'local') {
      const local = await getLocalHistory('document', id, MAX_LOCAL_HISTORY);
      const prefix = String(token || '').split('|').slice(0, 2).join('|');
      const found = local.find(entry => `${entry.savedAt || ''}|${entry.hash || ''}` === prefix);
      payload = found?.payload || null;
    } else if (source === 'cloud') {
      if (!currentUserId || !client || !navigator.onLine) throw new Error('Cloud recovery requires an internet connection.');
      const { data, error } = await client.from(CONFIG.historyTable)
        .select('id,payload,item_kind,item_id')
        .eq('user_id', currentUserId)
        .eq('id', Number(token))
        .eq('item_kind', 'document')
        .eq('item_id', id)
        .maybeSingle();
      if (error) throw error;
      payload = data?.payload || null;
    } else {
      throw new Error('Unknown recovery source.');
    }
    if (!payload) throw new Error('That recovery version is no longer available.');

    const restored = restoreLocalDocumentUi(payload, current || {});
    restored.updated_at = nowIso();
    await idbSet(STORES.documents, id, restored);
    await idbSet(STORES.meta, lectureRecoveryKey(id), { document: clone(restored), saved_at: nowIso() });

    // Keep the Study Material card title consistent with the restored Lecture.
    const fullState = await idbGet(STORES.meta, 'state');
    let stateChanged = false;
    for (const profile of Object.values(fullState?.profiles || {})) {
      for (const course of Object.values(profile?.courses || {})) {
        const material = (course.materials || []).find(item => String(item.id) === id);
        if (material) {
          material.title = restored.title || material.title || 'Untitled Document';
          material.updated_at = restored.updated_at;
          stateChanged = true;
        }
      }
    }
    if (stateChanged) await idbSet(STORES.meta, 'state', fullState);

    await markDocumentDirty(id);
    if (stateChanged) await markStateDirty();
    emitRemote({ kind: 'document', documentId: id, recovered: true });
    return { ok: true, title: restored.title || 'Untitled Document', restoredAt: restored.updated_at };
  }

  async function getSyncDiagnostics() {
    const meta = currentUserId ? await getMeta() : blankMeta(null);
    const queue = await getQueue(currentUserId);
    const saveLog = await getSaveLog(currentUserId);
    const localFull = await idbGet(STORES.meta, 'state');
    const localEntities = stateToEntities(localFull || {});
    const localDocs = await idbEntries(STORES.documents);
    let storagePersistent = null;
    try { if (navigator.storage?.persisted) storagePersistent = await navigator.storage.persisted(); } catch (_err) {}
    return {
      deviceId: deviceId(),
      userId: currentUserId,
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      syncMode: 'granular-v2',
      stateRevision: Number(meta.stateRevision || 0),
      entityRevisionCount: Object.keys(meta.entityRevisions || {}).length,
      documentRevisionCount: Object.keys(meta.docRevisions || {}).length,
      localEntityCount: Object.keys(localEntities).length,
      localDocumentCount: localDocs.length,
      pendingChanges: queueCount(queue),
      queue: clone(queue),
      lastSync: meta.lastSync,
      lastLocalSaveAt: meta.lastLocalSaveAt,
      lastLocalSaveId: meta.lastLocalSaveId,
      lastCloudConfirmedAt: meta.lastCloudConfirmedAt,
      lastCloudConfirmedSaveId: meta.lastCloudConfirmedSaveId,
      lastCheckpointAt: meta.lastCheckpointAt,
      retry: clone(queue.retry?.global || null),
      recentSaves: clone(saveLog.slice(-20).reverse()),
      online: navigator.onLine,
      storagePersistent,
      conflict: clone(currentConflict),
      status: clone(status),
    };
  }

  function getStatus() { return clone(status); }
  function getUser() { return session?.user ? { id: session.user.id, email: session.user.email || '' } : null; }
  function getInitialChoice() { return initialChoice ? { exists: true } : null; }
  function getConflict() {
    if (!currentConflict) return null;
    const out = clone(currentConflict);
    if (out.kind === 'state' || out.kind === 'entity') out.conflictPaths = (out.conflictEntries || []).map(entry => pathLabel(entry.path)).filter(Boolean);
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
    recoverUnqueuedLocalChanges,
    ensurePdfBlob,
    getSyncDiagnostics,
    retrySync,
    verifyCloudCopy,
    getDocumentRecoveryHistory,
    restoreDocumentVersion,
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
      stateToEntities,
      stateFromEntitySnapshot,
      applyEntityRowToState,
      applyPathChoice,
    }),
  });
})();
