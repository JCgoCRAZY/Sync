"use strict";

/*
  University Study Hub — keyboard navigation hardening
  -----------------------------------------------------
  Owns ONLY vertical navigation in general app screens:
  Dashboard → Notes → Courses → Schedule Setup → Settings.

  It deliberately does NOT intercept:
  - Left/right inside Course pages (Overview / Study Material)
  - Right from Schedule Setup to Calendar
  - Left/right inside Schedule Calendar (previous/next week)
  - Arrow keys while typing/editing in inputs, selects, textareas, etc.
*/
(() => {
  function navigationBlocked(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true;
    if (document.getElementById("modal-root")?.children?.length) return true;

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]'
    )) return true;

    return false;
  }

  function verticalItems() {
    return [
      { page: "dashboard" },
      { page: "notes" },
      ...orderedCourses().map(course => ({
        page: "course",
        courseId: course.id
      })),
      { page: "schedule" },
      { page: "settings" }
    ];
  }

  function currentIndex(items) {
    if (route.page === "course") {
      return items.findIndex(item =>
        item.page === "course" &&
        String(item.courseId) === String(route.courseId)
      );
    }
    return items.findIndex(item => item.page === route.page);
  }

  function focusPageAfterNavigation() {
    requestAnimationFrame(() => {
      const page = document.getElementById("page");
      if (!page) return;
      try {
        page.focus({ preventScroll: true });
      } catch {
        page.focus();
      }
    });
  }

  function navigateToItem(item) {
    const profile = activeProfile();

    // Schedule reached through ↑/↓ navigation must ALWAYS open in Setup.
    if (item.page === "schedule") {
      profile.schedule ||= {};
      profile.schedule._web_view = "setup";
    }

    if (item.page === "course") {
      const tab = route.page === "course"
        ? normalizeCourseTab(route.tab)
        : courseTabForSwitch(item.courseId);

      navTo("course", {
        courseId: item.courseId,
        tab
      });
    } else {
      navTo(item.page);
    }

    focusPageAfterNavigation();

    // Render watchdog: navigation should never leave the header changed while
    // the content area is empty because of a transient rerender/focus issue.
    requestAnimationFrame(() => {
      const page = document.getElementById("page");
      const expectedTitle =
        item.page === "dashboard" ? "Dashboard" :
        item.page === "notes" ? "Notes" :
        item.page === "schedule" ? "Schedule" :
        item.page === "settings" ? "Settings" : null;

      const title = document.getElementById("page-title")?.textContent?.trim();

      if (
        route.page === item.page &&
        (!page || !page.firstElementChild || (expectedTitle && title !== expectedTitle))
      ) {
        console.warn("Navigation render watchdog recovered", item.page);
        render();
        focusPageAfterNavigation();
      }
    });
  }

  document.addEventListener("keydown", event => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (navigationBlocked(event)) return;

    // In Calendar view, vertical arrows are not global navigation.
    // The existing left/right previous/next-week behavior remains untouched.
    if (route.page === "schedule") {
      const view = activeProfile().schedule?._web_view || "calendar";
      if (view !== "setup") return;
    }

    if (!["dashboard", "notes", "course", "schedule", "settings"].includes(route.page)) {
      return;
    }

    const items = verticalItems();
    const index = currentIndex(items);
    if (index < 0) return;

    const delta = event.key === "ArrowUp" ? -1 : 1;
    const target = items[index + delta];
    if (!target) return;

    // Capture and stop the original bubbling handler from also processing this key.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    try {
      navigateToItem(target);
    } catch (error) {
      console.error("Keyboard navigation failed:", error);

      // One immediate retry from a clean page focus is safer than leaving the
      // application apparently frozen on the previous section.
      try {
        document.getElementById("page")?.blur?.();
        navigateToItem(target);
      } catch (retryError) {
        console.error("Keyboard navigation retry failed:", retryError);
        if (typeof toast === "function") {
          toast("Navigation could not complete. Click the destination once, then try the arrows again.", 4500);
        }
      }
    }
  }, true);
})();
