"use strict";

(() => {
  let lockedUntil = 0;
  let scheduleShortcutHeld = false;
  let controlKeyDown = false;
  let shiftKeyDown = false;

  function blocked(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return true;
    if (document.getElementById("modal-root")?.children?.length) return true;
    const target = event.target instanceof Element ? event.target : null;
    return Boolean(target?.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'));
  }

  function scheduleShortcutAllowed() {
    if (document.getElementById("modal-root")?.children?.length) return false;
    const authGate = document.getElementById("auth-gate");
    if (authGate && !authGate.hidden) return false;
    return Boolean(
      typeof state !== "undefined" &&
      state &&
      typeof activeProfile === "function" &&
      typeof navTo === "function"
    );
  }

  function openScheduleCalendarFromShortcut() {
    if (!scheduleShortcutAllowed()) return;

    const profile = activeProfile();
    profile.schedule ||= {};
    profile.schedule._web_view = "calendar";

    if (typeof mondayOf === "function" && typeof dateKey === "function") {
      profile.schedule.calendar_week = dateKey(mondayOf(new Date()));
    }

    navTo("schedule");
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
    if (event.key === "Control") controlKeyDown = true;
    if (event.key === "Shift") shiftKeyDown = true;

    // Main-app shortcut: Tab always returns to Dashboard.
    // This script is not loaded inside Lecture documents.
    if (
      event.key === "Tab" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      scheduleShortcutAllowed()
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      try {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        navTo("dashboard");
      } catch (error) {
        console.error("Dashboard shortcut failed", error);
        if (typeof toast === "function") {
          toast("Dashboard shortcut could not open. Try again.", 3000);
        }
      }
      return;
    }

    const isScheduleChord =
      (event.key === "Control" || event.key === "Shift") &&
      (event.ctrlKey || controlKeyDown) &&
      (event.shiftKey || shiftKeyDown) &&
      !event.altKey &&
      !event.metaKey;

    if (isScheduleChord) {
      if (!scheduleShortcutHeld && scheduleShortcutAllowed()) {
        scheduleShortcutHeld = true;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        try {
          openScheduleCalendarFromShortcut();
        } catch (error) {
          console.error("Schedule shortcut failed", error);
          if (typeof toast === "function") {
            toast("Schedule shortcut could not open. Try again.", 3000);
          }
        }
      }
      return;
    }

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
      if (typeof toast === "function") {
        toast("Navigation recovered from an error. Click the destination if needed.", 3500);
      }
    }
  }, true);

  document.addEventListener("keyup", event => {
    if (event.key === "Control") controlKeyDown = false;
    if (event.key === "Shift") shiftKeyDown = false;

    if (!controlKeyDown || !shiftKeyDown) {
      scheduleShortcutHeld = false;
    }
  }, true);

  window.addEventListener("blur", () => {
    scheduleShortcutHeld = false;
    controlKeyDown = false;
    shiftKeyDown = false;
  });
})();
