/**
 * Self-check: resolve, display, PUT validation, DB migrate/upsert.
 * Run: node scripts/check-reboot-day-times.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveScheduleTime,
  formatRebootDaysAndTime,
  validateRebootScheduleBody
} = require('../public/js/rebootScheduleHelpers');
const DatabaseManager = require('../lib/database');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// --- resolve today's time ---
const same = { usePerDay: false, timeLocal: '05:00', dayTimes: null };
assert(resolveScheduleTime(same, 1) === '05:00', 'same mode uses timeLocal');

const perDay = {
  usePerDay: true,
  timeLocal: '05:00',
  dayTimes: { '0': '05:00', '1': '06:12', '5': '07:30' }
};
assert(resolveScheduleTime(perDay, 1) === '06:12', 'per-day resolves Mon');
assert(resolveScheduleTime(perDay, 5) === '07:30', 'per-day resolves Fri');
assert(resolveScheduleTime(perDay, 2) === null, 'missing per-day time → null');

const corrupt = { usePerDay: true, timeLocal: '05:00', dayTimes: null };
assert(resolveScheduleTime(corrupt, 0) === null, 'corrupt dayTimes → null');

// --- display string ---
const allEqual = {
  usePerDay: true,
  daysMask: 1 | 2,
  timeLocal: '05:00',
  dayTimes: { '0': '05:00', '1': '05:00' }
};
assert(
  formatRebootDaysAndTime(allEqual) === 'Sun, Mon at 05:00',
  `all-equal display, got: ${formatRebootDaysAndTime(allEqual)}`
);

const mixed = {
  usePerDay: true,
  daysMask: 1 | 2,
  timeLocal: '05:00',
  dayTimes: { '0': '05:00', '1': '06:12' }
};
assert(
  formatRebootDaysAndTime(mixed) === 'Sun 05:00, Mon 06:12',
  `mixed display, got: ${formatRebootDaysAndTime(mixed)}`
);

const sameDisplay = {
  usePerDay: false,
  daysMask: 1 | 2 | 4,
  timeLocal: '03:00',
  dayTimes: null
};
assert(
  formatRebootDaysAndTime(sameDisplay) === 'Sun, Mon, Tue at 03:00',
  `same-mode display, got: ${formatRebootDaysAndTime(sameDisplay)}`
);

// --- PUT validation ---
const badDays = validateRebootScheduleBody({ daysMask: 0, timeLocal: '03:00' });
assert(badDays.error, 'daysMask 0 rejected');

const badTime = validateRebootScheduleBody({ daysMask: 1, timeLocal: '25:00' });
assert(badTime.error, 'invalid timeLocal rejected');

const missingDay = validateRebootScheduleBody({
  daysMask: 1 | 2,
  timeLocal: '03:00',
  usePerDay: true,
  dayTimes: { '0': '05:00' }
});
assert(missingDay.error && missingDay.error.includes('1'), 'missing Mon time rejected');

const okSame = validateRebootScheduleBody({
  daysMask: 3,
  timeLocal: '03:00',
  usePerDay: false,
  dayTimes: { '0': '99:99' }
});
assert(!okSame.error, 'same mode ignores dayTimes junk');
assert(okSame.schedule.dayTimes === null, 'same mode dayTimes null');
assert(okSame.schedule.usePerDay === false, 'same mode flag');

const okPer = validateRebootScheduleBody({
  daysMask: 1 | 2,
  timeLocal: '03:00',
  usePerDay: true,
  dayTimes: { '0': '05:00', '1': '06:12', '5': '07:00' }
});
assert(!okPer.error, 'valid per-day accepted');
assert(JSON.stringify(okPer.schedule.dayTimes) === JSON.stringify({ '0': '05:00', '1': '06:12' }),
  'extra dayTimes keys stripped');

// --- DB migrate + upsert round-trip ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onu-reboot-check-'));
const dbPath = path.join(tmpDir, 'test.db');
try {
  const db = new DatabaseManager(dbPath);
  const cols = db.db.prepare('PRAGMA table_info(device_reboot_schedules)').all().map((c) => c.name);
  assert(cols.includes('use_per_day'), 'migrate added use_per_day');
  assert(cols.includes('day_times'), 'migrate added day_times');

  const deviceId = db.addONUDevice('check-onu', '10.0.0.1', 'admin', 'pass', 'blue');
  const saved = db.upsertRebootSchedule(deviceId, okPer.schedule);
  assert(saved.usePerDay === true, 'upsert usePerDay');
  assert(saved.dayTimes['0'] === '05:00' && saved.dayTimes['1'] === '06:12', 'upsert dayTimes');
  assert(formatRebootDaysAndTime(saved) === 'Sun 05:00, Mon 06:12', 'loaded row formats');

  const sameSaved = db.upsertRebootSchedule(deviceId, okSame.schedule);
  assert(sameSaved.usePerDay === false, 'upsert same mode');
  assert(sameSaved.dayTimes === null, 'same mode clears day_times');
  assert(sameSaved.timeLocal === '03:00', 'same mode time_local');

  db.db.close();
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // ponytail: Windows may keep SQLite handle briefly; temp dir is OS-cleaned
  }
}

console.log('OK: resolve + display + PUT + migrate checks passed');
