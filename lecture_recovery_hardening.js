"use strict";

(() => {
  const CLOUD_PROJECT_URL = "https://pvjsxskkwnjpwukrilos.supabase.co";
  const CLOUD_PUBLISHABLE_KEY = "sb_publishable_sKdJQWOKviE3b2JWNDHSHA_38ez9kdC";
  const CLOUD_HISTORY_LIMIT = 500;
  let recoveryClientPromise = null;
  let recoveryScanCache = null;

  function cloneValue(value) {
    return value == null ? value : structuredClone(value);
  }

  function safeTime(value) {
    const ms = Date.parse(String(value || ""));
    return Number.isFinite(ms) ? ms : 0;
  }

  function shortId(value) {
    const id = String(value || "");
    return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
  }

  function ensureTrash(profile) {
    if (!Array.isArray(profile.lecture_trash)) profile.lecture_trash = [];
    return profile.lecture_trash;
  }

  // Add the Trash field before normal startup normalization finishes. Because this
  // script is deferred after app.js, the patched normalizer runs when init() loads
  // IndexedDB at DOMContentLoaded.
  const baseNormalizeState = normalizeState;
  normalizeState = function recoveryNormalizeState(raw) {
    const out = baseNormalizeState(raw);
    for (const profile of Object.values(out.profiles || {})) ensureTrash(profile);
    return out;
  };

  function activeLectureRefs() {
    const byId = new Map();
    for (const [profileId, profile] of Object.entries(state?.profiles || {})) {
      for (const [courseId, course] of Object.entries(profile?.courses || {})) {
        for (const material of course?.materials || []) {
          const id = String(material?.id || "");
          if (!id) continue;
          byId.set(id, {
            profileId,
            courseId,
            courseCode: course.code || "COURSE",
            material: cloneValue(material),
            status: "active",
          });
        }
      }
    }
    return byId;
  }

  function trashedLectureRefs() {
    const byId = new Map();
    for (const [profileId, profile] of Object.entries(state?.profiles || {})) {
      for (const entry of ensureTrash(profile)) {
        const id = String(entry?.id || entry?.material?.id || "");
        if (!id) continue;
        byId.set(id, {
          ...cloneValue(entry),
          id,
          profileId: entry.profile_id || profileId,
          courseId: entry.course_id || null,
          courseCode: entry.course_code || "Unknown course",
          material: cloneValue(entry.material || { id }),
          status: "trash",
        });
      }
    }
    return byId;
  }

  function candidateMapEntry(map, id) {
    id = String(id || "");
    if (!id) return null;
    if (!map.has(id)) {
      map.set(id, {
        id,
        title: "",
        updatedAt: "",
        activeRef: null,
        trashRef: null,
        localCurrent: null,
        cloudCurrent: null,
        localHistory: [],
        cloudHistory: [],
        deletedInCloud: false,
      });
    }
    return map.get(id);
  }

  function adoptTitle(candidate, payload, fallback = "") {
    const title = String(payload?.title || fallback || "").trim();
    if (title && (!candidate.title || candidate.title === "Untitled Document")) candidate.title = title;
    const updated = payload?.updated_at || payload?.created_at || "";
    if (safeTime(updated) > safeTime(candidate.updatedAt)) candidate.updatedAt = updated;
  }

  async function scanLocalRecovery(map) {
    const [documents, metaEntries] = await Promise.all([
      idbEntries(STORES.documents),
      idbEntries(STORES.meta),
    ]);

    for (const [rawId, document] of documents) {
      const id = String(rawId);
      const candidate = candidateMapEntry(map, id);
      candidate.localCurrent = cloneValue(document);
      adoptTitle(candidate, document);
    }

    for (const [rawKey, value] of metaEntries) {
      const key = String(rawKey);
      if (key.startsWith("lecture-history:")) {
        const id = key.slice("lecture-history:".length);
        const candidate = candidateMapEntry(map, id);
        for (const entry of Array.isArray(value) ? value : []) {
          if (!entry?.payload) continue;
          candidate.localHistory.push({
            source: "local-history",
            savedAt: entry.savedAt || entry.saved_at || "",
            payload: cloneValue(entry.payload),
            token: `${entry.savedAt || ""}|${entry.hash || ""}`,
          });
          adoptTitle(candidate, entry.payload);
        }
      } else if (key.startsWith("lecture-recovery:")) {
        const id = key.slice("lecture-recovery:".length);
        const document = value?.document;
        if (!document) continue;
        const candidate = candidateMapEntry(map, id);
        candidate.localHistory.push({
          source: "local-recovery",
          savedAt: value.saved_at || document.updated_at || "",
          payload: cloneValue(document),
          token: `recovery|${value.saved_at || ""}`,
        });
        adoptTitle(candidate, document);
      }
    }
  }

  async function recoverySupabaseClient() {
    if (recoveryClientPromise) return recoveryClientPromise;
    recoveryClientPromise = (async () => {
      if (!window.supabase?.createClient) return null;
      const client = window.supabase.createClient(CLOUD_PROJECT_URL, CLOUD_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        realtime: { params: { eventsPerSecond: 1 } },
      });
      const { data, error } = await client.auth.getSession();
      if (error || !data?.session) return null;
      return client;
    })().catch(error => {
      console.warn("Recovery cloud client unavailable", error);
      recoveryClientPromise = null;
      return null;
    });
    return recoveryClientPromise;
  }

  async function scanCloudRecovery(map) {
    const user = cloudApi()?.getUser?.();
    if (!user?.id || !navigator.onLine) return { available: false, reason: "Cloud scan unavailable while signed out or offline." };

    const client = await recoverySupabaseClient();
    if (!client) return { available: false, reason: "Cloud recovery session is unavailable." };

    const [docsResult, historyResult] = await Promise.all([
      client.from("app_documents")
        .select("document_id,document,revision,updated_at,deleted_at")
        .eq("user_id", user.id),
      client.from("app_history")
        .select("id,item_kind,item_id,revision,save_id,payload,deleted_at,saved_at,source_device")
        .eq("user_id", user.id)
        .eq("item_kind", "document")
        .order("saved_at", { ascending: false })
        .limit(CLOUD_HISTORY_LIMIT),
    ]);

    if (docsResult.error) throw docsResult.error;
    if (historyResult.error) throw historyResult.error;

    for (const row of docsResult.data || []) {
      const id = String(row.document_id || "");
      if (!id) continue;
      const candidate = candidateMapEntry(map, id);
      candidate.deletedInCloud = Boolean(row.deleted_at || !row.document);
      if (row.document) {
        candidate.cloudCurrent = cloneValue(row.document);
        adoptTitle(candidate, row.document);
      }
      if (safeTime(row.updated_at) > safeTime(candidate.updatedAt)) candidate.updatedAt = row.updated_at || candidate.updatedAt;
    }

    for (const row of historyResult.data || []) {
      const id = String(row.item_id || "");
      if (!id || !row.payload) continue;
      const candidate = candidateMapEntry(map, id);
      candidate.cloudHistory.push({
        source: "cloud-history",
        id: row.id,
        savedAt: row.saved_at || "",
        revision: row.revision,
        payload: cloneValue(row.payload),
        token: String(row.id),
      });
      adoptTitle(candidate, row.payload);
    }

    return { available: true, reason: "" };
  }

  async function scanRecoveryCandidates({ force = false } = {}) {
    if (recoveryScanCache && !force) return recoveryScanCache;

    const map = new Map();
    const active = activeLectureRefs();
    const trash = trashedLectureRefs();

    for (const [id, ref] of active) {
      const candidate = candidateMapEntry(map, id);
      candidate.activeRef = ref;
      candidate.title = ref.material?.title || candidate.title;
      candidate.updatedAt = ref.material?.updated_at || candidate.updatedAt;
    }
    for (const [id, ref] of trash) {
      const candidate = candidateMapEntry(map, id);
      candidate.trashRef = ref;
      candidate.title = ref.material?.title || candidate.title;
      candidate.updatedAt = ref.deleted_at || ref.material?.updated_at || candidate.updatedAt;
    }

    await scanLocalRecovery(map);

    let cloud = { available: false, reason: "" };
    try {
      cloud = await scanCloudRecovery(map);
    } catch (error) {
      console.error("Deep cloud recovery scan failed", error);
      cloud = { available: false, reason: error.message || String(error) };
    }

    const items = [...map.values()].map(candidate => {
      const versions = [];
      const seen = new Set();
      const addVersion = (source, savedAt, payload, label) => {
        if (!payload) return;
        let fingerprint = "";
        try { fingerprint = JSON.stringify(payload); } catch (_) { fingerprint = `${source}|${savedAt}`; }
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);
        versions.push({ source, savedAt: savedAt || "", payload: cloneValue(payload), label });
      };

      addVersion("local-current", candidate.localCurrent?.updated_at, candidate.localCurrent, "Current local copy");
      addVersion("cloud-current", candidate.cloudCurrent?.updated_at, candidate.cloudCurrent, "Current cloud copy");
      for (const version of candidate.localHistory) addVersion(version.source, version.savedAt, version.payload, "Local recovery version");
      for (const version of candidate.cloudHistory) addVersion(version.source, version.savedAt, version.payload, "Cloud history version");

      versions.sort((a, b) => safeTime(b.savedAt || b.payload?.updated_at) - safeTime(a.savedAt || a.payload?.updated_at));

      const status = candidate.activeRef ? "active" : candidate.trashRef ? "trash" : "orphan";
      const title = candidate.title || versions.find(v => v.payload?.title)?.payload?.title || `Recovered Lecture ${shortId(candidate.id)}`;
      const courseCode = candidate.activeRef?.courseCode || candidate.trashRef?.courseCode || "";

      return {
        ...candidate,
        title,
        courseCode,
        status,
        versions,
      };
    });

    // Deleted/orphaned items first, then newest.
    items.sort((a, b) => {
      const priority = { trash: 0, orphan: 1, active: 2 };
      return (priority[a.status] - priority[b.status]) ||
        (safeTime(b.updatedAt || b.versions[0]?.savedAt) - safeTime(a.updatedAt || a.versions[0]?.savedAt)) ||
        a.title.localeCompare(b.title);
    });

    recoveryScanCache = { items, cloud };
    return recoveryScanCache;
  }

  function courseOptions(selectedId = "") {
    const profile = activeProfile();
    return orderedCourses(profile).map(course =>
      `<option value="${escapeHtml(course.id)}" ${String(course.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(course.code)}${course.name ? ` — ${escapeHtml(course.name)}` : ""}</option>`
    ).join("");
  }

  async function restoreRecoveredLecture(candidate, version, courseId) {
    const profile = activeProfile();
    const course = profile?.courses?.[courseId];
    if (!course) return toast("Choose a course to restore this Lecture into.", 4200);

    const existing = await idbGet(STORES.documents, candidate.id);
    const restored = cloneValue(version?.payload || existing || candidate.localCurrent || candidate.cloudCurrent);
    if (!restored) return toast("No recoverable Lecture contents were found for this item.", 5000);

    if (!restored.editor_layout && existing?.editor_layout) restored.editor_layout = cloneValue(existing.editor_layout);
    restored.id = candidate.id;
    restored.title = String(restored.title || candidate.title || "Recovered Lecture");
    restored.updated_at = nowIso();
    restored.created_at ||= nowIso();

    await idbSet(STORES.documents, candidate.id, restored);

    const trashRef = candidate.trashRef;
    let material = cloneValue(trashRef?.material || candidate.activeRef?.material || {});
    material.id = candidate.id;
    material.type ||= "quill_document";
    material.title = restored.title;
    material.file ||= `browser:${candidate.id}`;
    material.created_at ||= restored.created_at || nowIso();
    material.updated_at = restored.updated_at;
    material.last_opened_at = nowIso();
    if (material.unit_id && !(course.material_units || []).some(unit => String(unit.id) === String(material.unit_id))) material.unit_id = null;
    if (!Number.isFinite(Number(material.order))) material.order = course.materials?.length || 0;

    course.materials ||= [];
    const already = course.materials.find(item => String(item.id) === String(candidate.id));
    if (already) Object.assign(already, material);
    else course.materials.push(material);
    course.updated_at = nowIso();

    for (const profileItem of Object.values(state.profiles || {})) {
      profileItem.lecture_trash = ensureTrash(profileItem).filter(entry =>
        String(entry?.id || entry?.material?.id || "") !== String(candidate.id)
      );
    }

    queueSave();
    try { await cloudApi()?.markDocumentDirty?.(candidate.id); } catch (error) { console.warn("Recovered Lecture will sync later", error); }

    recoveryScanCache = null;
    closeModal();
    render();
    toast(`${restored.title} restored to ${course.code}.`, 5000);
  }

  function recoveryStatusLabel(candidate) {
    if (candidate.status === "trash") return "Trash";
    if (candidate.status === "orphan") return candidate.deletedInCloud ? "Deleted history" : "Orphaned";
    return "Active";
  }

  async function showRecoveryCandidate(candidate) {
    const preferredCourseId = candidate.trashRef?.courseId || candidate.activeRef?.courseId || route.courseId || orderedCourses()[0]?.id || "";
    const versions = candidate.versions || [];

    modal(
      `<h2>Recovery — ${escapeHtml(candidate.title)}</h2>
       <div class="card-subtitle">${escapeHtml(candidate.courseCode || "Course link missing")} • ${escapeHtml(recoveryStatusLabel(candidate))} • ID ${escapeHtml(shortId(candidate.id))}</div>
       <div class="field" style="margin-top:14px">
         <label>Restore into course</label>
         <select id="recovery-course-select">${courseOptions(preferredCourseId)}</select>
       </div>
       <div class="cloud-warning" style="margin-top:12px">
         Restoring creates/reconnects the Lecture in the selected course. It does not erase the recovery versions listed here.
       </div>
       <div id="deep-recovery-versions" class="list" style="margin-top:14px">
         ${versions.length ? versions.map((version, index) => `
           <div class="list-item">
             <div class="list-main">
               <div class="list-title">${escapeHtml(version.label || "Saved version")}</div>
               <div class="list-copy">${escapeHtml(formatDateTime(version.savedAt || version.payload?.updated_at || version.payload?.created_at || ""))}</div>
             </div>
             <button class="primary-button" data-deep-restore="${index}">Restore</button>
           </div>
         `).join("") : '<div class="empty">No document payload was found for this Lecture ID.</div>'}
       </div>`,
      null,
      { saveLabel: null, wide: true }
    );

    document.querySelectorAll("[data-deep-restore]").forEach(button => {
      button.onclick = async () => {
        const index = Number(button.dataset.deepRestore);
        const version = versions[index];
        const courseId = document.getElementById("recovery-course-select")?.value || "";
        if (!version) return;
        if (!confirm(`Restore "${candidate.title}" into the selected course using this saved version?`)) return;
        try {
          button.disabled = true;
          button.textContent = "Restoring…";
          await restoreRecoveredLecture(candidate, version, courseId);
        } catch (error) {
          console.error(error);
          button.disabled = false;
          button.textContent = "Restore";
          toast(`Restore failed: ${error.message || error}`, 6000);
        }
      };
    });
  }

  openRecoveryCenter = function hardenedOpenRecoveryCenter() {
    modal(
      `<h2>Lecture Recovery Center</h2>
       <div class="card-subtitle">Deep-scans active Lectures, Trash, orphaned IndexedDB documents, local Lecture history, current cloud documents, and Supabase cloud history.</div>
       <div class="field" style="margin-top:14px"><label>Find a Lecture</label><input id="deep-recovery-search" placeholder="e.g. Lecture 2 or BIO3102"></div>
       <div id="deep-recovery-status" class="form-help">Scanning local and cloud recovery sources…</div>
       <div id="deep-recovery-list" class="list" style="margin-top:14px"><div class="empty">Scanning…</div></div>`,
      null,
      { saveLabel: null, wide: true }
    );

    const list = document.getElementById("deep-recovery-list");
    const status = document.getElementById("deep-recovery-status");
    const search = document.getElementById("deep-recovery-search");
    let result = null;

    const renderItems = () => {
      if (!result) return;
      const needle = String(search?.value || "").trim().toLowerCase();
      const filtered = result.items.filter(item => {
        const haystack = `${item.title} ${item.courseCode} ${item.id} ${recoveryStatusLabel(item)}`.toLowerCase();
        return !needle || haystack.includes(needle);
      });

      list.innerHTML = filtered.length ? filtered.map(item => {
        const sourceCount = item.versions.length;
        const course = item.courseCode || "Course link missing";
        const danger = item.status !== "active";
        return `<button class="list-item" data-deep-recovery-id="${escapeHtml(item.id)}" style="text-align:left">
          <div class="list-main">
            <div class="list-title">${escapeHtml(course)} • ${escapeHtml(item.title)}</div>
            <div class="list-copy">${escapeHtml(recoveryStatusLabel(item))} • ${sourceCount} recoverable version${sourceCount === 1 ? "" : "s"}${item.deletedInCloud ? " • cloud row deleted" : ""}</div>
          </div>
          <span class="pill"${danger ? ' style="border-color:var(--warning,#d99b34)"' : ""}>${escapeHtml(recoveryStatusLabel(item))}</span>
        </button>`;
      }).join("") : '<div class="empty">No Lectures match this search.</div>';

      list.querySelectorAll("[data-deep-recovery-id]").forEach(button => {
        button.onclick = () => {
          const item = result.items.find(candidate => String(candidate.id) === String(button.dataset.deepRecoveryId));
          if (item) showRecoveryCandidate(item);
        };
      });
    };

    search?.addEventListener("input", renderItems);

    scanRecoveryCandidates({ force: true }).then(scan => {
      result = scan;
      const hidden = scan.items.filter(item => item.status !== "active").length;
      const cloudText = scan.cloud.available
        ? "Cloud history scan completed."
        : `Cloud history scan unavailable${scan.cloud.reason ? `: ${scan.cloud.reason}` : "."}`;
      status.textContent = `${scan.items.length} Lecture ID${scan.items.length === 1 ? "" : "s"} found; ${hidden} deleted/orphaned. ${cloudText}`;
      renderItems();

      // Put the user's current recovery target front and center if it exists.
      if (search && !search.value) {
        const lecture2 = scan.items.find(item =>
          /lecture\s*2/i.test(item.title || "") &&
          /bio\s*3102/i.test(item.courseCode || "")
        );
        if (lecture2) {
          search.value = "Lecture 2";
          renderItems();
        }
      }
    }).catch(error => {
      console.error(error);
      status.textContent = `Recovery scan failed: ${error.message || error}`;
      list.innerHTML = '<div class="empty">The recovery scan could not complete. Your existing data was not changed.</div>';
    });
  };

  // Replace destructive deletion with an indefinite, synced Trash. The document
  // record and PDF blob remain untouched. No automatic purge exists.
  deleteMaterial = async function softDeleteMaterial(course, id) {
    const material = (course.materials || []).find(item => String(item.id) === String(id));
    const title = material?.title || "this Lecture";
    if (!material) return;

    if (!confirm(`Move "${title}" to Lecture Trash?\n\nIt will disappear from Study Material but its notes, questions, PDF and recovery history will be kept indefinitely until you restore it.`)) return;
    if (!await requireDeletionPin(`move the lecture '${title}' to Trash`)) return;

    const profile = activeProfile();
    const trash = ensureTrash(profile);
    const deletedAt = nowIso();

    // Save a recovery snapshot before unlinking the Lecture from the course.
    try { await cloudApi()?.markDocumentDirty?.(id); } catch (error) { console.warn("Lecture recovery snapshot will sync later", error); }

    const existingIndex = trash.findIndex(entry => String(entry?.id || entry?.material?.id || "") === String(id));
    const lectureQuestions = (course.questions || []).filter(question =>
      String(question?.source_material_id || "") === String(id)
    );
    const trashEntry = {
      id: String(id),
      profile_id: profile.id,
      course_id: course.id,
      course_code: course.code || "COURSE",
      material: cloneValue(material),
      questions: cloneValue(lectureQuestions),
      deleted_at: deletedAt,
    };
    if (existingIndex >= 0) trash[existingIndex] = trashEntry;
    else trash.push(trashEntry);

    course.materials = (course.materials || []).filter(item => String(item.id) !== String(id));
    // Questions are part of the trashed Lecture. Remove them from the live course
    // and keep the copies above so they can follow the Lecture to any restored course.
    course.questions = (course.questions || []).filter(question =>
      String(question?.source_material_id || "") !== String(id)
    );
    course.updated_at = deletedAt;

    // Intentionally DO NOT delete STORES.documents, the PDF blob, or send
    // markDocumentDeleted/markBlobDeleted. That was the permanent-loss path.
    queueSave();
    recoveryScanCache = null;
    renderCourse();
    toast(`${title} moved to Trash. Restore it anytime from Settings → Recovery Center.`, 5500);
  };

  function trashEntries(profile = activeProfile()) {
    return ensureTrash(profile)
      .slice()
      .sort((a, b) => safeTime(b?.deleted_at) - safeTime(a?.deleted_at));
  }

  function lectureTrashSettingsCardHtml() {
    const entries = trashEntries();
    const recent = entries.slice(0, 3);
    return `<section class="card" id="lecture-trash-settings-card">
      <div class="card-header">
        <div>
          <h2>Lecture Trash</h2>
          <div class="card-subtitle">Deleted Lectures are kept here indefinitely instead of being destroyed.</div>
        </div>
        <button id="open-lecture-trash" class="secondary-button" type="button">Open Trash${entries.length ? ` (${entries.length})` : ""}</button>
      </div>
      ${recent.length ? `<div class="list" style="margin-top:12px">${recent.map(entry => `
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${escapeHtml(entry?.material?.title || "Untitled Lecture")}</div>
            <div class="list-copy">${escapeHtml(entry?.course_code || "Unknown course")} • moved to Trash ${escapeHtml(formatDateTime(entry?.deleted_at || ""))}</div>
          </div>
        </div>`).join("")}</div>` : '<div class="empty" style="margin-top:12px">Lecture Trash is empty.</div>'}
      <p class="form-help">Use <strong>Take back</strong> to restore a Lecture into any course. Restored Lectures always return to that course's <strong>Ungrouped</strong> section.</p>
    </section>`;
  }

  function installLectureTrashSettingsCard() {
    if (route?.page !== "settings" || !els?.page) return;
    const stack = els.page.querySelector(".page-stack");
    if (!stack || document.getElementById("lecture-trash-settings-card")) return;

    const firstSection = stack.querySelector(":scope > section.card");
    if (firstSection) firstSection.insertAdjacentHTML("afterend", lectureTrashSettingsCardHtml());
    else stack.insertAdjacentHTML("afterbegin", lectureTrashSettingsCardHtml());

    document.getElementById("open-lecture-trash")?.addEventListener("click", openLectureTrash);
  }

  const baseRenderSettingsForLectureTrash = renderSettings;
  renderSettings = function renderSettingsWithLectureTrash() {
    baseRenderSettingsForLectureTrash();
    installLectureTrashSettingsCard();
  };

  function openLectureTrash() {
    const entries = trashEntries();
    modal(
      `<h2>Lecture Trash</h2>
       <div class="card-subtitle">Lectures in Trash are retained indefinitely. Their document, notes and PDF are not deleted.</div>
       <div class="list" style="margin-top:14px">
         ${entries.length ? entries.map(entry => {
           const questionCount = Array.isArray(entry?.questions) ? entry.questions.length : 0;
           return `<div class="list-item">
             <div class="list-main">
               <div class="list-title">${escapeHtml(entry?.material?.title || "Untitled Lecture")}</div>
               <div class="list-copy">
                 Original course: ${escapeHtml(entry?.course_code || "Unknown course")} •
                 Trashed ${escapeHtml(formatDateTime(entry?.deleted_at || ""))}
                 ${questionCount ? ` • ${questionCount} question${questionCount === 1 ? "" : "s"}` : ""}
               </div>
             </div>
             <button class="primary-button" type="button" data-trash-take-back="${escapeHtml(String(entry?.id || entry?.material?.id || ""))}">Take back</button>
           </div>`;
         }).join("") : '<div class="empty">Lecture Trash is empty.</div>'}
       </div>`,
      null,
      { saveLabel: null, wide: true }
    );

    document.querySelectorAll("[data-trash-take-back]").forEach(button => {
      button.addEventListener("click", () => {
        const id = String(button.dataset.trashTakeBack || "");
        const entry = trashEntries().find(item =>
          String(item?.id || item?.material?.id || "") === id
        );
        if (entry) openTakeBackCoursePicker(entry);
      });
    });
  }

  function openTakeBackCoursePicker(entry) {
    const profile = activeProfile();
    const courses = orderedCourses(profile);
    if (!courses.length) {
      toast("Create a course before taking this Lecture back.", 4500);
      return;
    }

    const preferredId = courses.some(course => String(course.id) === String(entry?.course_id))
      ? String(entry.course_id)
      : String(courses[0].id);

    modal(
      `<h2>Take back — ${escapeHtml(entry?.material?.title || "Untitled Lecture")}</h2>
       <div class="card-subtitle">Choose the course that should receive this Lecture.</div>
       <div class="field" style="margin-top:14px">
         <label>Course</label>
         <select id="lecture-trash-course">${courses.map(course =>
           `<option value="${escapeHtml(course.id)}" ${String(course.id) === preferredId ? "selected" : ""}>${escapeHtml(course.code)}${course.name ? ` — ${escapeHtml(course.name)}` : ""}</option>`
         ).join("")}</select>
       </div>
       <div class="cloud-warning" style="margin-top:12px">
         The Lecture will be restored to <strong>Ungrouped</strong> in the selected course. Its saved notes, PDF and Lecture Questions move with it.
       </div>
       <div class="action-row" style="margin-top:16px">
         <button id="lecture-trash-confirm-restore" class="primary-button" type="button">Take back</button>
         <button id="lecture-trash-back" class="secondary-button" type="button">Back to Trash</button>
       </div>`,
      null,
      { saveLabel: null, wide: true }
    );

    document.getElementById("lecture-trash-back")?.addEventListener("click", openLectureTrash);
    document.getElementById("lecture-trash-confirm-restore")?.addEventListener("click", async () => {
      const button = document.getElementById("lecture-trash-confirm-restore");
      const targetCourseId = document.getElementById("lecture-trash-course")?.value || "";
      if (!targetCourseId) return;

      button.disabled = true;
      button.textContent = "Restoring…";
      try {
        await takeBackLectureFromTrash(entry, targetCourseId);
      } catch (error) {
        console.error(error);
        button.disabled = false;
        button.textContent = "Take back";
        toast(`Could not restore Lecture: ${error.message || error}`, 6000);
      }
    });
  }

  async function takeBackLectureFromTrash(entry, targetCourseId) {
    const profile = activeProfile();
    const target = profile?.courses?.[targetCourseId];
    if (!target) throw new Error("The selected course no longer exists.");

    const id = String(entry?.id || entry?.material?.id || "");
    if (!id) throw new Error("The Trash entry has no Lecture ID.");

    const document = await idbGet(STORES.documents, id);
    if (!document) {
      // This should not happen for v31+ soft-deleted Lectures. If it does, the
      // deep Recovery Center remains the correct route because it can search history.
      throw new Error("The Lecture document is missing locally. Use Recovery Center to restore a saved version first.");
    }

    // A Lecture ID must exist in at most one live course. Remove any accidental
    // stale copy before reconnecting it to the selected destination.
    for (const course of Object.values(profile.courses || {})) {
      course.materials = (course.materials || []).filter(material => String(material?.id || "") !== id);
      course.questions = (course.questions || []).filter(question =>
        String(question?.source_material_id || "") !== id
      );
    }

    const material = cloneValue(entry.material || {});
    material.id = id;
    material.title = String(material.title || document.title || "Untitled Lecture");
    material.type ||= "quill_document";
    material.file ||= `browser:${id}`;
    // Explicit requirement: every restored Lecture returns to Ungrouped.
    material.unit_id = null;
    material.updated_at = nowIso();
    material.last_opened_at = material.last_opened_at || null;

    target.materials ||= [];
    const maxOrder = target.materials.reduce((max, item) => Math.max(max, Number(item?.order) || 0), -1);
    material.order = maxOrder + 1;
    target.materials.push(material);

    target.questions ||= [];
    const savedQuestions = Array.isArray(entry.questions) ? cloneValue(entry.questions) : [];
    for (const question of savedQuestions) {
      question.source_material_id = id;
      if (!question.id || target.questions.some(existing => String(existing?.id || "") === String(question.id))) {
        question.id = uid("question");
      }
      target.questions.push(question);
    }

    target.updated_at = nowIso();
    profile.lecture_trash = ensureTrash(profile).filter(item =>
      String(item?.id || item?.material?.id || "") !== id
    );

    queueSave();
    try { await cloudApi()?.markDocumentDirty?.(id); } catch (error) {
      console.warn("Restored Lecture is saved locally; cloud sync will retry later.", error);
    }

    recoveryScanCache = null;
    closeModal();
    if (route.page === "settings") renderSettings();
    else render();
    toast(`${material.title} restored to ${target.code} → Ungrouped.`, 5500);
  }

  // Invalidate scan results after remote sync applies data from another device.
  window.addEventListener("studyhub-cloud-remote", () => { recoveryScanCache = null; });
})();
