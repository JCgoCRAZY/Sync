"use strict";

(() => {
  let active = null;
  let ratioOverride = null;
  let moveFrame = null;
  let latestClientX = null;
  let shield = null;

  function clampRatio(value) {
    return Math.max(0.25, Math.min(0.75, Number(value) || 0.5));
  }

  function dividerElements() {
    return {
      divider: document.getElementById("split-divider"),
      workspace: document.getElementById("editor-workspace"),
      slidesStage: document.getElementById("slides-stage"),
      viewer: document.getElementById("slides-pdf-viewer")
    };
  }

  function currentRatio(workspace) {
    const css = getComputedStyle(workspace).getPropertyValue("--notes-ratio").trim();
    return clampRatio(parseFloat(css) || 0.5);
  }

  function captureAnchor(slidesStage, viewer) {
    const pages = [...viewer.querySelectorAll(".slides-pdf-page")];
    if (!pages.length || slidesStage.clientHeight <= 0) return null;

    const stageRect = slidesStage.getBoundingClientRect();
    const centerY = stageRect.top + stageRect.height / 2;
    let best = null;
    let bestDistance = Infinity;

    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      if (rect.height <= 0) continue;

      const distance =
        centerY < rect.top ? rect.top - centerY :
        centerY > rect.bottom ? centerY - rect.bottom :
        0;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = { page, rect };
        if (distance === 0) break;
      }
    }

    if (!best) return null;

    return {
      pageNumber: String(best.page.dataset.pageNumber || ""),
      fraction: Math.max(0, Math.min(1, (centerY - best.rect.top) / best.rect.height))
    };
  }

  function restoreAnchor(anchor, slidesStage, viewer) {
    if (!anchor?.pageNumber) return;

    const page = [...viewer.querySelectorAll(".slides-pdf-page")]
      .find(candidate =>
        String(candidate.dataset.pageNumber || "") === String(anchor.pageNumber)
      );

    if (!page) return;

    const stageRect = slidesStage.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    if (!stageRect.height || !pageRect.height) return;

    const desiredY = stageRect.top + stageRect.height / 2;
    const actualY = pageRect.top + pageRect.height * anchor.fraction;
    const delta = actualY - desiredY;

    if (Math.abs(delta) > 0.5) {
      slidesStage.scrollTop = Math.max(0, slidesStage.scrollTop + delta);
    }
  }

  function ensureStyle() {
    if (document.getElementById("stable-divider-v37-style")) return;

    const style = document.createElement("style");
    style.id = "stable-divider-v37-style";
    style.textContent = `
      /* Keep the visible divider thin while making it much easier to grab. */
      #split-divider{
        position:relative;
        z-index:40;
        overflow:visible;
      }
      #split-divider::before{
        content:"";
        position:absolute;
        top:0;
        bottom:0;
        left:-9px;
        right:-9px;
        cursor:col-resize;
        touch-action:none;
      }

      html.stable-divider-drag,
      html.stable-divider-drag body,
      html.stable-divider-drag *{
        cursor:col-resize !important;
      }
      html.stable-divider-drag,
      html.stable-divider-drag body{
        user-select:none !important;
        -webkit-user-select:none !important;
      }

      /* Prevent browser scroll anchoring from changing the PDF scroll position
         just because the page frames became wider/narrower during the drag. */
      html.stable-divider-drag #slides-stage{
        overflow-anchor:none !important;
      }

      .stable-divider-drag-shield{
        position:fixed;
        inset:0;
        z-index:2147483646;
        cursor:col-resize;
        touch-action:none;
        user-select:none;
        -webkit-user-select:none;
        background:transparent;
      }
    `;
    document.head.appendChild(style);
  }

  function installShield() {
    if (shield?.isConnected) return;
    shield = document.createElement("div");
    shield.className = "stable-divider-drag-shield";
    shield.setAttribute("aria-hidden", "true");
    document.body.appendChild(shield);
  }

  function removeShield() {
    if (shield?.isConnected) shield.remove();
    shield = null;
  }

  function applyLatestMove() {
    moveFrame = null;
    if (!active || latestClientX === null) return;

    const { workspace } = active;
    const bounds = workspace.getBoundingClientRect();
    if (!bounds.width) return;

    ratioOverride = clampRatio((latestClientX - bounds.left) / bounds.width);
    workspace.style.setProperty("--notes-ratio", String(ratioOverride));

    // Deliberately do NOTHING to slidesStage.scrollTop here.
    //
    // Previous versions re-centred the PDF on every pointer move. Each scrollTop
    // write fired the canonical slide scroll listener, which schedules PDF.js
    // viewport rendering/release while the pane is also changing width. That race
    // is what this implementation eliminates.
  }

  function queueMove(clientX) {
    latestClientX = clientX;
    if (moveFrame !== null) return;
    moveFrame = requestAnimationFrame(applyLatestMove);
  }

  function begin(event) {
    if (active || event.button !== 0) return;

    const { divider, workspace, slidesStage, viewer } = dividerElements();
    if (!divider || !workspace || !slidesStage || !viewer) return;

    const target = event.target;
    if (!(target instanceof Node) || !divider.contains(target)) return;
    if (!workspace.classList.contains("split-preview")) return;

    // Window capture runs before the old divider handlers at the target, so this
    // blocks both the canonical drag implementation and the older enhancement.
    event.preventDefault();
    event.stopImmediatePropagation();

    const previousOverflowAnchor = slidesStage.style.overflowAnchor;

    active = {
      pointerId: event.pointerId,
      divider,
      workspace,
      slidesStage,
      viewer,
      anchor: captureAnchor(slidesStage, viewer),
      startingScrollTop: slidesStage.scrollTop,
      previousOverflowAnchor
    };

    ratioOverride = currentRatio(workspace);
    latestClientX = event.clientX;
    workspace.classList.add("resizing");
    document.documentElement.classList.add("stable-divider-drag");
    slidesStage.style.overflowAnchor = "none";

    installShield();

    // Pointer capture is the first line of defence. The fixed drag shield +
    // window-capture listeners below are the fallback, so even very fast cursor
    // motion into Notes/Slides cannot terminate the resize.
    try { divider.setPointerCapture(event.pointerId); } catch (_) {}

    queueMove(event.clientX);
  }

  function move(event) {
    if (!active || event.pointerId !== active.pointerId) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    queueMove(event.clientX);
  }

  function saveLayout(activeDrag) {
    const payload = {
      split_ratio: ratioOverride ?? currentRatio(activeDrag.workspace),
      slides_scroll_top: Math.max(0, Math.round(activeDrag.slidesStage.scrollTop))
    };

    window.fetch("browser-layout://save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(console.error);
  }

  function finish(event, cancelled = false) {
    if (!active) return;
    if (event?.pointerId != null && event.pointerId !== active.pointerId) return;

    if (event) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    }

    const drag = active;

    // Apply the final mouse position before releasing the drag.
    if (!cancelled && event && Number.isFinite(event.clientX)) {
      latestClientX = event.clientX;
    }
    if (moveFrame !== null) {
      cancelAnimationFrame(moveFrame);
      moveFrame = null;
    }
    if (!cancelled) applyLatestMove();

    active = null;
    latestClientX = null;

    try {
      if (drag.divider.hasPointerCapture?.(drag.pointerId)) {
        drag.divider.releasePointerCapture(drag.pointerId);
      }
    } catch (_) {}

    removeShield();
    document.documentElement.classList.remove("stable-divider-drag");
    drag.workspace.classList.remove("resizing");
    drag.slidesStage.style.overflowAnchor = drag.previousOverflowAnchor || "";

    if (cancelled) {
      return;
    }

    // Wait until flex layout has fully settled, then restore the SAME point on
    // the SAME PDF page exactly once. One scroll event after the drag is safe;
    // dozens of scroll/render cycles during the drag were not.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreAnchor(drag.anchor, drag.slidesStage, drag.viewer);
        requestAnimationFrame(() => saveLayout(drag));
      });
    });
  }

  // Keep our split ratio authoritative when the canonical editor later saves its
  // internal layout state during autosave/close. Its private splitRatio variable
  // is not updated because v37 intentionally bypasses its unstable drag handler.
  const previousFetch = window.fetch.bind(window);
  window.fetch = function dividerStableFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (ratioOverride !== null && url.startsWith("browser-layout://")) {
      try {
        const patch = JSON.parse(String(init.body || "{}"));
        if (Object.prototype.hasOwnProperty.call(patch, "split_ratio")) {
          patch.split_ratio = ratioOverride;
          init = { ...init, body: JSON.stringify(patch) };
        }
      } catch (_) {}
    }
    return previousFetch(input, init);
  };

  ensureStyle();

  // Window capture deliberately outranks every old target-level divider listener.
  window.addEventListener("pointerdown", begin, { capture: true, passive: false });
  window.addEventListener("pointermove", move, { capture: true, passive: false });
  window.addEventListener("pointerup", event => finish(event, false), { capture: true, passive: false });
  window.addEventListener("pointercancel", event => finish(event, true), { capture: true, passive: false });

  // If the browser loses focus during a mouse drag, end cleanly instead of
  // leaving the editor permanently in a resizing state.
  window.addEventListener("blur", () => {
    if (active) finish(null, false);
  });
})();
