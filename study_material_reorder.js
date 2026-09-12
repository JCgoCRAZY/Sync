"use strict";

(() => {
  const UNGROUPED_KEY = "__ungrouped__";
  const UNIT_DRAG_HANDLE = "[data-unit-drag-handle]";
  const MATERIAL_DRAG_HANDLE = "[data-material-drag-handle]";
  let dragState = null;

  function installStyles() {
    if (document.getElementById("study-material-reorder-styles")) return;
    const style = document.createElement("style");
    style.id = "study-material-reorder-styles";
    style.textContent = `
      .material-unit[data-sortable-unit="true"] { transition: transform .12s ease, opacity .12s ease, outline-color .12s ease; }
      .material-unit-head { gap: 8px; }
      .material-unit-drag-handle,
      .material-drag-handle {
        border: 0;
        background: transparent;
        color: var(--muted, #91a4b4);
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        font-weight: 900;
        letter-spacing: -2px;
      }
      .material-unit-drag-handle { width: 34px; min-width: 34px; height: 34px; font-size: 18px; border-radius: 8px; }
      .material-drag-handle { width: 30px; min-width: 30px; height: 36px; font-size: 17px; border-radius: 8px; }
      .material-unit-drag-handle:hover,
      .material-drag-handle:hover { background: rgba(145,164,180,.13); color: var(--text, #f1f5f9); }
      .material-unit-drag-handle:active,
      .material-drag-handle:active { cursor: grabbing; }
      .material-card[data-sortable-material="true"] { transition: opacity .12s ease, transform .12s ease, outline-color .12s ease; }
      .ush-dragging { opacity: .42 !important; }
      .ush-drop-before { box-shadow: 0 -3px 0 #26c8b8 !important; }
      .ush-drop-after { box-shadow: 0 3px 0 #26c8b8 !important; }
      .material-unit.ush-unit-drop-before { box-shadow: 0 -4px 0 #26c8b8 !important; }
      .material-unit.ush-unit-drop-after { box-shadow: 0 4px 0 #26c8b8 !important; }
      .material-unit-body.ush-unit-body-drop {
        outline: 2px dashed #26c8b8;
        outline-offset: -5px;
        border-radius: 10px;
      }
      .material-unit[data-unit-key="${UNGROUPED_KEY}"] .material-unit-head strong::after {
        content: " • drop any Lecture here";
        color: var(--muted, #91a4b4);
        font-size: 12px;
        font-weight: 500;
      }
      @media (pointer: coarse) {
        .material-unit-drag-handle,
        .material-drag-handle { min-width: 42px; min-height: 42px; font-size: 20px; }
      }
    `;
    document.head.appendChild(style);
  }

  function normalizeUnitOrder(course, persist = false) {
    course.material_units ||= [];
    const valid = new Set(course.material_units.map(unit => String(unit.id)));
    valid.add(UNGROUPED_KEY);

    const source = Array.isArray(course.material_unit_order) ? course.material_unit_order.map(String) : [];
    const next = [];
    for (const id of source) {
      if (valid.has(id) && !next.includes(id)) next.push(id);
    }

    // Preserve every explicit unit position. Newly created units are appended,
    // while legacy courses with no saved layout still default to Units → Ungrouped.
    const missing = course.material_units.map(unit => String(unit.id)).filter(id => !next.includes(id));
    next.push(...missing);
    if (!next.includes(UNGROUPED_KEY)) next.push(UNGROUPED_KEY);

    const changed = !Array.isArray(course.material_unit_order)
      || course.material_unit_order.length !== next.length
      || course.material_unit_order.some((id, index) => String(id) !== next[index]);

    course.material_unit_order = next;
    if (persist && changed && typeof queueSave === "function") queueSave();
    return next;
  }

  function materialUnitKey(material, validUnits) {
    const id = material?.unit_id ? String(material.unit_id) : "";
    return id && validUnits.has(id) ? id : UNGROUPED_KEY;
  }

  function materialCardHtml(course, material, unitKey) {
    return `<div class="material-card" data-sortable-material="true" data-material-id="${escapeHtml(material.id)}" data-unit-key="${escapeHtml(unitKey)}">
      <button type="button" class="material-drag-handle" data-material-drag-handle="${escapeHtml(material.id)}" title="Drag to reorder or move this Lecture" aria-label="Drag to reorder ${escapeHtml(material.title || 'Lecture')}">⋮⋮</button>
      <div class="material-icon">📄</div>
      <div class="list-main"><div class="list-title">${escapeHtml(material.title||'Untitled Document')}</div><div class="list-copy">Updated ${formatDateTime(material.updated_at||material.created_at)}</div></div>
      <div class="material-actions"><button class="primary-button" data-open-material="${course.id}|${material.id}">Open</button><button class="secondary-button" data-material-quiz="${material.id}">Quiz</button><button class="secondary-button" data-material-terms="${material.id}">Terms</button><button class="secondary-button" data-material-remove-pdf="${material.id}" hidden>Remove PDF</button><button class="danger-button" data-material-delete="${material.id}">Delete</button></div>
    </div>`;
  }

  function unitSectionHtml(course, unitKey, materials, unitById) {
    const ungrouped = unitKey === UNGROUPED_KEY;
    const unit = ungrouped ? null : unitById.get(unitKey);
    if (!ungrouped && !unit) return "";
    const title = ungrouped ? "Ungrouped" : (unit.title || "Unit");
    const actions = ungrouped
      ? ""
      : `<button class="secondary-button" data-unit-rename="${escapeHtml(unit.id)}">Rename</button><button class="danger-button" data-unit-delete="${escapeHtml(unit.id)}">Delete</button>`;
    const cards = materials.map(material => materialCardHtml(course, material, unitKey)).join("");
    return `<section class="material-unit" data-sortable-unit="true" data-unit-key="${escapeHtml(unitKey)}">
      <div class="material-unit-head">
        <button type="button" class="material-unit-drag-handle" data-unit-drag-handle="${escapeHtml(unitKey)}" title="Drag this unit" aria-label="Drag ${escapeHtml(title)}">⋮⋮</button>
        <strong style="flex:1">${escapeHtml(title)}</strong>${actions}
      </div>
      <div class="material-unit-body" data-unit-drop-zone="${escapeHtml(unitKey)}">${cards || `<div class="empty">${ungrouped ? 'No ungrouped Lectures.' : 'No lectures in this unit.'}</div>`}</div>
    </section>`;
  }

  function upgradedCourseMaterials(course) {
    const unitOrder = normalizeUnitOrder(course);
    const unitById = new Map((course.material_units || []).map(unit => [String(unit.id), unit]));
    const validUnits = new Set(unitById.keys());
    const byUnit = new Map(unitOrder.map(key => [key, []]));

    for (const material of course.materials || []) {
      const key = materialUnitKey(material, validUnits);
      if (!byUnit.has(key)) byUnit.set(key, []);
      byUnit.get(key).push(material);
    }

    const unitsHtml = unitOrder.map(key => unitSectionHtml(course, key, byUnit.get(key) || [], unitById)).join("");
    return `<section class="card"><div class="card-header"><div><h2>Study Material</h2><div class="card-subtitle">Lecture documents, PDFs, terms and quizzes • drag Lectures or whole units to reorder them</div></div><div class="action-row"><button id="add-unit" class="secondary-button">＋ Unit</button><button id="add-lecture" class="primary-button">＋ Lecture</button></div></div><div class="list" style="gap:12px" data-study-material-sort-root>${unitsHtml}</div></section>`;
  }

  function clearDropIndicators() {
    document.querySelectorAll(".ush-drop-before,.ush-drop-after,.ush-unit-drop-before,.ush-unit-drop-after,.ush-unit-body-drop")
      .forEach(node => node.classList.remove("ush-drop-before","ush-drop-after","ush-unit-drop-before","ush-unit-drop-after","ush-unit-body-drop"));
  }

  function setDraggedVisual(active) {
    dragState?.sourceElement?.classList.toggle("ush-dragging", active);
  }

  function unitForMaterialTarget(target) {
    const unit = target?.closest?.(".material-unit[data-unit-key]");
    return unit?.dataset.unitKey || UNGROUPED_KEY;
  }

  function materialTargetAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const card = hit?.closest?.(".material-card[data-material-id]");
    if (card) {
      const rect = card.getBoundingClientRect();
      return {card, unitKey: unitForMaterialTarget(card), after: y >= rect.top + rect.height / 2};
    }
    const body = hit?.closest?.(".material-unit-body[data-unit-drop-zone]");
    if (body) return {body, unitKey: body.dataset.unitDropZone || UNGROUPED_KEY, after: true};
    const unit = hit?.closest?.(".material-unit[data-unit-key]");
    if (unit) return {body: unit.querySelector(".material-unit-body"), unitKey: unit.dataset.unitKey || UNGROUPED_KEY, after: true};
    return null;
  }

  function unitTargetAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const unit = hit?.closest?.(".material-unit[data-unit-key]");
    if (!unit) return null;
    const rect = unit.getBoundingClientRect();
    return {unit, unitKey: unit.dataset.unitKey, after: y >= rect.top + rect.height / 2};
  }

  function reorderMaterial(course, materialId, target) {
    const materials = course.materials || [];
    const fromIndex = materials.findIndex(item => String(item.id) === String(materialId));
    if (fromIndex < 0 || !target) return false;
    const [moved] = materials.splice(fromIndex, 1);
    moved.unit_id = target.unitKey === UNGROUPED_KEY ? null : target.unitKey;

    if (target.card) {
      let targetIndex = materials.findIndex(item => String(item.id) === String(target.card.dataset.materialId));
      if (targetIndex < 0) targetIndex = materials.length;
      if (target.after) targetIndex += 1;
      materials.splice(Math.min(targetIndex, materials.length), 0, moved);
    } else {
      // Append to the end of the destination unit while keeping every other unit's
      // relative order intact.
      const validUnits = new Set((course.material_units || []).map(unit => String(unit.id)));
      let insertAt = materials.length;
      for (let i = materials.length - 1; i >= 0; i -= 1) {
        if (materialUnitKey(materials[i], validUnits) === target.unitKey) {
          insertAt = i + 1;
          break;
        }
      }
      materials.splice(insertAt, 0, moved);
    }

    materials.forEach((material, index) => { material.order = index; });
    course.updated_at = typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    return true;
  }

  function reorderUnit(course, unitKey, target) {
    if (!target || !target.unitKey || target.unitKey === unitKey) return false;
    const order = normalizeUnitOrder(course).slice();
    const fromIndex = order.indexOf(unitKey);
    if (fromIndex < 0) return false;
    order.splice(fromIndex, 1);
    let targetIndex = order.indexOf(target.unitKey);
    if (targetIndex < 0) targetIndex = order.length;
    if (target.after) targetIndex += 1;
    order.splice(Math.min(targetIndex, order.length), 0, unitKey);
    course.material_unit_order = order;
    course.updated_at = typeof nowIso === "function" ? nowIso() : new Date().toISOString();
    return true;
  }

  function beginDrag(event, course) {
    const handle = event.target.closest(`${UNIT_DRAG_HANDLE},${MATERIAL_DRAG_HANDLE}`);
    if (!handle || event.button !== 0) return;
    const unitHandle = handle.matches(UNIT_DRAG_HANDLE);
    const sourceElement = unitHandle
      ? handle.closest(".material-unit[data-unit-key]")
      : handle.closest(".material-card[data-material-id]");
    if (!sourceElement) return;

    event.preventDefault();
    event.stopPropagation();
    dragState = {
      course,
      type: unitHandle ? "unit" : "material",
      id: unitHandle ? handle.dataset.unitDragHandle : handle.dataset.materialDragHandle,
      pointerId: event.pointerId,
      handle,
      sourceElement,
      target: null
    };
    setDraggedVisual(true);
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  }

  function autoScrollStudyMaterial(clientY) {
    const scroller = document.getElementById("page");
    if (!scroller) return;
    const edge = 72;
    let delta = 0;
    if (clientY < edge) delta = -Math.max(8, Math.round((edge - clientY) * 0.34));
    else if (clientY > window.innerHeight - edge) delta = Math.max(8, Math.round((clientY - (window.innerHeight - edge)) * 0.34));
    if (delta) scroller.scrollTop += delta;
  }

  function moveDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    autoScrollStudyMaterial(event.clientY);
    clearDropIndicators();

    const target = dragState.type === "unit"
      ? unitTargetAt(event.clientX, event.clientY)
      : materialTargetAt(event.clientX, event.clientY);
    dragState.target = target;
    if (!target) return;

    if (dragState.type === "unit") {
      if (target.unitKey === dragState.id) { dragState.target = null; return; }
      target.unit.classList.add(target.after ? "ush-unit-drop-after" : "ush-unit-drop-before");
    } else if (target.card) {
      if (String(target.card.dataset.materialId) === String(dragState.id)) { dragState.target = null; return; }
      target.card.classList.add(target.after ? "ush-drop-after" : "ush-drop-before");
    } else if (target.body) {
      target.body.classList.add("ush-unit-body-drop");
    }
  }

  function finishDrag(event, cancelled = false) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const state = dragState;
    dragState = null;
    clearDropIndicators();
    state.sourceElement.classList.remove("ush-dragging");
    try { state.handle.releasePointerCapture(event.pointerId); } catch (_) {}
    if (cancelled || !state.target) return;

    const changed = state.type === "unit"
      ? reorderUnit(state.course, state.id, state.target)
      : reorderMaterial(state.course, state.id, state.target);
    if (!changed) return;
    queueSave();
    renderCourse();
  }

  function installSortHandlers(course) {
    const root = document.querySelector("[data-study-material-sort-root]");
    if (!root || root.dataset.sortHandlersInstalled === "true") return;
    root.dataset.sortHandlersInstalled = "true";
    root.addEventListener("pointerdown", event => beginDrag(event, course), true);
    root.addEventListener("pointermove", moveDrag, true);
    root.addEventListener("pointerup", event => finishDrag(event, false), true);
    root.addEventListener("pointercancel", event => finishDrag(event, true), true);
  }

  function installOverrides() {
    installStyles();
    if (typeof courseMaterials !== "function" || typeof bindCoursePage !== "function") return;

    const originalBindCoursePage = bindCoursePage;
    courseMaterials = upgradedCourseMaterials;
    bindCoursePage = function upgradedBindCoursePage(course) {
      originalBindCoursePage(course);
      if (route?.tab === "Study Material") installSortHandlers(course);
    };

    // Open Lectures through a tiny bootstrap page that loads the canonical editor
    // and then adds the v28 editor enhancements. The editor itself stays the source
    // of truth; this avoids duplicating or forking its large HTML file.
    if (typeof openMaterial === "function") {
      openMaterial = async function upgradedOpenMaterial(courseId, materialId) {
        const profile = activeProfile();
        const course = profile?.courses?.[courseId];
        const material = course?.materials?.find(item => String(item.id) === String(materialId));
        if (!material) return;
        material.last_opened_at = typeof nowIso === "function" ? nowIso() : new Date().toISOString();
        queueSave(false);
        const params = new URLSearchParams({
          profile: state.active_profile_id,
          course: courseId,
          material: materialId
        });
        location.href = `editor/editor_bootstrap.html?${params}`;
      };
    }

    // Normalize old courses lazily without creating a save unless a Study Material
    // page is actually rendered/changed.
    try {
      if (typeof state !== "undefined" && state) {
        const profile = typeof activeProfile === "function" ? activeProfile() : null;
        for (const course of Object.values(profile?.courses || {})) normalizeUnitOrder(course, false);
        if (route?.page === "course" && route?.tab === "Study Material") renderCourse();
      }
    } catch (error) {
      console.error("Study Material reorder upgrade could not initialize", error);
    }
  }

  installOverrides();
})();
