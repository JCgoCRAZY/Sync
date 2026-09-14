"use strict";

(() => {
  const BASE_EVENT_DIALOG = eventDialog;

  function digitsOnly(value, maxLength) {
    return String(value || "").replace(/\D/g, "").slice(0, maxLength);
  }

  function validDateParts(yearText, monthText, dayText) {
    if (yearText.length !== 4 || monthText.length !== 2 || dayText.length !== 2) return null;

    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);

    if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;

    const check = new Date(year, month - 1, day);
    if (
      check.getFullYear() !== year ||
      check.getMonth() !== month - 1 ||
      check.getDate() !== day
    ) return null;

    return `${yearText}-${monthText}-${dayText}`;
  }

  function selectField(input) {
    try {
      input.focus({ preventScroll: true });
      input.select();
    } catch (_) {
      input.focus();
    }
  }

  function installSegmentedEventDate() {
    const nativeDate = document.getElementById("event-date");
    if (!nativeDate || nativeDate.dataset.segmentedDateInstalled === "true") return;

    const field = nativeDate.closest(".field");
    if (!field) return;

    nativeDate.dataset.segmentedDateInstalled = "true";
    nativeDate.classList.add("event-date-native-proxy");
    nativeDate.setAttribute("aria-hidden", "true");
    nativeDate.tabIndex = -1;

    const [initialYear = "", initialMonth = "", initialDay = ""] =
      String(nativeDate.value || "").split("-");

    const segmented = document.createElement("div");
    segmented.className = "event-date-segmented";
    segmented.innerHTML = `
      <input class="event-date-part event-date-year"
             data-event-date-part="year"
             type="text"
             inputmode="numeric"
             autocomplete="off"
             maxlength="4"
             placeholder="YYYY"
             aria-label="Event year"
             value="${escapeHtml(initialYear)}">
      <span class="event-date-separator" aria-hidden="true">-</span>
      <input class="event-date-part event-date-month"
             data-event-date-part="month"
             type="text"
             inputmode="numeric"
             autocomplete="off"
             maxlength="2"
             placeholder="MM"
             aria-label="Event month"
             value="${escapeHtml(initialMonth)}">
      <span class="event-date-separator" aria-hidden="true">-</span>
      <input class="event-date-part event-date-day"
             data-event-date-part="day"
             type="text"
             inputmode="numeric"
             autocomplete="off"
             maxlength="2"
             placeholder="DD"
             aria-label="Event day"
             value="${escapeHtml(initialDay)}">
      <button class="event-date-picker-button"
              type="button"
              aria-label="Open calendar"
              title="Open calendar">▣</button>
      <div class="event-date-entry-hint" aria-live="polite"></div>
    `;

    nativeDate.insertAdjacentElement("afterend", segmented);

    const year = segmented.querySelector('[data-event-date-part="year"]');
    const month = segmented.querySelector('[data-event-date-part="month"]');
    const day = segmented.querySelector('[data-event-date-part="day"]');
    const picker = segmented.querySelector(".event-date-picker-button");
    const hint = segmented.querySelector(".event-date-entry-hint");
    const timeInput = document.getElementById("event-time");

    const parts = [year, month, day];

    function setHint(message = "", invalid = false) {
      hint.textContent = message;
      segmented.classList.toggle("invalid", Boolean(invalid));
    }

    function syncNative({ showInvalid = false } = {}) {
      const iso = validDateParts(year.value, month.value, day.value);

      if (iso) {
        nativeDate.value = iso;
        setHint("");
        nativeDate.dispatchEvent(new Event("input", { bubbles: true }));
        nativeDate.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      nativeDate.value = "";
      const complete = year.value.length === 4 && month.value.length === 2 && day.value.length === 2;
      if (showInvalid && complete) setHint("Enter a valid calendar date.", true);
      else setHint("");
      return false;
    }

    function moveForward(current) {
      if (current === year && year.value.length === 4) {
        selectField(month);
      } else if (current === month && month.value.length === 2) {
        selectField(day);
      } else if (current === day && day.value.length === 2) {
        const valid = syncNative({ showInvalid: true });
        if (valid && timeInput) selectField(timeInput);
      }
    }

    function applyFullDateText(raw) {
      const numbers = String(raw || "").replace(/\D/g, "");
      if (numbers.length !== 8) return false;

      year.value = numbers.slice(0, 4);
      month.value = numbers.slice(4, 6);
      day.value = numbers.slice(6, 8);
      syncNative({ showInvalid: true });
      selectField(day);
      return true;
    }

    parts.forEach((input, index) => {
      const maxLength = index === 0 ? 4 : 2;

      input.addEventListener("focus", () => {
        requestAnimationFrame(() => {
          try { input.select(); } catch (_) {}
        });
      });

      input.addEventListener("beforeinput", event => {
        if (event.inputType === "insertText" && event.data && /\D/.test(event.data)) {
          event.preventDefault();
        }
      });

      input.addEventListener("input", () => {
        input.value = digitsOnly(input.value, maxLength);
        syncNative();
        moveForward(input);
      });

      input.addEventListener("paste", event => {
        const text = event.clipboardData?.getData("text") || "";
        if (applyFullDateText(text)) {
          event.preventDefault();
          return;
        }
        const cleaned = digitsOnly(text, maxLength);
        if (cleaned) {
          event.preventDefault();
          input.value = cleaned;
          syncNative();
          moveForward(input);
        }
      });

      input.addEventListener("keydown", event => {
        if (event.key === "Backspace" && !input.value && index > 0) {
          event.preventDefault();
          const previous = parts[index - 1];
          selectField(previous);
          return;
        }

        if (event.key === "ArrowLeft" && input.selectionStart === 0 && index > 0) {
          event.preventDefault();
          selectField(parts[index - 1]);
          return;
        }

        if (
          event.key === "ArrowRight" &&
          input.selectionStart === input.value.length &&
          input.selectionEnd === input.value.length &&
          index < parts.length - 1
        ) {
          event.preventDefault();
          selectField(parts[index + 1]);
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          if (input === year && year.value.length === 4) selectField(month);
          else if (input === month && month.value.length === 2) selectField(day);
          else if (input === day) {
            const valid = syncNative({ showInvalid: true });
            if (valid && timeInput) selectField(timeInput);
          }
        }
      });

      input.addEventListener("blur", () => {
        if (input === month && month.value.length === 1) {
          setHint("Month requires 2 digits (for example, 01).", false);
        } else if (input === day && day.value.length === 1) {
          setHint("Day requires 2 digits (for example, 05).", false);
        } else if (input === year && year.value && year.value.length !== 4) {
          setHint("Year requires 4 digits.", false);
        } else {
          syncNative({ showInvalid: true });
        }
      });
    });

    picker.addEventListener("click", () => {
      try {
        if (typeof nativeDate.showPicker === "function") {
          nativeDate.showPicker();
        } else {
          nativeDate.focus();
          nativeDate.click();
        }
      } catch (_) {
        nativeDate.focus();
        nativeDate.click();
      }
    });

    nativeDate.addEventListener("change", () => {
      const [y = "", m = "", d = ""] = String(nativeDate.value || "").split("-");
      if (!y || !m || !d) return;
      year.value = y;
      month.value = m;
      day.value = d;
      setHint("");
    });

    // Make the date field slightly wider than a standard text input when the
    // modal has room, while still fitting cleanly on narrow screens.
    field.classList.add("segmented-event-date-field");
  }

  function installStyles() {
    if (document.getElementById("event-date-segmented-style")) return;

    const style = document.createElement("style");
    style.id = "event-date-segmented-style";
    style.textContent = `
      .segmented-event-date-field{position:relative}
      .event-date-native-proxy{
        position:absolute !important;
        width:1px !important;
        height:1px !important;
        min-height:1px !important;
        padding:0 !important;
        margin:0 !important;
        border:0 !important;
        opacity:0 !important;
        pointer-events:none !important;
        clip-path:inset(100%) !important;
      }
      .event-date-segmented{
        display:grid;
        grid-template-columns:minmax(68px,1.35fr) auto minmax(42px,.72fr) auto minmax(42px,.72fr) 42px;
        align-items:center;
        gap:5px;
        width:100%;
      }
      .event-date-part{
        width:100%;
        min-width:0;
        height:42px;
        border:1px solid var(--border);
        border-radius:10px;
        outline:none;
        padding:9px 7px;
        color:var(--text);
        background:#0d1b26;
        font:inherit;
        text-align:center;
        font-variant-numeric:tabular-nums;
      }
      .event-date-year{min-width:72px}
      .event-date-month,.event-date-day{min-width:44px}
      .event-date-part:focus{
        border-color:var(--accent);
        box-shadow:0 0 0 2px rgba(38,200,184,.15);
      }
      .event-date-separator{
        color:var(--muted);
        font-weight:800;
        user-select:none;
      }
      .event-date-picker-button{
        display:grid;
        width:42px;
        height:42px;
        place-items:center;
        border:1px solid var(--border);
        border-radius:10px;
        padding:0;
        color:var(--text);
        background:#0d1b26;
        cursor:pointer;
        font-size:17px;
      }
      .event-date-picker-button:hover{
        border-color:var(--accent);
        background:var(--inner);
      }
      .event-date-entry-hint{
        grid-column:1/-1;
        min-height:14px;
        color:var(--muted);
        font-size:10px;
        line-height:1.2;
      }
      .event-date-segmented.invalid .event-date-part{
        border-color:var(--danger);
      }
      .event-date-segmented.invalid .event-date-entry-hint{
        color:var(--danger);
      }
      @media(max-width:560px){
        .event-date-segmented{
          grid-template-columns:minmax(64px,1.35fr) auto minmax(40px,.7fr) auto minmax(40px,.7fr) 40px;
          gap:4px;
        }
        .event-date-part{padding-left:5px;padding-right:5px}
        .event-date-picker-button{width:40px}
      }
    `;
    document.head.appendChild(style);
  }

  eventDialog = function segmentedDateEventDialog(course, event = null) {
    BASE_EVENT_DIALOG(course, event);
    installStyles();
    installSegmentedEventDate();
  };
})();
