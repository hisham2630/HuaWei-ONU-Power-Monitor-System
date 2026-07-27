const { rebootONU, checkConnectivity, checkTendaConnectivity } = require('./onuMonitor');
const {
  DAY_BITS,
  resolveScheduleTime,
  formatRebootDaysAndTime
} = require('../public/js/rebootScheduleHelpers');

/**
 * Reboot Scheduler
 * Runs scheduled ONU reboots (Huawei Blue/Red UI, Tenda) on weekday + local time.
 */

class RebootScheduler {
  constructor(database, notificationService) {
    this.db = database;
    this.notificationService = notificationService;
    this.isRunning = false;
    this.tickTimer = null;
    this.reloadTimer = null;
    this.schedules = [];
    this.inProgress = new Set();
  }

  start() {
    if (this.isRunning) {
      console.log('Reboot scheduler is already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting reboot scheduler...');
    this.reloadSchedules();

    this.tickTimer = setInterval(() => this.tick(), 60000);
    this.reloadTimer = setInterval(() => this.reloadSchedules(), 10000);
  }

  stop() {
    if (!this.isRunning) return;

    console.log('Stopping reboot scheduler...');
    this.isRunning = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.inProgress.clear();
  }

  reloadSchedules() {
    try {
      this.schedules = this.db.getEnabledRebootSchedules();
    } catch (error) {
      console.error('Error reloading reboot schedules:', error.message);
    }
  }

  isDayEnabled(daysMask, dayIndex) {
    return (daysMask & DAY_BITS[dayIndex]) !== 0;
  }

  formatLocalTime(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  alreadyRanThisSlot(schedule, now, resolvedTime) {
    if (!schedule.lastRunAt) return false;
    const last = new Date(schedule.lastRunAt);
    return (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate() &&
      this.formatLocalTime(last) === resolvedTime
    );
  }

  async tick() {
    if (!this.isRunning) return;

    const now = new Date();
    const currentTime = this.formatLocalTime(now);
    const dayIndex = now.getDay();

    for (const schedule of this.schedules) {
      if (!this.isDayEnabled(schedule.daysMask, dayIndex)) continue;

      const resolvedTime = resolveScheduleTime(schedule, dayIndex);
      if (!resolvedTime) {
        console.warn(
          `Reboot schedule skip for ${schedule.deviceName || schedule.deviceId}: missing/corrupt time for day ${dayIndex}`
        );
        continue;
      }
      if (resolvedTime !== currentTime) continue;
      if (this.alreadyRanThisSlot(schedule, now, resolvedTime)) continue;
      if (this.inProgress.has(schedule.deviceId)) continue;

      await this.runScheduledReboot(schedule, now, resolvedTime);
    }
  }

  async runScheduledReboot(schedule, now, resolvedTime) {
    const deviceId = schedule.deviceId;
    const scheduledFor = `${now.toISOString().slice(0, 10)} ${resolvedTime}`;
    this.inProgress.add(deviceId);

    try {
      const reachable = schedule.onuType === 'tenda'
        ? await checkTendaConnectivity(schedule.deviceHost)
        : await checkConnectivity(schedule.deviceHost);
      if (!reachable) {
        const message = 'Device unreachable at scheduled time';
        this.db.updateRebootScheduleRun(deviceId, 'skipped', message);
        this.db.addRebootLog(deviceId, scheduledFor, 'skipped', message);
        if (schedule.notifyOnFailure) {
          await this.notifyFailure(schedule, message);
        }
        console.log(`Reboot skipped for ${schedule.deviceName}: ${message}`);
        return;
      }

      console.log(`Running scheduled reboot for ${schedule.deviceName} (${schedule.deviceHost})`);
      const result = await rebootONU(
        schedule.deviceHost,
        schedule.username,
        schedule.password,
        schedule.onuType
      );

      if (result.success) {
        this.db.updateRebootScheduleRun(deviceId, 'success', result.message);
        this.db.addRebootLog(deviceId, scheduledFor, 'success', result.message);
        console.log(`Reboot success for ${schedule.deviceName}: ${result.message}`);
      } else {
        this.db.updateRebootScheduleRun(deviceId, 'failed', result.message);
        this.db.addRebootLog(deviceId, scheduledFor, 'failed', result.message);
        if (schedule.notifyOnFailure) {
          await this.notifyFailure(schedule, result.message);
        }
        console.log(`Reboot failed for ${schedule.deviceName}: ${result.message}`);
      }
    } catch (error) {
      const message = error.message;
      this.db.updateRebootScheduleRun(deviceId, 'failed', message);
      this.db.addRebootLog(deviceId, scheduledFor, 'failed', message);
      if (schedule.notifyOnFailure) {
        await this.notifyFailure(schedule, message);
      }
      console.error(`Reboot error for ${schedule.deviceName}:`, message);
    } finally {
      this.inProgress.delete(deviceId);
    }
  }

  async notifyFailure(schedule, message) {
    const deviceLabel = schedule.groupName
      ? `${schedule.groupName} - ${schedule.deviceName}`
      : schedule.deviceName;
    const text = `[ONU Reboot] Scheduled reboot failed for ${deviceLabel} (${schedule.deviceHost}): ${message}`;
    await this.notificationService.sendNotificationToAll(text);
  }
}

module.exports = RebootScheduler;
module.exports.resolveScheduleTime = resolveScheduleTime;
module.exports.formatRebootDaysAndTime = formatRebootDaysAndTime;
