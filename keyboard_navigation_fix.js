"use strict";

(() => {
  let lockedUntil = 0;

  function blocked(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true;
    if (document.getElementById("modal-root")?.children?.length) return true;
    const target = event.target instanceof Element ? event.target : null;
    return Boolean(target?.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
  }

  function items() {
    return [
      { page: "dashboard" },
      { page: "notes" },
      ...orderedCourses().map(course => ({ page: "course", courseId: course.id })),
      { page: "schedule" },
      { page: "settings" }
    ];
  }

  function indexOfCurrent(list) {
    if (route.page === "course") {
      return list.findIndex(item => item.page === "course" && String(item.courseId) === String(route.courseId));
    }
    return list.findIndex(item => item.page === route.page);
  }

  function navigate(item) {
    // Remove focus from buttons/scrolling controls before replacing the page.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    if (item.page === "schedule") {
      const profile = activeProfile();
      profile.schedule ||= {};
      profile.schedule._web_view = "setup";
    }

    if (item.page === "course") {
      navTo("course", {
        courseId: item.courseId,
        tab: route.page === "course" ? normalizeCourseTab(route.tab) : courseTabForSwitch(item.courseId)
      });
    } else {
      navTo(item.page);
    }

    requestAnimationFrame(() => {
      const page = document.getElementById("page");
      if (page) {
        try { page.focus({ preventScroll: true }); }
        catch { page.focus(); }
      }
    });
  }

  document.addEventListener("keydown", event => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (blocked(event) || performance.now() < lockedUntil) return;

    if (route.page === "schedule") {
      const view = activeProfile().schedule?._web_view || "calendar";
      if (view !== "setup") return;
    }
    if (!["dashboard","notes","course","schedule","settings"].includes(route.page)) return;

    const list = items();
    const index = indexOfCurrent(list);
    const target = list[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (index < 0 || !target) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    lockedUntil = performance.now() + 120;

    try { navigate(target); }
    catch (error) {
      console.error("Navigation failed", error);
      if (typeof toast === "function") toast("Navigation recovered from an error. Click the destination if needed.", 3500);
    }
  }, true);
})();
