"use strict";

(() => {
  const query = new URLSearchParams(location.search);
  const profileId = query.get("profile") || "";
  const courseId = query.get("course") || "";
  const materialId = query.get("material") || "";
  if (!profileId || !courseId || !materialId) return;

  const DB_NAME = "university-study-hub";
  const DB_VERSION = 1;
  let dbPromise = null;
  let writeSerial = Promise.resolve();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of ["meta", "documents", "blobs"]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function questionRows(list) {
    return [...list.querySelectorAll(".lecture-question-row[data-question-id]")];
  }

  function setSaveStatus(text, state = "saved") {
    const status = document.getElementById("save-status");
    if (!status) return;
    status.textContent = text;
    status.dataset.state = state;
  }

  async function persistRankOrder(list) {
    const ids = questionRows(list).map(row => String(row.dataset.questionId || "")).filter(Boolean);
    if (!ids.length) return;

    const operation = writeSerial.then(async () => {
      try { await window.pywebview?.api?.flush_local_writes?.(); } catch (_) {}

      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        const store = tx.objectStore("meta");
        const request = store.get("state");

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const state = request.result;
          const course = state?.profiles?.[profileId]?.courses?.[courseId];
          if (!state || !course) return;

          const all = Array.isArray(course.questions) ? course.questions.slice() : [];
          const documentQuestions = all.filter(question =>
            String(question?.source_material_id || "") === String(materialId)
          );
          const byId = new Map(documentQuestions.map(question => [String(question.id), question]));
          const ordered = ids.map(id => byId.get(id)).filter(Boolean);

          // Never drop a question if the list changed while the panel was open.
          for (const question of documentQuestions) {
            if (!ordered.includes(question)) ordered.push(question);
          }

          ordered.forEach((question, index) => {
            question.order = index;
          });

          let documentIndex = 0;
          course.questions = all.map(question => {
            if (String(question?.source_material_id || "") !== String(materialId)) return question;
            return ordered[documentIndex++] || question;
          });

          const now = new Date().toISOString();
          course.updated_at = now;
          state.app ||= {};
          state.app.last_saved = now;
          store.put(state, "state");
        };

        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Question rank save was aborted."));
      });

      try {
        await window.StudyHubCloud?.markStateDirty?.();
      } catch (error) {
        console.warn("Question rank saved locally; cloud sync will retry later.", error);
      }
    });

    writeSerial = operation.catch(error => {
      console.error("Question rank save failed", error);
    });

    try {
      await operation;
      setSaveStatus("✓ Question rank saved");
    } catch (error) {
      setSaveStatus("Question rank save failed", "error");
      throw error;
    }
  }

  function ensureRankControl(row, list) {
    const body = row.children[1];
    if (!(body instanceof HTMLElement)) return null;

    let control = body.querySelector(".lecture-question-rank-control");
    if (control) return control.querySelector("input");

    control = document.createElement("label");
    control.className = "lecture-question-rank-control";
    control.innerHTML = `<span>Rank:</span><input class="lecture-question-rank-input" type="number" min="1" step="1" inputmode="numeric" aria-label="Question rank">`;
    body.appendChild(control);

    const input = control.querySelector("input");

    async function commitRank() {
      const rows = questionRows(list);
      const currentIndex = rows.indexOf(row);
      if (currentIndex < 0 || !rows.length) return;

      const raw = Number.parseInt(input.value, 10);
      if (!Number.isFinite(raw)) {
        input.value = String(currentIndex + 1);
        return;
      }

      const requestedRank = Math.max(1, Math.min(rows.length, raw));
      const targetIndex = requestedRank - 1;
      input.value = String(requestedRank);

      if (targetIndex === currentIndex) {
        syncRanks(list);
        return;
      }

      const withoutRow = rows.filter(candidate => candidate !== row);
      const reference = withoutRow[targetIndex] || null;
      list.insertBefore(row, reference);

      syncRanks(list);
      await persistRankOrder(list);

      // Confirm the move visually even when jumping from question 50+ to rank 4.
      requestAnimationFrame(() => {
        row.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        input.focus({ preventScroll: true });
        input.select();
      });
    }

    input.addEventListener("change", () => {
      commitRank().catch(console.error);
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      commitRank().catch(console.error);
    });
    input.addEventListener("pointerdown", event => {
      // Rank editing should never be interpreted as a question drag gesture.
      event.stopPropagation();
    });

    return input;
  }

  function syncRanks(list) {
    const rows = questionRows(list);
    rows.forEach((row, index) => {
      const rank = index + 1;
      const badge = row.querySelector(".lecture-question-rank");
      if (badge) badge.textContent = `#${rank}`;

      const input = ensureRankControl(row, list);
      if (input) {
        input.min = "1";
        input.max = String(rows.length);
        if (document.activeElement !== input) input.value = String(rank);
        input.setAttribute("aria-label", `Question rank, currently ${rank} of ${rows.length}`);
      }
    });
  }

  function installRankUi(list) {
    if (!list || list.dataset.rankEntryInstalled === "true") return;
    list.dataset.rankEntryInstalled = "true";

    const style = document.createElement("style");
    style.id = "lecture-question-rank-entry-style";
    style.textContent = `
      .lecture-question-row > :nth-child(2){min-width:0}
      .lecture-question-rank-control{
        display:flex;
        align-items:center;
        justify-content:flex-end;
        gap:7px;
        margin-top:8px;
        color:var(--text);
        font-size:12px;
        font-weight:750;
        line-height:30px;
      }
      .lecture-question-rank-input{
        width:68px;
        height:30px;
        padding:2px 6px;
        border:1px solid #456273;
        border-radius:6px;
        outline:none;
        color:#102010;
        background:#f7fafc;
        font-size:13px;
        font-weight:750;
        text-align:center;
      }
      .lecture-question-rank-input:focus{
        border-color:var(--accent);
        box-shadow:0 0 0 2px rgba(38,200,184,.18);
      }
      @media(pointer:coarse){
        .lecture-question-rank-input{width:76px;height:38px;font-size:16px}
        .lecture-question-rank-control{line-height:38px}
      }
    `;
    if (!document.getElementById(style.id)) document.head.appendChild(style);

    const panel = list.closest(".lecture-question-panel");
    const instruction = panel?.querySelector(".lecture-question-panel-head span");
    if (instruction) instruction.textContent = "Drag or enter rank";

    let syncQueued = false;
    const queueSync = () => {
      if (syncQueued) return;
      syncQueued = true;
      queueMicrotask(() => {
        syncQueued = false;
        syncRanks(list);
      });
    };

    new MutationObserver(queueSync).observe(list, { childList: true });
    list.addEventListener("pointerup", () => setTimeout(queueSync, 0), true);
    list.addEventListener("pointercancel", () => setTimeout(queueSync, 0), true);

    queueSync();
  }

  function findAndInstall() {
    const list = document.querySelector(".lecture-question-panel .lecture-question-list");
    if (list) {
      installRankUi(list);
      return true;
    }
    return false;
  }

  function install() {
    if (findAndInstall()) return;

    const observer = new MutationObserver(() => {
      if (findAndInstall()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Defensive stop: if the Lecture toolbar failed to initialize, do not keep
    // a document-wide observer alive forever.
    setTimeout(() => observer.disconnect(), 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(install, 0), { once: true });
  } else {
    setTimeout(install, 0);
  }
})();
