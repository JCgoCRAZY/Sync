"use strict";

(() => {
  const THREE_DAYS_MS = 72 * 60 * 60 * 1000;
  const BASE_RENDER_SIDEBAR = renderSidebar;

  function compactOpenedTime(value) {
    const date = new Date(value);
    if (Number.isNaN(+date)) return "";
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function recentLecturesWithinThreeDays() {
    const cutoff = Date.now() - THREE_DAYS_MS;
    const found = new Map();

    for (const course of orderedCourses(activeProfile())) {
      for (const material of course.materials || []) {
        const openedAt = String(material?.last_opened_at || "");
        const ts = Date.parse(openedAt);
        if (!Number.isFinite(ts) || ts < cutoff) continue;

        // Use the material id as the durable identity. This also prevents a
        // duplicated course-material reference from producing repeated cards.
        const key = String(material?.id || "");
        if (!key) continue;

        const previous = found.get(key);
        if (!previous || ts > previous.ts) {
          found.set(key, { course, material, ts, openedAt });
        }
      }
    }

    return [...found.values()].sort((a, b) => b.ts - a.ts);
  }

  function installSidebarLayoutStyles() {
    if (document.getElementById("sidebar-layout-v33-style")) return;

    const style = document.createElement("style");
    style.id = "sidebar-layout-v33-style";
    style.textContent = `
      /* Courses stop consuming all remaining sidebar height. They grow naturally
         to a practical cap; additional courses remain accessible by scrolling. */
      .sidebar > .course-nav{
        flex:0 1 auto !important;
        min-height:0 !important;
        max-height:clamp(190px,34vh,330px) !important;
        overflow-x:hidden !important;
        overflow-y:auto !important;
        padding-right:3px;
        margin-bottom:0 !important;
        scrollbar-width:thin;
        scrollbar-color:rgba(145,164,180,.42) transparent;
      }
      .sidebar > .course-nav::-webkit-scrollbar{width:5px}
      .sidebar > .course-nav::-webkit-scrollbar-thumb{
        background:rgba(145,164,180,.42);
        border-radius:99px;
      }
      .sidebar > .course-nav::-webkit-scrollbar-track{background:transparent}

      /* Keep Add course visually attached to the course list. */
      .sidebar > #add-course-nav{
        flex:none;
        margin-top:2px !important;
        margin-bottom:0 !important;
      }

      .sidebar > #all-courses-sidebar-button{
        flex:none;
        margin-top:7px;
      }

      /* Most Recent owns the remaining flexible sidebar height. */
      .sidebar > #most-recent-sidebar{
        flex:1 1 auto;
        min-height:0;
        display:flex;
        flex-direction:column;
        margin:12px -2px 4px !important;
        padding-top:0;
        overflow:hidden;
      }
      #most-recent-sidebar h3{
        flex:none;
        margin:0 12px 8px;
      }

      /* Vertical, unlimited list. The container scrolls instead of limiting
         the number of cards or turning the cards into a horizontal carousel. */
      #most-recent-sidebar .most-recent-track{
        flex:1 1 auto;
        min-height:0;
        width:100%;
        display:flex !important;
        flex-direction:column !important;
        gap:5px;
        overflow-x:hidden !important;
        overflow-y:auto !important;
        scroll-snap-type:none !important;
        scrollbar-width:thin;
        scrollbar-color:rgba(145,164,180,.42) transparent;
      }
      #most-recent-sidebar .most-recent-track::-webkit-scrollbar{width:5px;height:5px}
      #most-recent-sidebar .most-recent-track::-webkit-scrollbar-thumb{
        background:rgba(145,164,180,.42);
        border-radius:99px;
      }
      #most-recent-sidebar .most-recent-track::-webkit-scrollbar-track{background:transparent}

      #most-recent-sidebar .most-recent-card{
        flex:0 0 auto !important;
        width:100% !important;
        min-width:0 !important;
        scroll-snap-align:none !important;
        border-radius:8px;
        border:1px solid color-mix(in srgb,var(--course-accent) 20%,transparent);
      }
      #most-recent-sidebar .most-recent-card.dominant{
        flex-basis:auto !important;
      }
      #most-recent-sidebar .most-recent-empty{
        flex:1 1 auto;
        overflow:auto;
      }

      /* Keep Schedule / Settings anchored below the flexible Recent area. */
      .sidebar > .utility-nav{
        flex:none !important;
      }

      @media (max-height:720px){
        .sidebar > .course-nav{max-height:clamp(150px,29vh,245px) !important}
        .sidebar > #most-recent-sidebar{margin-top:8px !important}
      }
    `;
    document.head.appendChild(style);
  }

  function rebuildMostRecentSidebar() {
    const addButton = document.getElementById("add-course-nav");
    if (!addButton) return;

    let section = document.getElementById("most-recent-sidebar");
    if (!section) {
      section = document.createElement("section");
      section.id = "most-recent-sidebar";
      section.className = "most-recent-sidebar";

      const allCoursesButton = document.getElementById("all-courses-sidebar-button");
      (allCoursesButton || addButton).insertAdjacentElement("afterend", section);
    }

    const recent = recentLecturesWithinThreeDays();

    if (!recent.length) {
      section.innerHTML = `
        <h3>Most recent</h3>
        <div class="most-recent-empty">
          Lectures opened within the last 3 days will appear here.
        </div>`;
      return;
    }

    section.innerHTML = `
      <h3>Most recent</h3>
      <div class="most-recent-track"
           aria-label="Lectures opened within the last 3 days">
        ${recent.map((item, index) => `
          <div class="most-recent-card ${index === 0 ? "dominant" : ""}"
               style="--course-accent:${escapeHtml(courseColor(item.course))}">
            <span class="most-recent-accent" aria-hidden="true"></span>
            <div class="material-icon">📄</div>
            <div class="most-recent-copy">
              <strong>${escapeHtml(item.material.title || "Untitled Document")}</strong>
              <small>${escapeHtml(item.course.code)} • Opened ${escapeHtml(compactOpenedTime(item.openedAt))}</small>
            </div>
            <button class="primary-button"
                    type="button"
                    data-recent-course="${escapeHtml(item.course.id)}"
                    data-recent-material="${escapeHtml(item.material.id)}">
              Open
            </button>
          </div>
        `).join("")}
      </div>`;

    section.querySelectorAll("[data-recent-course][data-recent-material]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        openMaterial(button.dataset.recentCourse, button.dataset.recentMaterial);
      });
    });
  }

  function applySidebarEnhancement() {
    installSidebarLayoutStyles();
    rebuildMostRecentSidebar();
  }

  renderSidebar = function sidebarLayoutV33RenderSidebar() {
    BASE_RENDER_SIDEBAR();
    applySidebarEnhancement();
  };

  // The normal initial render runs after all defer scripts. This extra call is
  // defensive for hot-cache/PWA cases where the sidebar already exists.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      requestAnimationFrame(applySidebarEnhancement);
    }, { once: true });
  } else {
    requestAnimationFrame(applySidebarEnhancement);
  }
})();
