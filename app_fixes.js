'use strict';

// University Study Hub targeted reliability fixes — 2026-09-10
// 1) Editing a Schedule class updates that exact meeting instead of creating a duplicate.
// 2) Grading row deletion returns to the grading editor after PIN verification.
// 3) Saved grading schemes render on Dashboard course cards.

(() => {
  let meetingIdsMigrated = false;

  // Older imported/synced schedules may contain meetings without stable ids. The
  // Setup page identifies the meeting being edited by id, so missing/duplicate ids
  // can make an Edit action look like an Add action. Normalize them once on load.
  const baseNormalizeState = normalizeState;
  normalizeState = function patchedNormalizeState(raw) {
    const out = baseNormalizeState(raw);
    for (const profile of Object.values(out.profiles || {})) {
      profile.schedule ||= {};
      profile.schedule.course_meetings ||= {};
      const usedIds = new Set();
      for (const meetings of Object.values(profile.schedule.course_meetings)) {
        if (!Array.isArray(meetings)) continue;
        for (const meeting of meetings) {
          if (!meeting || typeof meeting !== 'object') continue;
          let id = String(meeting.id || '');
          if (!id || usedIds.has(id)) {
            id = uid('meeting');
            meeting.id = id;
            meetingIdsMigrated = true;
          }
          usedIds.add(id);
        }
      }
    }
    return out;
  };

  // Always emit a stable id into the Setup card controls, including for a meeting
  // created by older app versions before the migration above has been persisted.
  const baseMeetingCard = meetingCard;
  meetingCard = function patchedMeetingCard(course, meeting) {
    if (meeting && !meeting.id) {
      meeting.id = uid('meeting');
      meetingIdsMigrated = true;
    }
    return baseMeetingCard(course, meeting);
  };

  bindScheduleSetup = function patchedBindScheduleSetup() {
    const schedule = activeProfile().schedule;
    document.getElementById('school-start-button')?.addEventListener('click', schoolStartDialog);

    els.page.querySelectorAll('[data-add-meeting]').forEach(button => {
      button.onclick = () => meetingDialog(button.dataset.addMeeting);
    });

    els.page.querySelectorAll('[data-edit-meeting]').forEach(button => {
      button.onclick = () => {
        const [courseId, meetingId] = String(button.dataset.editMeeting || '').split('|');
        const meetings = schedule.course_meetings[courseId] || [];
        const meeting = meetings.find(item => String(item?.id || '') === String(meetingId || ''));
        if (!meeting) {
          toast('That class time could not be found. Reopen Setup and try again.', 4200);
          renderSchedule();
          return;
        }
        meetingDialog(courseId, meeting);
      };
    });

    els.page.querySelectorAll('[data-delete-meeting]').forEach(button => {
      button.onclick = async () => {
        const [courseId, meetingId] = String(button.dataset.deleteMeeting || '').split('|');
        if (!confirm('Delete this class time?')) return;
        if (!await requireDeletionPin('delete this class time')) return;
        schedule.course_meetings[courseId] = (schedule.course_meetings[courseId] || [])
          .filter(item => String(item?.id || '') !== String(meetingId || ''));
        queueSave();
        renderSchedule();
      };
    });

    // Persist one-time ids generated for legacy/imported meeting records as soon
    // as Setup is rendered, so every device subsequently edits the same record.
    if (meetingIdsMigrated) {
      meetingIdsMigrated = false;
      queueSave();
    }
  };

  meetingDialog = function patchedMeetingDialog(courseId, meeting = null) {
    const course = activeProfile().courses[courseId];
    if (!course) {
      toast('Course not found.', 3500);
      return;
    }

    const editing = Boolean(meeting);
    const editingId = editing ? String(meeting.id || '') : '';
    const start = meeting?.start_minute ?? 540;
    const end = meeting?.end_minute ?? 620;

    modal(
      `<h2>${editing ? 'Edit' : 'Add'} Class Time</h2>
      <div class="form-grid">
        <div class="field"><label>Title</label><input id="meet-title" value="${escapeHtml(meeting?.title || course.code)}"></div>
        <div class="field"><label>Type</label><select id="meet-type">${['Lecture','Laboratory','Discussion Group','Tutorial','Other'].map(value => `<option ${meeting?.type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div class="field"><label>Day</label><select id="meet-day">${DAY_NAMES.map(value => `<option ${meeting?.day === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
        <div class="field"><label>Room</label><input id="meet-room" value="${escapeHtml(meeting?.classroom || '')}"></div>
        <div class="field"><label>Start</label><input id="meet-start" type="time" value="${minutesToTime(start)}"></div>
        <div class="field"><label>End</label><input id="meet-end" type="time" value="${minutesToTime(end)}"></div>
        <div class="field"><label>Repeats</label><select id="meet-repeat"><option ${meeting?.recurrence === 'Weekly' ? 'selected' : ''}>Weekly</option><option ${meeting?.recurrence === 'Bi-weekly' ? 'selected' : ''}>Bi-weekly</option><option ${meeting?.recurrence === 'Once' ? 'selected' : ''}>Once</option></select></div>
        <div class="field"><label>Start date</label><input id="meet-first" type="date" value="${escapeHtml(meeting?.first_class_date || '')}"></div>
        <div class="field full"><label>Instructor</label><input id="meet-instructor" value="${escapeHtml(meeting?.instructor || '')}"></div>
      </div>`,
      root => {
        const startMinute = timeToMinutes(root.querySelector('#meet-start').value);
        const endMinute = timeToMinutes(root.querySelector('#meet-end').value);
        const recurrence = root.querySelector('#meet-repeat').value;
        const firstDate = root.querySelector('#meet-first').value;

        if (endMinute <= startMinute) return toast('End time must be after start time.');
        if ((recurrence === 'Bi-weekly' || recurrence === 'Once') && !firstDate) {
          return toast('Start date is required for Bi-weekly and Once class times.');
        }

        const meetings = activeProfile().schedule.course_meetings[courseId] ||= [];
        const data = {
          id: editing ? editingId : uid('meeting'),
          enabled: true,
          title: root.querySelector('#meet-title').value.trim() || course.code,
          type: root.querySelector('#meet-type').value,
          classroom: root.querySelector('#meet-room').value.trim(),
          day: root.querySelector('#meet-day').value,
          start_minute: startMinute,
          end_minute: endMinute,
          instructor: root.querySelector('#meet-instructor').value.trim(),
          recurrence,
          first_class_date: firstDate,
        };

        if (editing) {
          const index = meetings.findIndex(item =>
            item === meeting || String(item?.id || '') === editingId
          );
          if (index < 0) {
            toast('This class time changed while it was open. Reopen Setup and edit it again.', 4500);
            return;
          }
          // Preserve import/source metadata while replacing only the editable fields.
          Object.assign(meetings[index], data);
        } else {
          meetings.push(data);
        }

        queueSave();
        closeModal();
        renderSchedule();
      }
    );
  };

  function gradingDraftFromRoot(root) {
    return [...root.querySelectorAll('.grading-row')].map(row => ({
      id: row.dataset.id || uid('grade'),
      name: row.querySelector('[data-name]')?.value ?? '',
      weight: row.querySelector('[data-weight]')?.value ?? '0',
    }));
  }

  function normalizedGradingRows(rows) {
    return (rows || []).map(row => ({
      id: row.id || uid('grade'),
      name: String(row.name || ''),
      weight: Number.isFinite(Number(row.weight)) ? Number(row.weight) : 0,
    }));
  }

  gradingDialog = function patchedGradingDialog(course, draft = null) {
    const rows = normalizedGradingRows(draft ?? course.grading ?? []);

    modal(
      `<h2>Grading Scheme — ${escapeHtml(course.code)}</h2>
       <div id="grading-rows" class="list">${rows.map(row => gradingRow(row.name, row.weight, row.id)).join('')}</div>
       <button id="add-grade-row" class="secondary-button" style="margin-top:10px">＋ Category</button>
       <div class="form-help" id="grading-total"></div>`,
      root => {
        const out = gradingDraftFromRoot(root)
          .map(row => ({
            id: row.id || uid('grade'),
            name: String(row.name || '').trim(),
            weight: Number(row.weight),
          }))
          .filter(row => row.name && Number.isFinite(row.weight));

        course.grading = out;
        course.updated_at = nowIso();
        queueSave();
        closeModal();
        if (route.page === 'course' && route.courseId === course.id) renderCourse();
        else render();
        toast('Grading scheme saved.');
      },
      { wide: true }
    );

    const root = document.getElementById('modal-root');
    const container = root.querySelector('#grading-rows');
    const updateTotal = () => {
      const total = [...root.querySelectorAll('[data-weight]')]
        .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      const totalEl = root.querySelector('#grading-total');
      if (totalEl) totalEl.textContent = `Total: ${total.toFixed(1)}%`;
    };

    root.querySelector('#add-grade-row').onclick = () => {
      container.insertAdjacentHTML('beforeend', gradingRow('', 0));
      updateTotal();
    };
    root.addEventListener('input', updateTotal);

    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-remove-grade]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      const row = button.closest('.grading-row');
      const rowId = String(row?.dataset.id || '');
      const currentDraft = gradingDraftFromRoot(root);
      if (!confirm('Delete this grading category?')) return;

      // PIN verification intentionally replaces the modal. Preserve every unsaved
      // field first, then reopen the grading editor so the user is never kicked out.
      const approved = await requireDeletionPin('delete this grading category');
      const nextDraft = approved
        ? currentDraft.filter(item => String(item.id || '') !== rowId)
        : currentDraft;
      gradingDialog(course, nextDraft);
      if (approved) toast('Category removed. Press Save to keep the updated grading scheme.');
    });

    updateTotal();
  };

  function gradingWeightLabel(weight) {
    const value = Number(weight);
    if (!Number.isFinite(value)) return '0';
    return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
  }

  // Dashboard cards now include the saved grading scheme beneath the existing
  // Lectures/Events counters, matching the requested compact course-card design.
  courseCard = function patchedCourseCard(course) {
    const events = (course.notifications || []).filter(event => {
      const due = eventDue(event);
      return due && due >= new Date();
    }).length;
    const grading = (course.grading || []).filter(row =>
      String(row?.name || '').trim() && Number.isFinite(Number(row?.weight))
    );
    const gradingHtml = grading.length
      ? `<div style="margin-top:11px;display:grid;gap:3px;font-size:14px;line-height:1.25;color:var(--text)">${grading.map(row => `<div>${escapeHtml(row.name)} : ${gradingWeightLabel(row.weight)}%</div>`).join('')}</div>`
      : '';

    return `<button class="card" style="text-align:left;cursor:pointer" data-course-open="${course.id}">
      <div style="height:8px;border-radius:999px;background:${courseColor(course)};margin-bottom:13px"></div>
      <div style="font-size:20px;font-weight:850">${escapeHtml(course.code)}</div>
      <div class="card-subtitle">${escapeHtml(course.name || 'University course')}</div>
      <div class="stat-row" style="grid-template-columns:1fr 1fr;margin-top:15px">
        <div class="stat"><span>Lectures</span><strong>${course.materials.length}</strong></div>
        <div class="stat"><span>Events</span><strong>${events}</strong></div>
      </div>
      ${gradingHtml}
    </button>`;
  };

  // Persist generated meeting ids to cloud once startup has finished. This is a
  // one-time migration and prevents another device from receiving id-less meetings.
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (meetingIdsMigrated && state) {
        queueSave();
        meetingIdsMigrated = false;
      }
    }, 750);
  }, { once: true });
})();
