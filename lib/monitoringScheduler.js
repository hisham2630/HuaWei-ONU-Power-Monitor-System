const { monitorONU, getEthernetPortSpeeds } = require('./onuMonitor');

/**
 * Monitoring Scheduler
 * Manages periodic monitoring of all configured ONU devices
 */

class MonitoringScheduler {
  constructor(database, notificationService) {
    this.db = database;
    this.notificationService = notificationService;
    this.timers = new Map(); // Map of device ID to timer
    this.isRunning = false;
  }

  /**
   * Start monitoring all devices
   */
  start() {
    if (this.isRunning) {
      console.log('Monitoring scheduler is already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting monitoring scheduler...');
    
    // Initial load and schedule
    this.reloadDevices();
    
    // Reload devices every 10 seconds to pick up configuration changes
    this.reloadTimer = setInterval(() => {
      this.reloadDevices();
    }, 10000); // Check for config changes every 10 seconds
  }

  /**
   * Stop monitoring all devices
   */
  stop() {
    if (!this.isRunning) {
      console.log('Monitoring scheduler is not running');
      return;
    }

    console.log('Stopping monitoring scheduler...');
    this.isRunning = false;

    // Clear reload timer
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }

    // Clear all device timers
    for (const [deviceId, timer] of this.timers) {
      clearInterval(timer);
      console.log(`Stopped monitoring for device ${deviceId}`);
    }
    this.timers.clear();
  }

  /**
   * Reload devices and update monitoring schedules
   */
  reloadDevices() {
    try {
      const devices = this.db.getAllONUDevices();
      
      // Get current device IDs
      const currentDeviceIds = new Set(devices.map(d => d.id));
      
      // Remove timers for devices that no longer exist
      for (const [deviceId, timer] of this.timers) {
        if (!currentDeviceIds.has(deviceId)) {
          clearInterval(timer);
          this.timers.delete(deviceId);
          console.log(`Removed monitoring for deleted device ${deviceId}`);
        }
      }

      // Schedule monitoring for each device
      for (const device of devices) {
        this.scheduleDeviceMonitoring(device);
      }
    } catch (error) {
      console.error('Error reloading devices:', error.message);
    }
  }

  /**
   * Schedule monitoring for a specific device
   */
  scheduleDeviceMonitoring(device) {
    const interval = (device.monitoringInterval || 900) * 1000; // Convert to milliseconds
    
    // Check if device already has a timer with the same interval
    const existingTimer = this.timers.get(device.id);
    if (existingTimer && existingTimer.interval === interval) {
      // Same interval, no need to reschedule
      return;
    }

    // Clear existing timer if interval changed
    if (existingTimer) {
      clearInterval(existingTimer.timer);
    }

    // Create new timer
    const timer = setInterval(async () => {
      await this.monitorDevice(device);
    }, interval);

    // Store timer with interval
    this.timers.set(device.id, { timer, interval });
    
    console.log(`Scheduled monitoring for device ${device.id} (${device.name}) every ${device.monitoringInterval || 900} seconds`);

    // Run initial monitoring immediately
    setImmediate(() => this.monitorDevice(device));
  }

  /**
   * Monitor a single device
   */
  async monitorDevice(device) {
    try {
      // Reload device configuration to get latest threshold values
      const currentDevice = this.db.getONUDevice(device.id);
      if (!currentDevice) {
        console.log(`Device ${device.name} no longer exists, skipping monitoring`);
        return;
      }
      
      console.log(`Monitoring device: ${currentDevice.name} (${currentDevice.host})`);
      
      // Perform monitoring with retry logic using current device config
      const result = await this.monitorWithRetry(currentDevice);
      
      // Update monitoring cache with the result
      let status, data;
      if (result.success) {
        status = 'online';
        data = result.data;
      } else {
        status = 'offline';
        data = null;
      }
      this.db.updateMonitoringCache(currentDevice.id, status, data);
      
      // Process result and check for notifications using current device config
      await this.notificationService.processMonitoringResult(currentDevice, result);
      
    } catch (error) {
      console.error(`Error monitoring device ${device.name}:`, error.message);
      // Update cache with error status
      this.db.updateMonitoringCache(device.id, 'error', null);
    }
  }

  /**
   * Monitor device with retry logic
   */
  async monitorWithRetry(device) {
    const maxAttempts = device.retryAttempts || 3;
    const retryDelay = (device.retryDelay || 3) * 1000; // Convert to milliseconds
    
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Get optical power data and port speeds if needed
        const result = await monitorONU({
          host: device.host,
          username: device.username,
          password: device.password
        }, device.showPortSpeeds === true && device.portSelections && device.portSelections.length > 0);
        
        if (result.success) {
          return result;
        }
        
        lastError = result.error || 'Unknown error';
        console.log(`Attempt ${attempt}/${maxAttempts} failed for ${device.name}: ${lastError}`);
        
      } catch (error) {
        lastError = error.message;
        console.log(`Attempt ${attempt}/${maxAttempts} failed for ${device.name}: ${lastError}`);
      }
      
      // Wait before retry (except after last attempt)
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    // All attempts failed
    return {
      success: false,
      error: lastError || 'All retry attempts failed'
    };
  }

  /**
   * Manually trigger monitoring for a specific device
   */
  async triggerMonitoring(deviceId) {
    const device = this.db.getONUDevice(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }
    
    await this.monitorDevice(device);
  }
}

module.exports = MonitoringScheduler;
