'use strict';

/*
  University Study Hub — UX / reliability upgrade pass
  ---------------------------------------------------
  This layer is intentionally additive. It keeps the existing cloud hardening,
  grading/schedule fixes, editor persistence, and recovery system intact while
  improving navigation, rendering, search, recent-work access and device UX.
*/
(() => {
  const runtime = window.StudyHubRuntime || {};
  const yieldToUI = runtime.yieldToUI || (() => new Promise(resolve => requestAnimationFrame(() => resolve())));
  const nextPaint = runtime.nextPaint || (() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  let navigationToken = 0;
  let sidebarSignature = '';
  let settingsSignature = '';
  let settingsLastRenderedAt = 0;
  let courseSearchToken = 0;
  let pageScrollTimer = null;
  let deviceHeartbeatTimer = null;
  let dragState = null;
  let mostRecentSignature = '';
  const lectureTextCache = new Map();
  const LECTURE_TEXT_CACHE_LIMIT = 48;
  const DEVICE_CLOUD_HEARTBEAT_MS = 6 * 60 * 60 * 1000;
  const DEVICE_LOCAL_HEARTBEAT_MS = 30 * 60 * 1000;

  const originalRenderCourse = renderCourse;
  const originalRenderSchedule = renderSchedule;
  const originalRenderSettings = renderSettings;
  const originalRenderNotes = renderNotes;
  const originalOpenMaterial = openMaterial;
  const originalHandleScheduleImage = handleScheduleImage;
  const originalCourseCard = courseCard;
  const originalMaterialCards = materialCards;

  function safeString(value) {
    return String(value ?? '');
  }

  function formatCompactDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(+d)) return '';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function currentRouteScrollKey() {
    if (!state?.active_profile_id) return '';
    const p = activeProfile();
    const parts = ['ushub-scroll', state.active_profile_id, route.page];
    if (route.page === 'course') parts.push(route.courseId || '', normalizeCourseTab(route.tab));
    if (route.page === 'schedule') parts.push(p.schedule?._web_view || 'calendar');
    return parts.join(':');
  }

  function rememberPageScroll() {
    if (!els.page || !state) return;
    const key = currentRouteScrollKey();
    if (!key) return;
    localStorage.setItem(key, String(Math.max(0, Math.round(els.page.scrollTop || 0))));
  }

  function restorePageScrollSoon() {
    const key = currentRouteScrollKey();
    if (!key || !els.page) return;
    const saved = Number(localStorage.getItem(key) || 0);
    requestAnimationFrame(() => {
      if (!els.page) return;
      els.page.scrollTop = Number.isFinite(saved) ? Math.max(0, saved) : 0;
    });
  }

  function pageLoadingSkeleton() {
    return `<div class="ux-route-skeleton" aria-hidden="true">
      <div class="ux-skeleton-line wide"></div>
      <div class="ux-skeleton-card"></div>
      <div class="ux-skeleton-card short"></div>
    </div>`;
  }

  function fastHeaderFor(page, courseId = null) {
    try {
      if (page === 'dashboard') return setHeader('Dashboard', `${activeProfile().display_name} • University workspace`);
      if (page === 'notes') return setHeader('Notes', 'Personal notes across your university workspace');
      if (page === 'schedule') return setHeader('Schedule', 'Setup classes, import a timetable screenshot, and view your week');
      if (page === 'settings') return setHeader('Settings', 'User settings, appearance, audio, backups and iPad installation');
      if (page === 'course') {
        const c = activeProfile().courses[courseId];
        if (c) return setHeader(c.code, c.name || 'Course workspace');
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 1 + 2. Never-block navigation + cheaper renders
  // ---------------------------------------------------------------------------
  navTo = function uxNavTo(page, opts = {}) {
    rememberPageScroll();

    route.page = page;
    route.courseId = opts.courseId ?? (page === 'course' ? route.courseId : null);
    route.tab = opts.tab || route.tab || 'Overview';

    const p = activeProfile();
    p.ui_state ||= {};
    p.ui_state.last_page = page;
    if (route.courseId) p.ui_state.last_course_id = route.courseId;
    queueSave(false);

    const token = ++navigationToken;
    fastHeaderFor(page, route.courseId);
    renderSidebar();

    if (els.page) {
      els.page.setAttribute('aria-busy', 'true');
      els.page.classList.add('ux-route-loading');
      els.page.innerHTML = pageLoadingSkeleton();
    }

    // Two animation frames guarantee that the navigation highlight + lightweight
    // skeleton get a chance to paint before a potentially heavier page render.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== navigationToken) return;
      try {
        render();
      } catch (error) {
        console.error('Study Hub route render recovered:', error);
        if (els.page) {
          els.page.innerHTML = `<section class="card ux-recovery-card"><h2>Page recovered</h2><p class="card-subtitle">This section hit a temporary rendering error. Your local data remains saved.</p><button id="ux-render-retry" class="primary-button">Retry</button></section>`;
          document.getElementById('ux-render-retry')?.addEventListener('click', () => render());
        }
      } finally {
        els.page?.removeAttribute('aria-busy');
        els.page?.classList.remove('ux-route-loading');
      }
    }));

    if (window.innerWidth < 821) closeNav();
  };

  function sidebarStructureSignature() {
    const p = activeProfile();
    return JSON.stringify({
      active: state.active_profile_id,
      courses: orderedCourses(p).map(c => [c.id, c.code, courseColor(c)]),
      profiles: Object.values(state.profiles || {}).map(x => [x.id, x.display_name])
    });
  }

  function updateSidebarActiveState() {
    els.primaryNav?.querySelectorAll('[data-nav]').forEach(button => {
      button.classList.toggle('active', route.page === button.dataset.nav);
    });
    els.utilityNav?.querySelectorAll('[data-nav]').forEach(button => {
      button.classList.toggle('active', route.page === button.dataset.nav);
    });
    els.courseNav?.querySelectorAll('[data-course]').forEach(button => {
      button.classList.toggle('active', route.page === 'course' && route.courseId === button.dataset.course);
    });
  }

  function findMostRecentMaterials(limit = 3) {
    const items = [];
    for (const course of orderedCourses()) {
      for (const material of course.materials || []) {
        const ts = Date.parse(material.last_opened_at || '');
        if (!Number.isFinite(ts)) continue;
        items.push({course, material, ts});
      }
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, limit));
  }

  function findMostRecentMaterial() {
    return findMostRecentMaterials(1)[0] || null;
  }

  function updateMostRecentSidebar() {
    const addButton = document.getElementById('add-course-nav');
    if (!addButton) return;

    let section = document.getElementById('most-recent-sidebar');
    if (!section) {
      section = document.createElement('section');
      section.id = 'most-recent-sidebar';
      section.className = 'most-recent-sidebar';
      addButton.insertAdjacentElement('afterend', section);
      mostRecentSignature = '';
    }

    const recent = findMostRecentMaterials(3);
    const signature = recent.length
      ? recent.map(item => `${item.course.id}|${item.material.id}|${item.material.title || ''}|${item.material.updated_at || ''}|${item.material.last_opened_at || ''}|${courseColor(item.course)}`).join('::')
      : 'empty';

    if (signature === mostRecentSignature && section.children.length) return;
    mostRecentSignature = signature;

    if (!recent.length) {
      section.innerHTML = `<h3>Most recent</h3><div class="most-recent-empty">Open a lecture and it will appear here.</div>`;
      return;
    }

    section.innerHTML = `<h3>Most recent</h3>
      <div class="most-recent-track" aria-label="Three most recently opened Lectures">
        ${recent.map((item, index) => `<div class="most-recent-card ${index === 0 ? 'dominant' : ''}" style="--course-accent:${escapeHtml(courseColor(item.course))}">
          <span class="most-recent-accent" aria-hidden="true"></span>
          <div class="material-icon">📄</div>
          <div class="most-recent-copy">
            <strong>${escapeHtml(item.material.title || 'Untitled Document')}</strong>
            <small>${escapeHtml(item.course.code)} • Updated ${escapeHtml(formatCompactDate(item.material.updated_at || item.material.last_opened_at))}</small>
          </div>
          <button class="primary-button" data-most-recent-open="${escapeHtml(item.course.id)}|${escapeHtml(item.material.id)}">Open</button>
        </div>`).join('')}
      </div>`;

    section.querySelectorAll('[data-most-recent-open]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const [courseId, materialId] = button.dataset.mostRecentOpen.split('|');
        openMaterial(courseId, materialId);
      });
    });
  }

  renderSidebar = function uxRenderSidebar() {
    const p = activeProfile();
    const signature = sidebarStructureSignature();

    if (signature !== sidebarSignature || !els.primaryNav?.children.length) {
      sidebarSignature = signature;
      const primary = [['dashboard', '⌂', 'Dashboard'], ['notes', '✎', 'Notes']];
      const utility = [['schedule', '▦', 'Schedule'], ['settings', '⚙', 'Settings']];

      els.primaryNav.innerHTML = primary.map(([id, icon, label]) =>
        `<button class="nav-item" data-nav="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`
      ).join('');

      els.utilityNav.innerHTML = utility.map(([id, icon, label]) =>
        `<button class="nav-item" data-nav="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`
      ).join('');

      els.courseNav.innerHTML = orderedCourses(p).map(c =>
        `<button class="course-nav-item" data-course="${c.id}">
          <span class="course-dot" style="background:${escapeHtml(courseColor(c))}"></span>
          <span class="course-code">${escapeHtml(c.code)}</span>
          <span class="course-drag-handle" aria-label="Drag to reorder course" title="Drag to reorder">⋮⋮</span>
        </button>`
      ).join('');

      els.profileSelect.innerHTML = Object.values(state.profiles).map(profile =>
        `<option value="${profile.id}" ${profile.id === state.active_profile_id ? 'selected' : ''}>${escapeHtml(profile.display_name)}</option>`
      ).join('');
    }

    updateSidebarActiveState();
    updateMostRecentSidebar();
  };

  function appSettingsSignature() {
    try {
      const p = activeProfile();
      return JSON.stringify({
        scroll: p.settings?.scroll_sensitivity,
        audio: p.settings?.audio,
        theme: p.settings?.theme
      });
    } catch (_) {
      return '';
    }
  }

  render = function uxRender() {
    clearInterval(liveTimer);
    liveTimer = null;
    renderSidebar();

    const sig = appSettingsSignature();
    if (sig !== settingsSignature) {
      settingsSignature = sig;
      applySettings();
    }

    try {
      const page = route.page;
      if (page === 'dashboard') renderDashboard();
      else if (page === 'notes') renderNotes();
      else if (page === 'schedule') renderSchedule();
      else if (page === 'settings') renderSettings();
      else if (page === 'course') renderCourse();
      else {
        route.page = 'dashboard';
        renderDashboard();
      }
    } catch (error) {
      console.error('Study Hub render boundary recovered:', error);
      if (els.page) {
        els.page.innerHTML = `<section class="card ux-recovery-card"><h2>This section recovered from an error</h2><p class="card-subtitle">Your locally saved work has not been deleted.</p><button id="ux-render-retry" class="primary-button">Retry page</button></section>`;
        document.getElementById('ux-render-retry')?.addEventListener('click', () => render());
      }
    } finally {
      els.page?.removeAttribute('aria-busy');
      els.page?.classList.remove('ux-route-loading');
    }
  };

  // ---------------------------------------------------------------------------
  // 3. Continue Studying / Most Recent
  // ---------------------------------------------------------------------------
  openMaterial = async function uxOpenMaterial(courseId, materialId) {
    try {
      const p = activeProfile();
      p.ui_state ||= {};
      p.ui_state.most_recent_material = { course_id: courseId, material_id: materialId, opened_at: nowIso() };
      queueSave(false);
    } catch (_) {}
    return originalOpenMaterial(courseId, materialId);
  };

  // ---------------------------------------------------------------------------
  // 4. Course-only Study Material search (Ctrl/Cmd + K)
  // ---------------------------------------------------------------------------
  function documentPlainText(doc) {
    return (doc?.delta?.ops || []).map(op => typeof op?.insert === 'string' ? op.insert : '').join('');
  }

  async function cachedLectureText(material) {
    const id = String(material?.id || '');
    const stamp = String(material?.updated_at || material?.created_at || '');
    const cached = lectureTextCache.get(id);
    if (cached && cached.stamp === stamp) {
      // Refresh LRU position.
      lectureTextCache.delete(id);
      lectureTextCache.set(id, cached);
      return cached.text;
    }

    const doc = await idbGet(STORES.documents, id);
    const text = documentPlainText(doc);
    lectureTextCache.delete(id);
    lectureTextCache.set(id, { stamp, text });

    while (lectureTextCache.size > LECTURE_TEXT_CACHE_LIMIT) {
      const oldest = lectureTextCache.keys().next().value;
      lectureTextCache.delete(oldest);
    }
    return text;
  }

  function countMatches(text, query) {
    if (!query) return 0;
    const hay = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let count = 0;
    let at = 0;
    while ((at = hay.indexOf(needle, at)) !== -1) {
      count++;
      at += Math.max(1, needle.length);
      if (count > 999) break;
    }
    return count;
  }

  function resultSnippet(text, query) {
    const lower = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const at = lower.indexOf(needle);
    if (at < 0) return escapeHtml(text.slice(0, 140).replace(/\s+/g, ' ').trim());
    const start = Math.max(0, at - 55);
    const end = Math.min(text.length, at + query.length + 75);
    const before = text.slice(start, at).replace(/\s+/g, ' ');
    const match = text.slice(at, at + query.length);
    const after = text.slice(at + query.length, end).replace(/\s+/g, ' ');
    return `${start ? '…' : ''}${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}${end < text.length ? '…' : ''}`;
  }

  async function searchCourseDocuments(course, query, resultsBox, token) {
    const q = query.trim();
    if (!q) {
      resultsBox.hidden = true;
      resultsBox.innerHTML = '';
      return;
    }

    resultsBox.hidden = false;
    resultsBox.innerHTML = `<div class="course-search-status">Searching ${escapeHtml(course.code)}…</div>`;

    const hits = [];
    const materials = [...(course.materials || [])];
    for (let i = 0; i < materials.length; i++) {
      if (token !== courseSearchToken) return;
      const material = materials[i];
      try {
        const text = await cachedLectureText(material);
        const titleMatches = countMatches(material.title || '', q);
        const bodyMatches = countMatches(text, q);
        const total = titleMatches + bodyMatches;
        if (total) {
          hits.push({ material, total, snippet: bodyMatches ? resultSnippet(text, q) : 'Match in lecture title' });
        }
      } catch (error) {
        console.warn('Search skipped one Lecture:', material.id, error);
      }
      if (i % 4 === 3) await yieldToUI();
    }

    if (token !== courseSearchToken) return;
    if (!hits.length) {
      resultsBox.innerHTML = `<div class="course-search-status">No matches in ${escapeHtml(course.code)} lecture documents.</div>`;
      return;
    }

    hits.sort((a, b) => b.total - a.total);
    resultsBox.innerHTML = hits.slice(0, 14).map((hit, index) =>
      `<button class="course-search-result" data-search-material="${escapeHtml(hit.material.id)}" data-result-index="${index}">
        <span><strong>${escapeHtml(hit.material.title || 'Untitled Document')}</strong><small>${hit.total} match${hit.total === 1 ? '' : 'es'}</small></span>
        <div>${hit.snippet}</div>
      </button>`
    ).join('');

    resultsBox.querySelectorAll('[data-search-material]').forEach(button => {
      button.addEventListener('click', () => openMaterial(course.id, button.dataset.searchMaterial));
    });
  }

  function installStudyMaterialSearch(course) {
    if (route.page !== 'course' || route.tab !== 'Study Material') return;
    const tabs = els.page.querySelector('.course-tabs');
    if (!tabs || tabs.querySelector('.course-study-search')) return;

    tabs.classList.add('course-tabs-with-search');
    const wrap = document.createElement('div');
    wrap.className = 'course-study-search';
    wrap.innerHTML = `<span class="course-search-icon">⌕</span><input id="course-global-search" type="search" value="" placeholder="Global search" autocomplete="off" spellcheck="false" aria-label="Search this course's lecture documents"><div class="course-search-results" hidden></div>`;
    tabs.appendChild(wrap);

    const input = wrap.querySelector('input');
    const results = wrap.querySelector('.course-search-results');
    let timer = null;

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const token = ++courseSearchToken;
      timer = setTimeout(() => searchCourseDocuments(course, input.value, results, token), 180);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        input.value = '';
        results.hidden = true;
        results.innerHTML = '';
        input.blur();
      }
      if (event.key === 'Enter') {
        const first = results.querySelector('[data-search-material]');
        if (first) {
          event.preventDefault();
          openMaterial(course.id, first.dataset.searchMaterial);
        }
      }
    });
  }

  courseCard = function uxCourseCard(course) {
    const html = originalCourseCard(course);
    const color = escapeHtml(courseColor(course));
    return html
      .replace('class="card"', 'class="card course-accent-card"')
      .replace('style="text-align:left;cursor:pointer"', `style="--course-accent:${color};text-align:left;cursor:pointer"`);
  };

  materialCards = function uxMaterialCards(course, materials) {
    return originalMaterialCards(course, materials).replace(
      /<button class="danger-button" data-material-delete="([^"]+)">Delete<\/button>/g,
      (_match, id) => `<button class="secondary-button" data-material-edit="${escapeHtml(id)}">Edit</button><button class="danger-button" data-material-delete="${escapeHtml(id)}">Delete</button>`
    );
  };

  function editLectureTitleDialog(course, material) {
    if (!course || !material) return;
    modal(`<h2>Edit Lecture</h2><div class="field"><label>Lecture title</label><input id="ux-lecture-title" value="${escapeHtml(material.title || 'Untitled Document')}" maxlength="180"></div>`, async root => {
      const input = root.querySelector('#ux-lecture-title');
      const cleanTitle = String(input?.value || '').trim() || 'Untitled Document';
      if (cleanTitle === String(material.title || 'Untitled Document')) {
        closeModal();
        return;
      }
      try {
        const changedAt = nowIso();
        material.title = cleanTitle;
        material.updated_at = changedAt;
        course.updated_at = changedAt;

        const doc = await idbGet(STORES.documents, material.id);
        if (doc) {
          doc.title = cleanTitle;
          doc.updated_at = changedAt;
          await idbSet(STORES.documents, material.id, doc);
          cloudApi()?.markDocumentDirty?.(material.id).catch(error => console.warn('Lecture title cloud queue:', error));
        }

        queueSave(true);
        lectureTextCache.delete(String(material.id));
        mostRecentSignature = '';
        closeModal();
        renderCourse();
        toast('Lecture name updated.');
      } catch (error) {
        console.error('Lecture rename failed:', error);
        toast(`Lecture rename failed: ${error.message || error}`, 4500);
      }
    });
  }

  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'k') return;
    if (route.page !== 'course' || route.tab !== 'Study Material') return;
    if (els.modalRoot?.children?.length || (els.authGate && !els.authGate.hidden)) return;
    const input = document.getElementById('course-global-search');
    if (!input) return;
    event.preventDefault();
    input.focus();
    input.select();
  }, true);

  renderCourse = function uxRenderCourse() {
    originalRenderCourse();
    const c = activeCourse();
    if (c) {
      const color = courseColor(c);
      els.page.style.setProperty('--course-accent', color);
      els.page.classList.add('course-color-context');
      els.page.querySelectorAll('.course-event-item').forEach(item => item.style.setProperty('--course-accent', color));
    }
    if (c && route.tab === 'Study Material') {
      installStudyMaterialSearch(c);
      els.page.querySelectorAll('[data-material-edit]').forEach(button => {
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          const material = c.materials.find(item => String(item.id) === String(button.dataset.materialEdit));
          if (material) editLectureTitleDialog(c, material);
        });
      });
    }
    restorePageScrollSoon();
  };

  // ---------------------------------------------------------------------------
  // 5. Dashboard: Upcoming Event → Today's classes → Courses → Needs attention
  // ---------------------------------------------------------------------------
  function todaysClasses() {
    const today = new Date();
    const key = dateKey(today);
    let occurrences = [];
    try {
      occurrences = scheduleOccurrences(mondayOf(today));
    } catch (error) {
      console.warn("Today's classes could not be calculated:", error);
    }
    return occurrences
      .filter(item => item.course && dateKey(item.date) === key)
      .sort((a, b) => (a.start_minute || 0) - (b.start_minute || 0));
  }

  function todaysClassesHtml(items) {
    if (!items.length) return `<div class="today-classes-empty">No classes scheduled today.</div>`;
    return `<div class="today-classes-row">${items.map(item => {
      const title = item.title || item.course?.code || item.type || 'Class';
      const time = `${minutesLabel(item.start_minute)} – ${minutesLabel(item.end_minute)}`;
      const room = item.classroom || 'No location';
      return `<button class="today-class" style="--course-accent:${escapeHtml(courseColor(item.course))}" data-course-open="${escapeHtml(item.course.id)}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(time)}</span>
        <span>${escapeHtml(room)}</span>
      </button>`;
    }).join('')}</div>`;
  }

  renderDashboard = function uxRenderDashboard() {
    const p = activeProfile();
    const events = upcomingEvents();
    const attention = needsAttention();
    const today = todaysClasses();
    const next = events[0];

    setHeader('Dashboard', `${p.display_name} • University workspace`);
    els.page.innerHTML = `<div class="page-stack dashboard-upgrade">
      <section class="card">
        <div class="card-header"><div><h2>Upcoming Event</h2><div class="card-subtitle">Your closest deadline across all courses</div></div><div id="dashboard-clock" class="event-clock">${next ? timeLeft(next.date) : '—'}</div></div>
        ${next ? `<div class="list-item dashboard-upcoming-event" style="--course-accent:${escapeHtml(courseColor(next.course))}"><span class="course-dot" style="background:${courseColor(next.course)}"></span><div class="list-main"><div class="list-title">${escapeHtml(next.event.title || next.event.type || 'Event')}</div><div class="list-copy">${escapeHtml(next.course.code)} • ${formatDateTime(next.event.due_at)}</div></div><button class="secondary-button" data-course-open="${next.course.id}">Open course</button></div>` : '<div class="empty">No upcoming events.</div>'}
      </section>

      <section class="card today-classes-card">
        <div class="today-classes-title">Today's classes</div>
        ${todaysClassesHtml(today)}
      </section>

      <section class="card">
        <div class="card-header"><h2>Courses</h2><button id="dashboard-add-course" class="primary-button">＋ Add course</button></div>
        <div class="grid-3">${orderedCourses(p).map(c => courseCard(c)).join('') || '<div class="empty">Add your first course.</div>'}</div>
      </section>

      <section class="card">
        <div class="card-header"><div><h2>Needs attention</h2><div class="card-subtitle">Lecture documents not opened for 72 hours or more</div></div></div>
        <div class="list">${attention.length ? attention.map(x => `<div class="list-item"><span class="material-icon">📄</span><div class="list-main"><div class="list-title">${escapeHtml(x.material.title || 'Untitled Document')}</div><div class="list-copy">${escapeHtml(x.course.code)} • ${Math.floor(x.age / 86400000)} days since last opened</div></div><button class="secondary-button" data-open-material="${x.course.id}|${x.material.id}">Open</button></div>`).join('') : '<div class="empty">Everything is current.</div>'}</div>
      </section>
    </div>`;

    if (next) {
      const remaining = next.date - new Date();
      const tickMs = remaining > 86400000 ? 30000 : 1000;
      liveTimer = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        const e = document.getElementById('dashboard-clock');
        if (e) e.textContent = timeLeft(next.date);
      }, tickMs);
    }

    bindPageCommon();
    document.getElementById('dashboard-add-course')?.addEventListener('click', () => courseDialog());
    restorePageScrollSoon();
  };

  // ---------------------------------------------------------------------------
  // 6. Autosave visibility: Saved locally → Syncing → Cloud confirmed
  // ---------------------------------------------------------------------------
  updateCloudIndicator = function uxUpdateCloudIndicator(s = cloudStatus()) {
    if (!els.cloudIndicator) return;
    let label = '☁ Cloud';
    if (!s.available) label = '☁ Local only';
    else if (!s.signedIn) label = '☁ Sign in';
    else if (s.phase === 'synced') label = '☁ Cloud confirmed';
    else if (s.phase === 'syncing' || s.phase === 'pending') label = s.pendingChanges ? `☁ Syncing (${s.pendingChanges})` : '☁ Syncing';
    else if (s.phase === 'offline') label = s.pendingChanges ? `☁ Offline • ${s.pendingChanges} pending` : '☁ Offline';
    else if (s.phase === 'conflict') label = '⚠ Sync conflict';
    else if (s.phase === 'needs-choice') label = '⚠ Cloud setup';
    else if (s.phase === 'error' || s.phase === 'degraded') label = s.pendingChanges ? `⚠ Cloud • ${s.pendingChanges} pending` : '⚠ Cloud issue';

    els.cloudIndicator.textContent = label;
    els.cloudIndicator.dataset.phase = s.phase || 'local';
    els.cloudIndicator.title = s.message || label.replace(/^☁\s*/, '');
  };

  // ---------------------------------------------------------------------------
  // 7. Persistent main-app scroll/layout memory. Lecture note/slide scroll,
  //    slide position and split ratio continue to use editor_layout in the
  //    existing Lecture editor and are intentionally not duplicated here.
  // ---------------------------------------------------------------------------
  renderSchedule = function uxRenderSchedule() {
    originalRenderSchedule();
    restorePageScrollSoon();
  };

  renderNotes = function uxRenderNotes() {
    originalRenderNotes();
    restorePageScrollSoon();
  };

  // ---------------------------------------------------------------------------
  // 8. Drag-and-take-position course ordering (desktop + touch/iPad)
  // ---------------------------------------------------------------------------
  function persistCourseDomOrder() {
    const ids = [...els.courseNav.querySelectorAll('[data-course]')].map(node => node.dataset.course).filter(Boolean);
    const p = activeProfile();
    if (!ids.length || ids.length !== p.course_order.length) return;
    if (ids.every((id, i) => id === p.course_order[i])) return;
    p.course_order = ids;
    sidebarSignature = '';
    queueSave(true);
    toast('Course order saved.');
  }

  function beginCourseDrag(event) {
    const handle = event.target.closest('.course-drag-handle');
    if (!handle || !els.courseNav.contains(handle)) return;
    const source = handle.closest('[data-course]');
    if (!source) return;

    event.preventDefault();
    event.stopPropagation();
    dragState = { pointerId: event.pointerId, source, handle, moved: false };
    source.classList.add('course-dragging');
    handle.setPointerCapture?.(event.pointerId);
  }

  function moveCourseDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();
    dragState.moved = true;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-course]');
    if (!target || target === dragState.source || !els.courseNav.contains(target)) return;
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    els.courseNav.insertBefore(dragState.source, before ? target : target.nextSibling);
  }

  function endCourseDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragState.source.classList.remove('course-dragging');
    try { dragState.handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
    const moved = dragState.moved;
    dragState = null;
    if (moved) persistCourseDomOrder();
  }

  // ---------------------------------------------------------------------------
  // 9. Device list + recovery polish
  // ---------------------------------------------------------------------------
  function localDeviceId() {
    try {
      const fromCloud = cloudApi()?.deviceId?.();
      if (fromCloud) return String(fromCloud);
    } catch (_) {}
    let id = localStorage.getItem('ushub:device-id');
    if (!id) {
      id = `device_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`}`;
      localStorage.setItem('ushub:device-id', id);
    }
    return id;
  }

  function deviceName() {
    const ua = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    const isiPad = /iPad/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isiPad) return 'iPad';
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'Mac';
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'Windows PC';
    return platform || 'Study Hub device';
  }

  function browserName() {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari';
    return 'Browser';
  }

  function registerDevicePresence(force = false) {
    if (!state) return;
    if (!force && document.visibilityState !== 'visible') return;

    const p = activeProfile();
    p.device_registry ||= {};
    const id = localDeviceId();
    const old = p.device_registry[id];
    const oldMs = Date.parse(old?.last_seen_at || '');

    // Local presence can stay fresh without creating cloud traffic.
    if (!force && Number.isFinite(oldMs) && Date.now() - oldMs < 10 * 60 * 1000) return;

    p.device_registry[id] = {
      id,
      name: deviceName(),
      browser: browserName(),
      last_seen_at: nowIso()
    };

    // Cloud-publish device presence at most once every six hours per device.
    // Normal user edits can carry a newer presence sooner, but an idle app no
    // longer creates a cloud write every 15 minutes.
    const cloudStampKey = `ushub:device-presence-cloud:${id}`;
    const lastCloudMs = Number(localStorage.getItem(cloudStampKey) || 0);
    const cloudDue = !Number.isFinite(lastCloudMs) || Date.now() - lastCloudMs >= DEVICE_CLOUD_HEARTBEAT_MS;

    queueSave(cloudDue);
    if (cloudDue) localStorage.setItem(cloudStampKey, String(Date.now()));
  }

  function deviceListHtml() {
    const p = activeProfile();
    const current = localDeviceId();
    const devices = Object.values(p.device_registry || {}).sort((a, b) => Date.parse(b.last_seen_at || 0) - Date.parse(a.last_seen_at || 0));
    if (!devices.length) return '<div class="empty">This device will appear after the next successful local save.</div>';
    return devices.slice(0, 10).map(device => `<div class="device-row">
      <div class="device-icon">${device.name === 'iPad' ? '▣' : '▤'}</div>
      <div class="list-main"><div class="list-title">${escapeHtml(device.name || 'Device')}${device.id === current ? ' • This device' : ''}</div><div class="list-copy">${escapeHtml(device.browser || '')} • Last active ${escapeHtml(formatDateTime(device.last_seen_at))}</div></div>
    </div>`).join('');
  }

  function appendSettingsPolish() {
    const stack = els.page?.querySelector('.page-stack');
    if (!stack || stack.querySelector('#devices-recovery-card')) return;

    const section = document.createElement('section');
    section.className = 'card';
    section.id = 'devices-recovery-card';
    section.innerHTML = `<div class="card-header"><div><h2>Devices & Recovery</h2><div class="card-subtitle">See devices that have used this profile and restore previous Lecture versions.</div></div></div>
      <div class="device-list">${deviceListHtml()}</div>
      <div class="action-row" style="margin-top:14px">
        <button id="ux-recovery-center" class="primary-button">Recovery Center</button>
        <button id="ux-sync-now" class="secondary-button">Sync now</button>
      </div>
      <p class="form-help">Lecture recovery keeps up to 10 local and 10 cloud checkpoints per Lecture when available.</p>`;

    const cloudSection = [...stack.children].find(node => node.querySelector?.('#cloud-sync-now'));
    if (cloudSection?.nextSibling) stack.insertBefore(section, cloudSection.nextSibling);
    else stack.appendChild(section);

    section.querySelector('#ux-recovery-center')?.addEventListener('click', () => {
      if (typeof openRecoveryCenter === 'function') openRecoveryCenter();
    });
    section.querySelector('#ux-sync-now')?.addEventListener('click', async () => {
      try {
        toast('Syncing…', 2500);
        await cloudApi()?.retrySync?.();
        toast('Sync request complete.', 2500);
      } catch (error) {
        toast(`Sync failed: ${error.message || error}`, 4500);
      }
    });
  }

  renderSettings = function uxRenderSettings() {
    // Cloud callbacks can arrive in bursts. Avoid rebuilding the entire Settings
    // DOM repeatedly within the same animation window.
    const now = performance.now();
    if (route.page === 'settings' && now - settingsLastRenderedAt < 90 && els.page?.querySelector('.page-stack')) {
      updateCloudIndicator();
      return;
    }
    settingsLastRenderedAt = now;
    originalRenderSettings();
    appendSettingsPolish();
    window.StudyHubDeploymentVersion?.ensureSettingsCard?.();
    restorePageScrollSoon();
  };

  // ---------------------------------------------------------------------------
  // Background-safe OCR and backups
  // ---------------------------------------------------------------------------
  handleScheduleImage = async function uxHandleScheduleImage(file) {
    // Let the click/navigation frame paint before OCR initialization begins.
    await nextPaint();
    return originalHandleScheduleImage(file);
  };

  exportTransfer = async function uxExportTransfer() {
    try {
      toast('Preparing backup locally…', 3000);
      await flushMainLocalWrites();
      await yieldToUI();

      const docs = Object.fromEntries(await idbEntries(STORES.documents));
      const blobEntries = await idbEntries(STORES.blobs);
      const blobs = {};

      for (let i = 0; i < blobEntries.length; i++) {
        const [key, blob] = blobEntries[i];
        if (blob instanceof Blob) {
          blobs[key] = {
            name: blob.name || `${key}.bin`,
            type: blob.type || 'application/octet-stream',
            base64: await blobToBase64(blob)
          };
        }
        await yieldToUI();
      }

      const payload = {
        format: 'university-study-hub-transfer',
        version: 1,
        created_at: nowIso(),
        state,
        documents: docs,
        blobs
      };

      await yieldToUI();
      const json = JSON.stringify(payload);
      await yieldToUI();
      downloadBlob(new Blob([json], { type: 'application/json' }), `University_Study_Hub_Backup_${localDateKey()}.ushub.json`);
      toast('Full backup exported.');
    } catch (error) {
      console.error('Backup export failed:', error);
      toast(`Backup export failed: ${error.message || error}`, 5000);
    }
  };

  function installReadyHooks() {
    if (!state || !els.page || !els.courseNav) {
      setTimeout(installReadyHooks, 50);
      return;
    }

    if (!els.page.dataset.uxScrollMemory) {
      els.page.dataset.uxScrollMemory = '1';
      els.page.addEventListener('scroll', () => {
        clearTimeout(pageScrollTimer);
        pageScrollTimer = setTimeout(rememberPageScroll, 80);
      }, { passive: true });
    }

    if (!els.courseNav.dataset.uxReorder) {
      els.courseNav.dataset.uxReorder = '1';
      els.courseNav.addEventListener('pointerdown', beginCourseDrag, true);
      els.courseNav.addEventListener('pointermove', moveCourseDrag, true);
      els.courseNav.addEventListener('pointerup', endCourseDrag, true);
      els.courseNav.addEventListener('pointercancel', endCourseDrag, true);
      els.courseNav.addEventListener('click', event => {
        if (event.target.closest('.course-drag-handle')) {
          event.preventDefault();
          event.stopPropagation();
        }
      }, true);
    }

    registerDevicePresence(true);
    clearInterval(deviceHeartbeatTimer);
    deviceHeartbeatTimer = setInterval(() => registerDevicePresence(false), DEVICE_LOCAL_HEARTBEAT_MS);

    // Idle-read the most recently used Lecture from IndexedDB. This warms the
    // browser's storage path without downloading PDFs or blocking startup.
    const recent = findMostRecentMaterial();
    if (recent) {
      const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1200));
      idle(() => cachedLectureText(recent.material).catch(() => {}));
    }

    renderSidebar();
    restorePageScrollSoon();
  }

  window.addEventListener('studyhub-cloud-remote', () => {
    // Another device may have updated lecture content. Never serve stale cached text.
    lectureTextCache.clear();
    mostRecentSignature = '';
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state) registerDevicePresence(false);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(installReadyHooks, 0), { once: true });
  } else {
    setTimeout(installReadyHooks, 0);
  }
})();
