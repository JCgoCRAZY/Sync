"use strict";

(() => {
  const query = new URLSearchParams(location.search);
  const profileId = query.get("profile") || "";
  const courseId = query.get("course") || "";
  const materialId = query.get("material") || "";
  const DB_NAME = "university-study-hub";
  const DB_VERSION = 1;
  let dbPromise = null;
  let stateMutationSerial = Promise.resolve();
  let splitRatioOverride = null;

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

  async function readState() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly");
      const request = tx.objectStore("meta").get("state");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  function mutateState(mutator) {
    const operation = stateMutationSerial.then(async () => {
      try { await window.pywebview?.api?.flush_local_writes?.(); } catch (_) {}
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        const store = tx.objectStore("meta");
        const request = store.get("state");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const state = request.result;
          if (!state) return;
          mutator(state);
          state.app ||= {};
          state.app.last_saved = new Date().toISOString();
          store.put(state, "state");
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("State update was aborted."));
      });
      try { await window.StudyHubCloud?.markStateDirty?.(); } catch (error) { console.warn("Question order will sync later", error); }
    });
    stateMutationSerial = operation.catch(error => console.error("Lecture question order save failed", error));
    return operation;
  }

  async function documentQuestions() {
    await stateMutationSerial.catch(() => {});
    const state = await readState();
    const course = state?.profiles?.[profileId]?.courses?.[courseId];
    return (course?.questions || [])
      .filter(question => String(question.source_material_id || "") === String(materialId))
      .map(question => ({
        id: String(question.id),
        prompt: String(question.prompt || ""),
        answer: String(question.answer || ""),
        created_at: question.created_at || ""
      }));
  }

  function reorderQuestionArray(allQuestions, ids, sourceMaterialId = materialId) {
    const all = Array.isArray(allQuestions) ? allQuestions.slice() : [];
    const requested = [...new Set((ids || []).map(String))];
    const documentQs = all.filter(q => String(q.source_material_id || "") === String(sourceMaterialId));
    const byId = new Map(documentQs.map(q => [String(q.id), q]));
    const ordered = requested.map(id => byId.get(id)).filter(Boolean);
    for (const question of documentQs) {
      if (!ordered.includes(question)) ordered.push(question);
    }
    ordered.forEach((question, index) => { question.order = index; });
    let index = 0;
    return all.map(question => {
      if (String(question.source_material_id || "") !== String(sourceMaterialId)) return question;
      return ordered[index++] || question;
    });
  }

  async function saveDocumentQuestionOrder(ids) {
    await mutateState(state => {
      const course = state?.profiles?.[profileId]?.courses?.[courseId];
      if (!course) return;
      course.questions = reorderQuestionArray(course.questions || [], ids);
      course.updated_at = new Date().toISOString();
    });
  }

  function installQuestionList() {
    const createButton = document.getElementById("create-question-button");
    if (!createButton || document.getElementById("lecture-question-list-button")) return;

    const style = document.createElement("style");
    style.textContent = `
      #lecture-question-list-button{float:none;width:auto;min-width:112px;height:36px;padding:0 14px;border:0;border-radius:6px;color:var(--text);background:#123b3d;font-size:13px;font-weight:700;line-height:36px;cursor:pointer}
      #lecture-question-list-button:hover,#lecture-question-list-button[aria-expanded="true"]{color:#071314;background:var(--accent)}
      .lecture-question-panel[hidden]{display:none}.lecture-question-panel{position:fixed;z-index:2200;width:min(460px,calc(100vw - 24px));max-height:min(72vh,680px);display:flex;flex-direction:column;border:1px solid #284353;border-radius:12px;background:var(--bar);box-shadow:0 18px 46px rgba(0,0,0,.46);overflow:hidden}
      .lecture-question-panel-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #284353}.lecture-question-panel-head strong{flex:1;font-size:15px}.lecture-question-panel-head span{color:var(--muted);font-size:12px}.lecture-question-close{border:0;background:transparent;color:var(--text);font-size:20px;cursor:pointer}
      .lecture-question-list{display:flex;flex-direction:column;gap:8px;min-height:90px;padding:10px;overflow:auto}.lecture-question-empty{padding:24px 12px;color:var(--muted);text-align:center}
      .lecture-question-row{display:grid;grid-template-columns:34px 1fr;gap:8px;align-items:start;padding:10px;border:1px solid #284353;border-radius:9px;background:#11212d;transition:transform .1s ease,opacity .1s ease,box-shadow .1s ease}.lecture-question-row.dragging{opacity:.42}.lecture-question-row.drop-before{box-shadow:0 -3px 0 #26c8b8}.lecture-question-row.drop-after{box-shadow:0 3px 0 #26c8b8}
      .lecture-question-drag{width:32px;height:38px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:18px;font-weight:900;letter-spacing:-2px;cursor:grab;touch-action:none;user-select:none}.lecture-question-drag:hover{background:#172d3b;color:var(--text)}.lecture-question-drag:active{cursor:grabbing}
      .lecture-question-prompt{font-weight:750;line-height:1.35;color:var(--text)}.lecture-question-answer{margin-top:5px;color:var(--muted);font-size:12px;line-height:1.35;white-space:pre-wrap}.lecture-question-rank{display:inline-block;margin-top:7px;padding:2px 7px;border-radius:999px;background:#0d2630;color:#a8c0c9;font-size:10px;font-weight:750}
      @media(pointer:coarse){#lecture-question-list-button{min-height:42px}.lecture-question-drag{width:42px;height:44px}}
    `;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.id = "lecture-question-list-button";
    button.type = "button";
    button.textContent = "Questions";
    button.title = "View and reorder the questions created for this Lecture";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    createButton.insertAdjacentElement("afterend", button);

    const panel = document.createElement("aside");
    panel.className = "lecture-question-panel";
    panel.hidden = true;
    panel.innerHTML = `<div class="lecture-question-panel-head"><strong>Lecture Questions</strong><span>Drag to reorder</span><button class="lecture-question-close" type="button" aria-label="Close">×</button></div><div class="lecture-question-list"></div>`;
    document.body.appendChild(panel);
    const list = panel.querySelector(".lecture-question-list");
    const close = panel.querySelector(".lecture-question-close");
    let drag = null;

    function positionPanel() {
      if (panel.hidden) return;
      const buttonRect = button.getBoundingClientRect();
      panel.style.left = "0px";
      panel.style.top = "0px";
      const rect = panel.getBoundingClientRect();
      const edge = 12;
      let left = Math.min(buttonRect.left, window.innerWidth - rect.width - edge);
      left = Math.max(edge, left);
      let top = buttonRect.bottom + 8;
      if (top + rect.height > window.innerHeight - edge) top = Math.max(edge, buttonRect.top - rect.height - 8);
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    }

    function updateRanks() {
      [...list.querySelectorAll(".lecture-question-row")].forEach((row, index) => {
        const badge = row.querySelector(".lecture-question-rank");
        if (badge) badge.textContent = `#${index + 1}`;
      });
    }

    async function renderQuestions() {
      const questions = await documentQuestions();
      list.replaceChildren();
      if (!questions.length) {
        const empty = document.createElement("div");
        empty.className = "lecture-question-empty";
        empty.textContent = "No questions have been created for this Lecture yet.";
        list.appendChild(empty);
        positionPanel();
        return;
      }
      questions.forEach((question, index) => {
        const row = document.createElement("div");
        row.className = "lecture-question-row";
        row.dataset.questionId = question.id;
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "lecture-question-drag";
        handle.textContent = "⋮⋮";
        handle.title = "Drag to reorder";
        handle.setAttribute("aria-label", `Drag question ${index + 1}`);
        const body = document.createElement("div");
        const prompt = document.createElement("div");
        prompt.className = "lecture-question-prompt";
        prompt.textContent = question.prompt || "Untitled question";
        const answer = document.createElement("div");
        answer.className = "lecture-question-answer";
        answer.textContent = question.answer ? `Answer: ${question.answer}` : "";
        const rank = document.createElement("span");
        rank.className = "lecture-question-rank";
        rank.textContent = `#${index + 1}`;
        body.append(prompt, answer, rank);
        row.append(handle, body);
        list.appendChild(row);
      });
      positionPanel();
    }

    async function persistDomOrder() {
      const ids = [...list.querySelectorAll(".lecture-question-row")].map(row => row.dataset.questionId);
      try {
        await saveDocumentQuestionOrder(ids);
        const status = document.getElementById("save-status");
        if (status) { status.textContent = "✓ Question order saved"; status.dataset.state = "saved"; }
      } catch (error) {
        console.error(error);
        const status = document.getElementById("save-status");
        if (status) { status.textContent = "Question order save failed"; status.dataset.state = "error"; }
      }
    }

    list.addEventListener("pointerdown", event => {
      const handle = event.target.closest(".lecture-question-drag");
      if (!handle || event.button !== 0) return;
      const row = handle.closest(".lecture-question-row");
      if (!row) return;
      event.preventDefault();
      drag = {pointerId:event.pointerId, handle, row, changed:false};
      row.classList.add("dragging");
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
    }, true);

    function autoScrollQuestionList(clientY) {
      const rect = list.getBoundingClientRect();
      const edge = Math.min(60, Math.max(28, rect.height * .18));
      let delta = 0;
      if (clientY < rect.top + edge) delta = -Math.max(6, Math.round((rect.top + edge - clientY) * .32));
      else if (clientY > rect.bottom - edge) delta = Math.max(6, Math.round((clientY - (rect.bottom - edge)) * .32));
      if (delta) list.scrollTop += delta;
    }

    list.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      autoScrollQuestionList(event.clientY);
      list.querySelectorAll(".drop-before,.drop-after").forEach(row => row.classList.remove("drop-before","drop-after"));
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".lecture-question-row");
      if (!hit || hit === drag.row || !list.contains(hit)) return;
      const rect = hit.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      hit.classList.add(after ? "drop-after" : "drop-before");
      const reference = after ? hit.nextSibling : hit;
      if (reference !== drag.row && drag.row.nextSibling !== reference) {
        list.insertBefore(drag.row, reference);
        drag.changed = true;
        updateRanks();
      }
    }, true);

    async function endQuestionDrag(event, cancelled = false) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const state = drag;
      drag = null;
      state.row.classList.remove("dragging");
      list.querySelectorAll(".drop-before,.drop-after").forEach(row => row.classList.remove("drop-before","drop-after"));
      try { state.handle.releasePointerCapture(event.pointerId); } catch (_) {}
      if (!cancelled && state.changed) await persistDomOrder();
    }
    list.addEventListener("pointerup", event => endQuestionDrag(event, false), true);
    list.addEventListener("pointercancel", event => endQuestionDrag(event, true), true);

    async function openPanel() {
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      await renderQuestions();
      positionPanel();
    }
    function closePanel() {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (panel.hidden) openPanel(); else closePanel();
    });
    close.addEventListener("click", closePanel);
    window.addEventListener("resize", positionPanel, {passive:true});
    document.addEventListener("pointerdown", event => {
      if (panel.hidden || panel.contains(event.target) || button.contains(event.target)) return;
      closePanel();
    }, true);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); closePanel(); }
    });

    // Refresh after the existing +Question dialog closes (save or cancel); this is
    // cheap and guarantees newly saved questions appear immediately when the panel is open.
    const overlay = document.getElementById("question-overlay");
    if (overlay) {
      new MutationObserver(() => {
        if (!panel.hidden && overlay.hidden) renderQuestions().catch(console.error);
      }).observe(overlay, {attributes:true, attributeFilter:["hidden"]});
    }
  }

  function installInfoEditing() {
    const root = document.querySelector("#editor .ql-editor");
    const popover = document.getElementById("info-popover");
    const content = document.getElementById("info-popover-content");
    const quill = document.getElementById("editor")?.__quill;
    if (!root || !popover || !content || !quill || popover.dataset.editUpgradeInstalled === "true") return;
    popover.dataset.editUpgradeInstalled = "true";

    const style = document.createElement("style");
    style.textContent = `
      .info-edit-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.16)}
      .info-edit-actions[hidden]{display:none}.info-edit-actions button{padding:6px 10px;border:1px solid #44545f;border-radius:7px;color:#fff;background:#2f363c;font-size:12px;font-weight:700;cursor:pointer}.info-edit-actions .save{background:#123b3d}.info-edit-actions .save:hover{background:#26c8b8;color:#071314}
      .info-popover-content.editing-existing{min-height:58px;padding:5px;border-radius:5px;background:rgba(255,255,255,.055);box-shadow:inset 0 0 0 1px rgba(38,200,184,.55)}
    `;
    document.head.appendChild(style);
    const actions = document.createElement("div");
    actions.className = "info-edit-actions";
    actions.hidden = true;
    actions.innerHTML = `<button type="button" data-info-cancel>Cancel</button><button type="button" class="save" data-info-save>Save</button>`;
    popover.appendChild(actions);
    const cancelButton = actions.querySelector("[data-info-cancel]");
    const saveButton = actions.querySelector("[data-info-save]");
    let edit = null;
    let lastInfoNode = null;

    function matchingInfoNodes(infoId) {
      return [...root.querySelectorAll("[data-info-id]")].filter(node => node.getAttribute("data-info-id") === infoId);
    }

    function finish(save) {
      if (!edit) return;
      const state = edit;
      edit = null;
      const text = content.textContent || "";
      if (save) {
        const value = text.trim() ? JSON.stringify({id:state.infoId,text}) : false;
        const nodes = matchingInfoNodes(state.infoId);
        const ranges = nodes.map(node => {
          const blot = Quill.find(node, true);
          if (!blot) return null;
          return {index:quill.getIndex(blot), length:Math.max(1, blot.length())};
        }).filter(Boolean).sort((a,b)=>b.index-a.index);
        for (const range of ranges) quill.formatText(range.index, range.length, "info", value, "user");
        const status = document.getElementById("save-status");
        if (status) { status.textContent = value ? "✓ Info saved" : "Info removed"; status.dataset.state = value ? "saved" : ""; }
      } else {
        content.textContent = state.originalText;
      }
      content.contentEditable = "false";
      content.classList.remove("editing-existing", "editing");
      actions.hidden = true;
      popover.hidden = true;
    }

    function beginExistingEdit(node) {
      if (!node || !node.isConnected || popover.hidden || content.contentEditable === "true") return;
      const infoId = node.getAttribute("data-info-id") || "";
      if (!infoId) return;
      edit = {infoId, originalText:content.textContent || ""};
      content.contentEditable = "true";
      content.classList.add("editing", "editing-existing");
      actions.hidden = false;
      try { content.focus({preventScroll:true}); } catch (_) { content.focus(); }
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    root.addEventListener("click", event => {
      const node = event.target.closest?.("[data-info-id]");
      if (!node || !root.contains(node)) return;
      lastInfoNode = node;
      // The editor's original click handler opens the read-only popover first.
      // Enter edit mode in the next task so existing +Info behaves like newly created +Info.
      setTimeout(() => beginExistingEdit(lastInfoNode), 0);
    });

    saveButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); finish(true); });
    cancelButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); finish(false); });
    document.addEventListener("pointerdown", event => {
      if (!edit || popover.contains(event.target)) return;
      finish(true);
    }, true);
    document.addEventListener("keydown", event => {
      if (!edit) return;
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
      else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); finish(true); }
    }, true);
  }

  function installStableDividerResize() {
    const divider = document.getElementById("split-divider");
    const workspace = document.getElementById("editor-workspace");
    const slidesStage = document.getElementById("slides-stage");
    const viewer = document.getElementById("slides-pdf-viewer");
    if (!divider || !workspace || !slidesStage || !viewer || divider.dataset.stableResizeInstalled === "true") return;
    divider.dataset.stableResizeInstalled = "true";
    let drag = null;
    let restoreFrame = null;

    function clampRatio(value) { return Math.max(.25, Math.min(.75, Number(value) || .5)); }
    function currentRatio() {
      const css = getComputedStyle(workspace).getPropertyValue("--notes-ratio").trim();
      return clampRatio(parseFloat(css) || .5);
    }
    function captureAnchor() {
      const pages = [...viewer.querySelectorAll(".slides-pdf-page")];
      if (!pages.length || slidesStage.clientHeight <= 0) return null;
      const stageRect = slidesStage.getBoundingClientRect();
      const y = stageRect.top + stageRect.height / 2;
      let best = null;
      let distance = Infinity;
      for (const page of pages) {
        const rect = page.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const d = y < rect.top ? rect.top-y : y > rect.bottom ? y-rect.bottom : 0;
        if (d < distance) { distance=d; best={page,rect}; if (d===0) break; }
      }
      if (!best) return null;
      return {pageNumber:best.page.dataset.pageNumber || "", fraction:Math.max(0,Math.min(1,(y-best.rect.top)/best.rect.height))};
    }
    function restoreAnchor(anchor) {
      if (!anchor?.pageNumber) return;
      const page = [...viewer.querySelectorAll(".slides-pdf-page")].find(candidate => String(candidate.dataset.pageNumber || "") === String(anchor.pageNumber));
      if (!page) return;
      const stageRect = slidesStage.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      if (!stageRect.height || !pageRect.height) return;
      const desiredY = stageRect.top + stageRect.height / 2;
      const actualY = pageRect.top + pageRect.height * anchor.fraction;
      const delta = actualY - desiredY;
      if (Math.abs(delta) > .25) slidesStage.scrollTop = Math.max(0, slidesStage.scrollTop + delta);
    }
    function scheduleRestore(anchor) {
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        restoreAnchor(anchor);
      });
    }

    // Ensure the editor's own close/layout save cannot overwrite the ratio managed
    // by this corrected divider with its stale pre-drag internal value.
    const previousFetch = window.fetch.bind(window);
    window.fetch = function(input, init = {}) {
      const url = typeof input === "string" ? input : input?.url || "";
      if (splitRatioOverride !== null && url.startsWith("browser-layout://")) {
        try {
          const patch = JSON.parse(String(init.body || "{}"));
          if (Object.prototype.hasOwnProperty.call(patch, "split_ratio")) {
            patch.split_ratio = splitRatioOverride;
            init = {...init, body:JSON.stringify(patch)};
          }
        } catch (_) {}
      }
      return previousFetch(input, init);
    };

    function start(event) {
      if (event.button !== 0 || !workspace.classList.contains("split-preview")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drag = {pointerId:event.pointerId, anchor:captureAnchor()};
      workspace.classList.add("resizing");
      try { divider.setPointerCapture(event.pointerId); } catch (_) {}
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const bounds = workspace.getBoundingClientRect();
      if (!bounds.width) return;
      splitRatioOverride = clampRatio((event.clientX - bounds.left) / bounds.width);
      workspace.style.setProperty("--notes-ratio", String(splitRatioOverride));
      // The old implementation restored before flex layout had recomputed page
      // heights, which could jump to the adjacent PDF page. Restore only in rAF.
      scheduleRestore(drag.anchor);
    }
    function end(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const anchor = drag.anchor;
      drag = null;
      workspace.classList.remove("resizing");
      try { divider.releasePointerCapture(event.pointerId); } catch (_) {}
      splitRatioOverride = splitRatioOverride ?? currentRatio();
      requestAnimationFrame(() => {
        restoreAnchor(anchor);
        const payload = {
          split_ratio: splitRatioOverride,
          slides_scroll_top: Math.max(0, Math.round(slidesStage.scrollTop))
        };
        window.fetch("browser-layout://save", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)}).catch(console.error);
        // Re-render PDF canvases once at the settled width; the editor already has
        // a resize listener that handles canvas release/re-render correctly.
        window.dispatchEvent(new Event("resize"));
      });
    }
    divider.addEventListener("pointerdown", start, true);
    divider.addEventListener("pointermove", move, true);
    divider.addEventListener("pointerup", end, true);
    divider.addEventListener("pointercancel", end, true);
  }

  function install() {
    if (!profileId || !courseId || !materialId) return;
    installQuestionList();
    installInfoEditing();
    installStableDividerResize();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, {once:true});
  else install();
})();
