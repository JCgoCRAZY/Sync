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
    if (route.page === 'all_courses_unit') {
      parts.push(route.allCoursesCourseId || '', route.allCoursesUnitId || '', route.allCoursesMode || '');
    }
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
      if (page === 'all_courses') return setHeader('All courses', 'Events and Study Material across your courses');
      if (page === 'all_courses_unit') return setHeader('All courses', 'Unit study material');
      if (page === 'course') {
        const c = activeProfile().courses[courseId];
        if (c) return setHeader(c.code, c.name || 'Course workspace');
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 1 + 2. Never-block navigation + cheaper renders
  // ---------------------------------------------------------------------------
  function navigationDestinationIsCurrent(page, opts = {}) {
    if (page !== route.page) return false;
    if (page === 'course') {
      const courseId = opts.courseId ?? route.courseId;
      const tab = normalizeCourseTab(opts.tab || route.tab || 'Overview');
      return String(courseId || '') === String(route.courseId || '') && tab === normalizeCourseTab(route.tab);
    }
    if (page === 'all_courses_unit') {
      const courseId = opts.allCoursesCourseId || route.allCoursesCourseId || '';
      const unitId = opts.allCoursesUnitId || route.allCoursesUnitId || '';
      const mode = opts.allCoursesMode === 'questions' ? 'questions' : 'terms';
      return String(courseId) === String(route.allCoursesCourseId || '')
        && String(unitId) === String(route.allCoursesUnitId || '')
        && mode === (route.allCoursesMode === 'questions' ? 'questions' : 'terms');
    }
    return true;
  }

  navTo = function uxNavTo(page, opts = {}) {
    // Clicking or key-navigating to the exact route already on screen used to
    // rebuild the full page, save navigation state and flash a skeleton. A no-op
    // is both faster and less visually distracting.
    if (navigationDestinationIsCurrent(page, opts)) {
      updateSidebarActiveState();
      return;
    }

    const fromPage = route.page;
    const navTiming = runtime.startTiming?.('navigation-usable', { from: fromPage, to: page });
    rememberPageScroll();

    route.page = page;
    route.courseId = opts.courseId ?? (page === 'course' ? route.courseId : null);
    route.tab = opts.tab || route.tab || 'Overview';

    if (page === 'all_courses_unit') {
      route.allCoursesCourseId = opts.allCoursesCourseId || route.allCoursesCourseId || '';
      route.allCoursesUnitId = opts.allCoursesUnitId || route.allCoursesUnitId || '';
      route.allCoursesMode = opts.allCoursesMode === 'questions' ? 'questions' : 'terms';
    } else if (page !== 'all_courses') {
      delete route.allCoursesCourseId;
      delete route.allCoursesUnitId;
      delete route.allCoursesMode;
    }

    const p = activeProfile();
    p.ui_state ||= {};
    // These aggregate pages are transient workspace views. Keep the user's
    // durable last-page setting on the normal app section they came from.
    if (page !== 'all_courses' && page !== 'all_courses_unit') p.ui_state.last_page = page;
    if (route.courseId) p.ui_state.last_course_id = route.courseId;
    queueSave(false);

    const token = ++navigationToken;
    fastHeaderFor(page, route.courseId);
    renderSidebar();
    els.page?.setAttribute('aria-busy', 'true');

    const finishRender = () => {
      if (token !== navigationToken) return;
      try {
        // Keep the previous page visible until the replacement DOM is ready.
        // This removes the skeleton flash from normal Dashboard/Course switches.
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
        // "Usable" means the new DOM has reached the next paint, not merely that
        // JavaScript finished building it.
        requestAnimationFrame(() => {
          if (token === navigationToken && navTiming) runtime.endTiming?.(navTiming, { route: route.page });
        });
      }
    };

    // Small destinations render immediately. Heavier aggregate/calendar/settings
    // views yield one frame so the active navigation highlight can paint first.
    const yieldOneFrame = page === 'schedule' || page === 'settings' || page === 'all_courses' || page === 'all_courses_unit';
    if (yieldOneFrame) requestAnimationFrame(finishRender);
    else finishRender();

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
    const allCoursesButton = document.getElementById('all-courses-sidebar-button');
    if (allCoursesButton) {
      allCoursesButton.classList.toggle('active', route.page === 'all_courses' || route.page === 'all_courses_unit');
    }
  }

  function ensureAllCoursesSidebarButton() {
    const addButton = document.getElementById('add-course-nav');
    if (!addButton) return null;

    let button = document.getElementById('all-courses-sidebar-button');
    if (!button) {
      button = document.createElement('button');
      button.id = 'all-courses-sidebar-button';
      button.type = 'button';
      button.className = 'all-courses-sidebar-button';
      button.innerHTML = '<span class="nav-icon" aria-hidden="true">▤</span><span>All courses</span>';
      addButton.insertAdjacentElement('afterend', button);
      button.addEventListener('click', () => navTo('all_courses'));
    }
    return button;
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
      const allCoursesButton = ensureAllCoursesSidebarButton();
      (allCoursesButton || addButton).insertAdjacentElement('afterend', section);
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

    ensureAllCoursesSidebarButton();
    updateSidebarActiveState();
    updateMostRecentSidebar();
  };

  // ---------------------------------------------------------------------------
  // All Courses workspace
  // ---------------------------------------------------------------------------
  const ALL_COURSES_UNGROUPED_ID = '__ungrouped__';

  function allCoursesSortedEvents(course) {
    return (course?.notifications || [])
      .slice()
      .sort((a, b) => String(a.due_at || '').localeCompare(String(b.due_at || '')));
  }

  function allCoursesMaterialsForUnit(course, unitId) {
    const materials = course?.materials || [];
    if (unitId === ALL_COURSES_UNGROUPED_ID) {
      const validUnits = new Set((course?.material_units || []).map(unit => String(unit.id)));
      return materials.filter(material => !material.unit_id || !validUnits.has(String(material.unit_id)));
    }
    return materials.filter(material => String(material.unit_id || '') === String(unitId || ''));
  }

  function allCoursesUnitTitle(course, unitId) {
    if (unitId === ALL_COURSES_UNGROUPED_ID) return 'Ungrouped';
    return course?.material_units?.find(unit => String(unit.id) === String(unitId))?.title || 'Unit';
  }

  function allCoursesUnitRows(course) {
    const rows = [];
    for (const unit of course.material_units || []) {
      rows.push({ id: String(unit.id), title: unit.title || 'Unit', materials: allCoursesMaterialsForUnit(course, unit.id) });
    }
    const loose = allCoursesMaterialsForUnit(course, ALL_COURSES_UNGROUPED_ID);
    if (loose.length) rows.push({ id: ALL_COURSES_UNGROUPED_ID, title: 'Ungrouped', materials: loose });
    return rows;
  }

  function allCoursesEventHtml(event, course) {
    const due = eventDue(event);
    return `<div class="all-courses-event" style="--course-accent:${escapeHtml(courseColor(course))}">
      <span class="all-courses-event-accent" aria-hidden="true"></span>
      <div class="all-courses-event-copy">
        <strong>${escapeHtml(event.title || event.type || 'Event')}</strong>
        <small>${escapeHtml(formatDateTime(event.due_at))}</small>
      </div>
      <span class="pill all-courses-event-countdown" data-all-event-due="${escapeHtml(event.due_at || '')}">
        ${due ? escapeHtml(timeLeft(due)) : '—'}
      </span>
    </div>`;
  }

  function allCoursesUnitRowHtml(course, row) {
    const materials = row.materials || [];

    // Keep the All Courses overview intentionally unit-level only.
    // Individual Lecture names are shown after opening Terms or Questions,
    // where those pages separate their content Lecture-by-Lecture.
    return `<div class="all-courses-unit-row">
      <div class="all-courses-unit-name">${escapeHtml(row.title)}</div>
      <div class="all-courses-unit-actions">
        <button class="secondary-button" type="button"
          data-all-unit-detail="${escapeHtml(course.id)}|${escapeHtml(row.id)}|terms"
          ${materials.length ? '' : 'disabled'}>Terms</button>
        <button class="secondary-button" type="button"
          data-all-unit-detail="${escapeHtml(course.id)}|${escapeHtml(row.id)}|questions"
          ${materials.length ? '' : 'disabled'}>Questions</button>
      </div>
    </div>`;
  }

  function updateAllCoursesCountdowns() {
    els.page?.querySelectorAll('[data-all-event-due]').forEach(element => {
      const due = new Date(element.dataset.allEventDue || '');
      element.textContent = Number.isNaN(+due) ? '—' : timeLeft(due);
    });
  }

  function bindAllCoursesPage() {
    els.page?.querySelectorAll('[data-all-course-open]').forEach(button => {
      button.addEventListener('click', () => {
        const courseId = button.dataset.allCourseOpen;
        navTo('course', { courseId, tab: courseTabForSwitch(courseId) });
      });
    });

    els.page?.querySelectorAll('[data-all-unit-detail]').forEach(button => {
      button.addEventListener('click', () => {
        const [courseId, unitId, mode] = String(button.dataset.allUnitDetail || '').split('|');
        if (!courseId || !unitId) return;
        navTo('all_courses_unit', {
          allCoursesCourseId: courseId,
          allCoursesUnitId: unitId,
          allCoursesMode: mode === 'questions' ? 'questions' : 'terms'
        });
      });
    });
  }

  function renderAllCourses() {
    const courses = orderedCourses();
    setHeader('All courses', 'Events and Study Material across every course');

    if (!courses.length) {
      els.page.innerHTML = '<section class="card"><div class="empty">Add a course to use the All courses view.</div></section>';
      return;
    }

    const maxEvents = Math.max(1, ...courses.map(course => allCoursesSortedEvents(course).length));
    els.page.innerHTML = `<div class="all-courses-page">
      <div class="all-courses-scroll">
        <div class="all-courses-grid" style="--all-course-count:${courses.length};--all-events-max:${maxEvents}">
          ${courses.map(course => {
            const events = allCoursesSortedEvents(course);
            const unitRows = allCoursesUnitRows(course);
            const color = escapeHtml(courseColor(course));
            return `<section class="all-courses-column" style="--course-accent:${color}">
              <button class="all-courses-course-head" type="button" data-all-course-open="${escapeHtml(course.id)}">
                <span class="all-courses-course-color" aria-hidden="true"></span>
                <span>${escapeHtml(course.code)}</span>
              </button>

              <div class="all-courses-events">
                <div class="all-courses-section-label">Events</div>
                <div class="all-courses-event-list">
                  ${events.length
                    ? events.map(event => allCoursesEventHtml(event, course)).join('')
                    : '<div class="all-courses-empty-events">No events</div>'}
                </div>
              </div>

              <div class="all-courses-study-material">
                <div class="all-courses-section-label">Study Material</div>
                <div class="all-courses-units">
                  ${unitRows.length
                    ? unitRows.map(row => allCoursesUnitRowHtml(course, row)).join('')
                    : '<div class="all-courses-empty-units">No Study Material yet.</div>'}
                </div>
              </div>
            </section>`;
          }).join('')}
        </div>
      </div>
    </div>`;

    bindAllCoursesPage();
    updateAllCoursesCountdowns();
    liveTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && route.page === 'all_courses') updateAllCoursesCountdowns();
    }, 30000);
    restorePageScrollSoon();
  }

  function allCoursesQuestionSectionHtml(material, questions) {
    return `<section class="card all-courses-detail-lecture">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(material.title || 'Untitled Document')}</h3>
          <div class="card-subtitle">${questions.length} question${questions.length === 1 ? '' : 's'}</div>
        </div>
        <button class="secondary-button" type="button" data-all-detail-open-lecture="${escapeHtml(material.id)}">Open Lecture</button>
      </div>
      <div class="list">
        ${questions.length
          ? questions.map(question => questionHtml(question, true)).join('')
          : '<div class="empty">No questions have been created from this Lecture.</div>'}
      </div>
    </section>`;
  }

  function bindAllCoursesQuestionDetail(course) {
    els.page?.querySelectorAll('[data-reveal]').forEach(button => {
      button.addEventListener('click', () => {
        const value = button.parentElement?.querySelector('.answer-value')?.textContent || '';
        button.textContent = value;
        button.classList.add('revealed');
      });
    });

    els.page?.querySelectorAll('[data-question-delete]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('Delete this question?')) return;
        if (!await requireDeletionPin('delete this question')) return;
        course.questions = (course.questions || []).filter(question => String(question.id) !== String(button.dataset.questionDelete));
        course.updated_at = nowIso();
        queueSave(true);
        renderAllCoursesUnitDetail();
      });
    });
  }

  async function deleteAllCoursesTerm(course, materialId, termId) {
    const doc = await idbGet(STORES.documents, materialId);
    if (!doc) return;
    const term = extractTermRecords(doc.delta).find(item => String(item.id) === String(termId));
    if (!term) return;

    if (!confirm(`Remove this term?\n\n${term.text}\n\nIts light-green highlight will also be removed from the Lecture.`)) return;
    if (!await requireDeletionPin('delete this term')) return;

    let changed = false;
    doc.delta = {
      ops: (doc.delta?.ops || []).map(op => {
        if (!op || typeof op !== 'object' || String(op.attributes?.term || '') !== String(termId)) return op;
        const copy = {...op};
        const attributes = {...(copy.attributes || {})};
        delete attributes.term;
        if (Object.keys(attributes).length) copy.attributes = attributes;
        else delete copy.attributes;
        changed = true;
        return copy;
      })
    };

    if (!changed) return;

    doc.updated_at = nowIso();
    await idbSet(STORES.documents, materialId, doc);
    cloudApi()?.markDocumentDirty?.(materialId).catch(error => console.warn('Unit term delete cloud queue:', error));

    const material = (course.materials || []).find(item => String(item.id) === String(materialId));
    if (material) material.updated_at = doc.updated_at;
    course.updated_at = doc.updated_at;
    lectureTextCache.delete(String(materialId));
    queueSave(true);
    renderAllCoursesUnitDetail();
  }

  async function hydrateAllCoursesTerms(course, materials, detailToken) {
    const host = document.getElementById('all-courses-unit-detail-list');
    if (!host) return;

    const results = await Promise.all(materials.map(async material => {
      try {
        const doc = await idbGet(STORES.documents, material.id);
        return { material, terms: extractTermRecords(doc?.delta) };
      } catch (error) {
        console.warn('Could not read Lecture terms:', error);
        return { material, terms: [] };
      }
    }));

    if (route.page !== 'all_courses_unit' || detailToken !== `${route.allCoursesCourseId}|${route.allCoursesUnitId}|${route.allCoursesMode}`) return;

    host.innerHTML = results.map(({material, terms}) => `<section class="card all-courses-detail-lecture">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(material.title || 'Untitled Document')}</h3>
          <div class="card-subtitle">${terms.length} term${terms.length === 1 ? '' : 's'}</div>
        </div>
        <button class="secondary-button" type="button" data-all-detail-open-lecture="${escapeHtml(material.id)}">Open Lecture</button>
      </div>
      <div class="list">
        ${terms.length
          ? terms.map(term => `<div class="list-item">
              <div class="list-main"><div class="list-title">${escapeHtml(term.text)}</div></div>
              <button class="danger-button" type="button"
                data-all-detail-delete-term="${escapeHtml(material.id)}|${escapeHtml(term.id)}">Delete</button>
            </div>`).join('')
          : '<div class="empty">No + Term highlights saved in this Lecture.</div>'}
      </div>
    </section>`).join('');

    bindAllCoursesUnitDetailCommon(course);
    host.querySelectorAll('[data-all-detail-delete-term]').forEach(button => {
      button.addEventListener('click', () => {
        const [materialId, termId] = String(button.dataset.allDetailDeleteTerm || '').split('|');
        if (materialId && termId) deleteAllCoursesTerm(course, materialId, termId);
      });
    });
  }

  function bindAllCoursesUnitDetailCommon(course) {
    document.getElementById('all-courses-detail-back')?.addEventListener('click', () => navTo('all_courses'));
    els.page?.querySelectorAll('[data-all-detail-open-lecture]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.dataset.allDetailOpenLecture) openMaterial(course.id, button.dataset.allDetailOpenLecture);
      });
    });
  }

  function renderAllCoursesUnitDetail() {
    const course = activeProfile().courses?.[route.allCoursesCourseId];
    if (!course) {
      navTo('all_courses');
      return;
    }

    const unitId = route.allCoursesUnitId || ALL_COURSES_UNGROUPED_ID;
    const mode = route.allCoursesMode === 'questions' ? 'questions' : 'terms';
    const materials = allCoursesMaterialsForUnit(course, unitId);
    const unitTitle = allCoursesUnitTitle(course, unitId);
    const modeTitle = mode === 'questions' ? 'Questions' : 'Terms';
    const color = escapeHtml(courseColor(course));

    setHeader(`${course.code} • ${unitTitle}`, `${modeTitle} from every Lecture in this unit`);

    els.page.innerHTML = `<div class="page-stack all-courses-detail-page" style="--course-accent:${color}">
      <section class="card all-courses-detail-header">
        <div class="card-header">
          <div>
            <h2>${escapeHtml(unitTitle)} — ${modeTitle}</h2>
            <div class="card-subtitle">${escapeHtml(course.code)} • Lectures are shown in their Study Material order.</div>
          </div>
          <button id="all-courses-detail-back" class="secondary-button" type="button">← All courses</button>
        </div>
      </section>
      <div id="all-courses-unit-detail-list" class="all-courses-detail-list">
        ${mode === 'questions'
          ? materials.map(material => {
              const questions = (course.questions || []).filter(question => String(question.source_material_id || '') === String(material.id));
              return allCoursesQuestionSectionHtml(material, questions);
            }).join('') || '<section class="card"><div class="empty">No Lectures in this unit.</div></section>'
          : materials.length
            ? materials.map(material => `<section class="card all-courses-detail-lecture">
                <div class="card-header"><div><h3>${escapeHtml(material.title || 'Untitled Document')}</h3><div class="card-subtitle">Loading terms…</div></div></div>
              </section>`).join('')
            : '<section class="card"><div class="empty">No Lectures in this unit.</div></section>'}
      </div>
    </div>`;

    bindAllCoursesUnitDetailCommon(course);

    if (mode === 'questions') {
      bindAllCoursesQuestionDetail(course);
    } else if (materials.length) {
      const token = `${course.id}|${unitId}|${mode}`;
      hydrateAllCoursesTerms(course, materials, token);
    }

    restorePageScrollSoon();
  }

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
      else if (page === 'all_courses') renderAllCourses();
      else if (page === 'all_courses_unit') renderAllCoursesUnitDetail();
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
      runtime.markAppUsable?.({ page: route.page });
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
    return originalMaterialCards(course, materials)
      .replace(
        /<button class="secondary-button" data-material-quiz="([^"]+)">Quiz<\/button>/g,
        (_match, id) => `<button class="secondary-button material-questions-button" data-material-quiz="${escapeHtml(id)}">Questions</button>`
      )
      .replace(
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


  function appendProfileSettingsCard() {
    const stack = els.page?.querySelector('.page-stack');
    if (!stack || stack.querySelector('#settings-profile-card')) return;

    const profiles = Object.values(state?.profiles || {});
    const section = document.createElement('section');
    section.className = 'card settings-profile-card';
    section.id = 'settings-profile-card';
    section.innerHTML = `
      <div class="card-header">
        <div>
          <h2>Profile</h2>
          <div class="card-subtitle">Choose the active workspace profile or manage your saved profiles.</div>
        </div>
      </div>
      <div class="settings-profile-controls">
        <div class="settings-profile-field">
          <label for="settings-profile-select">Active profile</label>
          <select id="settings-profile-select">
            ${profiles.map(profile =>
              `<option value="${escapeHtml(profile.id)}" ${profile.id === state.active_profile_id ? 'selected' : ''}>${escapeHtml(profile.display_name)}</option>`
            ).join('')}
          </select>
        </div>
        <button id="settings-manage-profiles" class="secondary-button" type="button">Manage profiles</button>
      </div>`;

    stack.insertBefore(section, stack.firstChild);

    section.querySelector('#settings-profile-select')?.addEventListener('change', event => {
      const nextId = event.currentTarget.value;
      if (!nextId || !state.profiles?.[nextId] || nextId === state.active_profile_id) return;

      state.active_profile_id = nextId;
      const profile = activeProfile();

      // Keep Settings open after switching profiles.
      route = {
        page: 'settings',
        courseId: profile.ui_state?.last_course_id || null,
        tab: 'Overview'
      };

      if (els.profileSelect) els.profileSelect.value = nextId;
      sidebarSignature = '';
      settingsSignature = '';
      mostRecentSignature = '';
      queueSave(false);
      render();
    });

    section.querySelector('#settings-manage-profiles')?.addEventListener('click', () => {
      // Reuse the application's established profile manager.
      if (typeof profileManager === 'function') profileManager();
      else document.getElementById('manage-profiles')?.click();
    });
  }


  function performanceDiagnosticsHtml() {
    const summary = runtime.getPerformanceSummary?.() || {timings:{},gauges:{}};
    const preferred = [
      ['launch-first-usable', 'Launch → usable'],
      ['navigation-usable', 'Navigation → usable'],
      ['lecture-open-editable', 'Lecture → editable'],
      ['slides-open-visible', 'Slides → saved slide visible'],
      ['edit-to-local-save', 'Edit → local save'],
      ['local-save-to-cloud-confirmed', 'Local save → cloud confirmed']
    ];
    const rows = preferred.map(([key, label]) => {
      const item = summary.timings?.[key];
      if (!item) return `<div class="settings-row"><div><strong>${label}</strong><span>No sample yet.</span></div><span>—</span></div>`;
      return `<div class="settings-row"><div><strong>${label}</strong><span>${item.count} sample${item.count === 1 ? '' : 's'} • slow case P90</span></div><span>${item.median_ms} ms median • ${item.p90_ms} ms P90</span></div>`;
    }).join('');
    const retained = Number(summary.gauges?.['pdf-canvases-retained']);
    return `${rows}<div class="settings-row"><div><strong>PDF canvases retained</strong><span>Current/most recent viewport-memory sample.</span></div><span>${Number.isFinite(retained) ? retained : '—'}</span></div>`;
  }

  function appendPerformanceDiagnosticsCard() {
    const stack = els.page?.querySelector('.page-stack');
    if (!stack || stack.querySelector('#performance-diagnostics-card')) return;
    const section = document.createElement('section');
    section.className = 'card';
    section.id = 'performance-diagnostics-card';
    section.innerHTML = `<div class="card-header"><div><h2>Performance Diagnostics</h2><div class="card-subtitle">Local-only timing samples. No analytics service or Supabase requests are added.</div></div></div>
      <div id="performance-diagnostics-body">${performanceDiagnosticsHtml()}</div>
      <div class="action-row" style="margin-top:14px"><button id="performance-refresh" class="secondary-button">Refresh</button><button id="performance-clear" class="secondary-button">Clear samples</button></div>`;
    stack.appendChild(section);
    section.querySelector('#performance-refresh')?.addEventListener('click', () => {
      const body = section.querySelector('#performance-diagnostics-body');
      if (body) body.innerHTML = performanceDiagnosticsHtml();
    });
    section.querySelector('#performance-clear')?.addEventListener('click', () => {
      runtime.clearPerformanceDiagnostics?.();
      const body = section.querySelector('#performance-diagnostics-body');
      if (body) body.innerHTML = performanceDiagnosticsHtml();
      toast('Performance samples cleared.', 2200);
    });
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
    appendProfileSettingsCard();
    appendSettingsPolish();
    appendPerformanceDiagnosticsCard();
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
