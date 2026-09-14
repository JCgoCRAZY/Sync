"use strict";

(() => {
  const ARCHIVE_KEY = "ushub-event-persistence-v1";
  let committedEvents = null;
  let repairSerial = Promise.resolve();

  function clone(value) {
    if (value == null) return value;
    try { return structuredClone(value); }
    catch (_) { return JSON.parse(JSON.stringify(value)); }
  }

  function stableStringify(value) {
    const normalize = item => {
      if (item === null || typeof item !== "object") return item;
      if (Array.isArray(item)) return item.map(normalize);
      const out = {};
      for (const key of Object.keys(item).sort()) out[key] = normalize(item[key]);
      return out;
    };
    try { return JSON.stringify(normalize(value)); }
    catch (_) { return ""; }
  }

  function same(a, b) { return stableStringify(a) === stableStringify(b); }
  function isoNow() { return typeof nowIso === "function" ? nowIso() : new Date().toISOString(); }

  function readArchive() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "null");
      return parsed && typeof parsed === "object" ? parsed : {version:1, profiles:{}};
    } catch (_) {
      return {version:1, profiles:{}};
    }
  }

  function writeArchive(archive) {
    try {
      archive.version = 1;
      archive.updated_at = isoNow();
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
    } catch (error) {
      console.warn("Event recovery archive could not be updated", error);
    }
  }

  function eventSnapshot(fullState) {
    const out = {profiles:{}};
    for (const [profileId, profile] of Object.entries(fullState?.profiles || {})) {
      const courses = {};
      for (const [courseId, course] of Object.entries(profile?.courses || {})) {
        courses[courseId] = clone(Array.isArray(course?.notifications) ? course.notifications : []);
      }
      out.profiles[profileId] = {
        courses,
        personal_events: clone(Array.isArray(profile?.schedule?.personal_events) ? profile.schedule.personal_events : [])
      };
    }
    return out;
  }

  function byId(items) {
    return new Map((Array.isArray(items) ? items : [])
      .filter(item => item && item.id != null && String(item.id))
      .map(item => [String(item.id), item]));
  }

  function ensureArchiveProfile(archive, profileId) {
    archive.profiles ||= {};
    archive.profiles[profileId] ||= {courses:{}, course_tombstones:{}, personal_events:{}, personal_tombstones:{}};
    const p = archive.profiles[profileId];
    p.courses ||= {};
    p.course_tombstones ||= {};
    p.personal_events ||= {};
    p.personal_tombstones ||= {};
    return p;
  }

  function noteExplicitDeletions(beforeSnapshot, fullState) {
    if (!beforeSnapshot || !fullState) return false;
    let changed = false;
    const stamp = isoNow();
    for (const [profileId, profile] of Object.entries(fullState.profiles || {})) {
      const beforeProfile = beforeSnapshot.profiles?.[profileId];
      if (!beforeProfile) continue;
      for (const [courseId, course] of Object.entries(profile.courses || {})) {
        const before = byId(beforeProfile.courses?.[courseId] || []);
        const after = byId(course.notifications || []);
        if (!same([...before.values()], [...after.values()])) course.updated_at = stamp;
        for (const id of before.keys()) {
          if (after.has(id)) continue;
          course.event_tombstones ||= {};
          if (!course.event_tombstones[id]) {
            course.event_tombstones[id] = stamp;
            changed = true;
          }
        }
      }

      const beforePersonal = byId(beforeProfile.personal_events || []);
      const afterPersonal = byId(profile.schedule?.personal_events || []);
      if (profile.schedule && !same([...beforePersonal.values()], [...afterPersonal.values()])) {
        profile.schedule.events_updated_at = stamp;
      }
      for (const id of beforePersonal.keys()) {
        if (afterPersonal.has(id) || !profile.schedule) continue;
        profile.schedule.personal_event_tombstones ||= {};
        if (!profile.schedule.personal_event_tombstones[id]) {
          profile.schedule.personal_event_tombstones[id] = stamp;
          changed = true;
        }
      }
    }
    return changed;
  }

  function archiveCurrentEvents(fullState) {
    if (!fullState) return;
    const archive = readArchive();
    const validProfiles = new Set(Object.keys(fullState.profiles || {}));
    for (const profileId of Object.keys(archive.profiles || {})) {
      if (!validProfiles.has(profileId)) delete archive.profiles[profileId];
    }

    for (const [profileId, profile] of Object.entries(fullState.profiles || {})) {
      const ap = ensureArchiveProfile(archive, profileId);
      const validCourses = new Set(Object.keys(profile.courses || {}));
      for (const courseId of Object.keys(ap.courses)) if (!validCourses.has(courseId)) delete ap.courses[courseId];
      for (const courseId of Object.keys(ap.course_tombstones)) if (!validCourses.has(courseId)) delete ap.course_tombstones[courseId];

      for (const [courseId, course] of Object.entries(profile.courses || {})) {
        ap.courses[courseId] ||= {};
        ap.course_tombstones[courseId] ||= {};
        for (const [id, deletedAt] of Object.entries(course.event_tombstones || {})) {
          ap.course_tombstones[courseId][id] = deletedAt || isoNow();
          delete ap.courses[courseId][id];
        }
        for (const event of course.notifications || []) {
          if (!event?.id) continue;
          const id = String(event.id);
          if (ap.course_tombstones[courseId][id]) continue;
          ap.courses[courseId][id] = clone(event);
        }
      }

      for (const [id, deletedAt] of Object.entries(profile.schedule?.personal_event_tombstones || {})) {
        ap.personal_tombstones[id] = deletedAt || isoNow();
        delete ap.personal_events[id];
      }
      for (const event of profile.schedule?.personal_events || []) {
        if (!event?.id) continue;
        const id = String(event.id);
        if (ap.personal_tombstones[id]) continue;
        ap.personal_events[id] = clone(event);
      }
    }
    writeArchive(archive);
  }

  function reconcileArchive(fullState) {
    if (!fullState) return false;
    const archive = readArchive();
    let changed = false;
    for (const [profileId, profile] of Object.entries(fullState.profiles || {})) {
      const ap = archive.profiles?.[profileId];
      if (!ap) continue;

      for (const [courseId, course] of Object.entries(profile.courses || {})) {
        const savedEvents = ap.courses?.[courseId] || {};
        const savedTombstones = ap.course_tombstones?.[courseId] || {};
        course.notifications ||= [];
        course.event_tombstones ||= {};
        let courseChanged = false;

        for (const [id, deletedAt] of Object.entries(savedTombstones)) {
          if (!course.event_tombstones[id]) {
            course.event_tombstones[id] = deletedAt;
            courseChanged = true;
          }
        }

        const tombstones = new Set(Object.keys(course.event_tombstones || {}));
        const filtered = course.notifications.filter(event => !tombstones.has(String(event?.id || "")));
        if (filtered.length !== course.notifications.length) {
          course.notifications = filtered;
          courseChanged = true;
        }
        const current = byId(course.notifications);
        for (const [id, archivedEvent] of Object.entries(savedEvents)) {
          if (tombstones.has(id) || current.has(id)) continue;
          course.notifications.push(clone(archivedEvent));
          current.set(id, archivedEvent);
          courseChanged = true;
        }
        if (courseChanged) {
          course.updated_at = isoNow();
          changed = true;
        }
      }

      if (profile.schedule) {
        profile.schedule.personal_events ||= [];
        profile.schedule.personal_event_tombstones ||= {};
        let scheduleChanged = false;
        for (const [id, deletedAt] of Object.entries(ap.personal_tombstones || {})) {
          if (!profile.schedule.personal_event_tombstones[id]) {
            profile.schedule.personal_event_tombstones[id] = deletedAt;
            scheduleChanged = true;
          }
        }
        const tombstones = new Set(Object.keys(profile.schedule.personal_event_tombstones || {}));
        const filtered = profile.schedule.personal_events.filter(event => !tombstones.has(String(event?.id || "")));
        if (filtered.length !== profile.schedule.personal_events.length) {
          profile.schedule.personal_events = filtered;
          scheduleChanged = true;
        }
        const current = byId(profile.schedule.personal_events);
        for (const [id, archivedEvent] of Object.entries(ap.personal_events || {})) {
          if (tombstones.has(id) || current.has(id)) continue;
          profile.schedule.personal_events.push(clone(archivedEvent));
          current.set(id, archivedEvent);
          scheduleChanged = true;
        }
        if (scheduleChanged) {
          profile.schedule.events_updated_at = isoNow();
          changed = true;
        }
      }
    }
    archiveCurrentEvents(fullState);
    return changed;
  }

  async function persistRepairedState({sync = false, rerender = false, freshFromDisk = false} = {}) {
    if (typeof state === "undefined" || !state || typeof idbSet !== "function" || typeof STORES === "undefined") return false;
    let target = state;
    if (freshFromDisk && typeof idbGet === "function") {
      try { target = (await idbGet(STORES.meta, "state")) || state; }
      catch (_) { target = state; }
    }

    const changed = reconcileArchive(target);
    if (changed) {
      await idbSet(STORES.meta, "state", clone(target));
      // Never replace the entire in-memory workspace here: the user may have
      // other unsaved edits. Reconcile only the protected Event data into it.
      if (target !== state) reconcileArchive(state);
      if (sync) {
        try { await cloudApi()?.markStateDirty?.(); }
        catch (error) { console.warn("Recovered Events will sync later", error); }
      }
      if (rerender && typeof render === "function") render();
    }
    committedEvents = eventSnapshot(target);
    return changed;
  }

  if (typeof queueSave === "function") {
    const originalQueueSave = queueSave;
    queueSave = function hardenedEventQueueSave(cloudDirty = true) {
      if (cloudDirty && typeof state !== "undefined" && state) {
        noteExplicitDeletions(committedEvents, state);
        archiveCurrentEvents(state);
      }
      return originalQueueSave(cloudDirty);
    };
  }

  if (typeof saveStateNow === "function") {
    const originalSaveStateNow = saveStateNow;
    saveStateNow = async function hardenedEventSaveStateNow(show = true, cloudDirty = false) {
      const result = await originalSaveStateNow(show, cloudDirty);
      // A course entity can receive a newer remote revision in the tiny interval
      // between the IndexedDB state commit and its cloud-outbox marker. Lecture
      // documents already guard this race internally; Events now get an independent
      // archive/tombstone pass so a remote course snapshot cannot silently erase them.
      const task = repairSerial.then(() => persistRepairedState({sync:true, rerender:false, freshFromDisk:true}));
      repairSerial = task.catch(error => console.error("Event save repair failed", error));
      await task;
      return result;
    };
  }

  if (typeof loadState === "function") {
    const originalLoadState = loadState;
    loadState = async function hardenedEventLoadState(...args) {
      const result = await originalLoadState(...args);
      await persistRepairedState({sync:false, rerender:false});
      committedEvents = eventSnapshot(state);
      return result;
    };
  }

  if (typeof reloadStateFromDisk === "function") {
    const originalReloadStateFromDisk = reloadStateFromDisk;
    reloadStateFromDisk = async function hardenedEventReloadStateFromDisk(...args) {
      const result = await originalReloadStateFromDisk(...args);
      const repaired = await persistRepairedState({sync:true, rerender:true});
      if (!repaired) committedEvents = eventSnapshot(state);
      return result;
    };
  }

  window.addEventListener("pagehide", () => {
    try { if (typeof state !== "undefined" && state) archiveCurrentEvents(state); } catch (_) {}
  });
})();
