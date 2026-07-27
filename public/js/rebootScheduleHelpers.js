/**
 * Shared reboot-schedule helpers (Node + browser).
 * Node: require('../public/js/rebootScheduleHelpers.js')
 * Browser: <script src="/js/rebootScheduleHelpers.js">
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAY_BITS = [1, 2, 4, 8, 16, 32, 64]; // Sun .. Sat
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function parseDaysMask(daysMask) {
    const value = parseInt(daysMask, 10);
    if (Number.isNaN(value) || value < 1 || value > 127) return null;
    return value;
  }

  function parseTimeLocal(timeLocal) {
    if (!timeLocal || !TIME_RE.test(timeLocal)) return null;
    return timeLocal;
  }

  /** Resolve HH:MM for dayIndex (0=Sun..6=Sat). Null if missing/corrupt. */
  function resolveScheduleTime(schedule, dayIndex) {
    if (schedule.usePerDay) {
      const times = schedule.dayTimes;
      if (!times || typeof times !== 'object') return null;
      const t = times[dayIndex] ?? times[String(dayIndex)];
      return typeof t === 'string' && t ? t : null;
    }
    return schedule.timeLocal || null;
  }

  /** Badge/list: all-equal → "Sun, Mon at 05:00"; else "Sun 05:00, Mon 06:12". */
  function formatRebootDaysAndTime(schedule) {
    if (!schedule) return '';
    const days = [];
    const parts = [];
    const times = [];
    for (let i = 0; i < 7; i++) {
      if ((schedule.daysMask & DAY_BITS[i]) === 0) continue;
      days.push(DAY_NAMES[i]);
      const t = schedule.usePerDay
        ? (schedule.dayTimes && (schedule.dayTimes[i] ?? schedule.dayTimes[String(i)])) || schedule.timeLocal
        : schedule.timeLocal;
      parts.push(`${DAY_NAMES[i]} ${t}`);
      times.push(t);
    }
    if (!days.length) return '';
    const allEqual = times.every((t) => t === times[0]);
    if (!schedule.usePerDay || allEqual) {
      return `${days.join(', ')} at ${times[0]}`;
    }
    return parts.join(', ');
  }

  /**
   * Validate PUT body for reboot schedule.
   * @returns {{ error: string } | { schedule: object }}
   */
  function validateRebootScheduleBody(body) {
    const daysMask = parseDaysMask(body.daysMask);
    const timeLocal = parseTimeLocal(body.timeLocal);
    if (daysMask === null) return { error: 'Select at least one weekday' };
    if (!timeLocal) return { error: 'Invalid time format (use HH:MM)' };

    const usePerDay = !!body.usePerDay;
    let dayTimes = null;
    if (usePerDay) {
      const raw = body.dayTimes && typeof body.dayTimes === 'object' ? body.dayTimes : {};
      dayTimes = {};
      for (let i = 0; i < 7; i++) {
        if ((daysMask & (1 << i)) === 0) continue;
        const parsed = parseTimeLocal(raw[i] ?? raw[String(i)]);
        if (!parsed) {
          return { error: `Invalid or missing time for day index ${i}` };
        }
        dayTimes[String(i)] = parsed;
      }
    }

    return {
      schedule: {
        enabled: body.enabled !== false,
        daysMask,
        timeLocal,
        usePerDay,
        dayTimes,
        notifyOnFailure: body.notifyOnFailure !== false
      }
    };
  }

  return {
    DAY_BITS,
    DAY_NAMES,
    parseDaysMask,
    parseTimeLocal,
    resolveScheduleTime,
    formatRebootDaysAndTime,
    validateRebootScheduleBody
  };
});
