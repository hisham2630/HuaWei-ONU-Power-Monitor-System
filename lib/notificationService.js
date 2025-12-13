const axios = require('axios');

/**
 * Notification Service
 * Handles SMS notifications using the configured API template
 */

class NotificationService {
  constructor(database) {
    this.db = database;
  }

  /**
   * Get formatted device name with group name if available
   */
  getFormattedDeviceName(device) {
    if (device.groupId) {
      try {
        const group = this.db.getGroup(device.groupId);
        if (group && group.name) {
          return `${group.name} - ${device.name}`;
        }
      } catch (error) {
        console.warn(`Failed to get group name for device ${device.name}:`, error.message);
      }
    }
    return device.name;
  }

  /**
   * Send SMS notification using the configured API
   */
  async sendSMS(phone, message) {
    try {
      const config = this.db.getSMSConfig();
      
      if (!config || config.enabled !== 1) {
        console.log('SMS notifications are disabled');
        return false;
      }

      if (!config.api_url) {
        console.log('SMS API URL not configured');
        return false;
      }

      // Strip the + prefix from phone number if present (some SMS APIs don't accept it)
      const cleanPhone = phone.replace(/^\+/, '');

      // Replace placeholders in the API URL
      // Encode both phone number and message for proper URL formatting
      const url = config.api_url
        .replace('{phone}', encodeURIComponent(cleanPhone))
        .replace('{message}', encodeURIComponent(message));

      console.log(`Sending SMS notification to ${phone} (cleaned: ${cleanPhone}): ${message}`);
      console.log(`API URL: ${url}`);

      // Make HTTP GET request to the SMS API
      const response = await axios.get(url, {
        timeout: 10000,
        validateStatus: (status) => status < 500
      });

      console.log(`SMS API Response Status: ${response.status}`);
      console.log(`SMS API Response Data:`, response.data);

      if (response.status === 200) {
        console.log('✓ SMS sent successfully');
        return true;
      } else {
        console.log(`✗ SMS API returned status ${response.status}`);
        console.log(`Response: ${JSON.stringify(response.data)}`);
        return false;
      }
    } catch (error) {
      console.error('✗ Failed to send SMS:', error.message);
      return false;
    }
  }

  /**
   * Send notification to all configured phone numbers
   */
  async sendNotificationToAll(message) {
    const config = this.db.getSMSConfig();
    
    if (!config || config.enabled !== 1) {
      console.log('SMS notifications are disabled');
      return false;
    }

    if (!config.phone_numbers || !config.phoneNumbersArray || config.phoneNumbersArray.length === 0) {
      console.log('No phone numbers configured for SMS notifications');
      return false;
    }

    console.log(`Sending notification to ${config.phoneNumbersArray.length} recipient(s)`);
    
    const results = [];
    for (const phone of config.phoneNumbersArray) {
      const success = await this.sendSMS(phone, message);
      results.push({ phone, success });
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`Successfully sent ${successCount}/${results.length} notifications`);
    
    return successCount > 0;
  }

  /**
   * Check if notification should be sent based on monitoring data
   */
  shouldNotify(device, monitoringData) {
    const alerts = [];
    const formattedDeviceName = this.getFormattedDeviceName(device);

    console.log(`Checking notifications for device ${formattedDeviceName}:`);
    console.log(`  Monitoring data:`, monitoringData);

    // Check RX Power
    if (device.notifyRxPower && monitoringData.currentValue) {
      // Check if RX power is missing (-- dBm indicates no optical signal)
      if (monitoringData.currentValue.includes('--')) {
        alerts.push({
          type: 'rx_power_none',
          message: `No RX Power Alert: ${formattedDeviceName} - No optical signal detected (${monitoringData.currentValue})`
        });
        console.log(`  ✓ No RX Power alert triggered! (-- dBm)`);
      } else {
        // Extract RX power value including negative sign
        const match = monitoringData.currentValue.match(/(-?[\d.]+)/);
        const rxPower = match ? parseFloat(match[1]) : NaN;
        console.log(`  RX Power Check: enabled=${device.notifyRxPower}, value=${rxPower}, threshold=${device.rxPowerThreshold}`);
        
        if (!isNaN(rxPower) && rxPower < device.rxPowerThreshold) {
          alerts.push({
            type: 'rx_power',
            message: `Low RX Power Alert: ${formattedDeviceName} - Current: ${monitoringData.currentValue}, Threshold: ${device.rxPowerThreshold} dBm`
          });
          console.log(`  ✓ RX Power alert triggered!`);
        } else {
          console.log(`  ✗ RX Power alert NOT triggered (${rxPower} >= ${device.rxPowerThreshold})`);
        }
      }
    } else {
      console.log(`  RX Power notifications disabled or no data`);
    }

    // Check High Temperature
    if (device.notifyTempHigh && monitoringData.temperature) {
      const temp = parseFloat(monitoringData.temperature.match(/([\d.]+)/)?.[1]);
      console.log(`  Temp High Check: enabled=${device.notifyTempHigh}, value=${temp}, threshold=${device.tempHighThreshold}`);
      
      if (!isNaN(temp) && temp > device.tempHighThreshold) {
        alerts.push({
          type: 'temp_high',
          message: `High Temperature Alert: ${formattedDeviceName} - Current: ${monitoringData.temperature}, Threshold: ${device.tempHighThreshold}°C`
        });
        console.log(`  ✓ High temp alert triggered!`);
      }
    }

    // Check Low Temperature
    if (device.notifyTempLow && monitoringData.temperature) {
      const temp = parseFloat(monitoringData.temperature.match(/([\d.]+)/)?.[1]);
      console.log(`  Temp Low Check: enabled=${device.notifyTempLow}, value=${temp}, threshold=${device.tempLowThreshold}`);
      
      if (!isNaN(temp) && temp < device.tempLowThreshold) {
        alerts.push({
          type: 'temp_low',
          message: `Low Temperature Alert: ${formattedDeviceName} - Current: ${monitoringData.temperature}, Threshold: ${device.tempLowThreshold}°C`
        });
        console.log(`  ✓ Low temp alert triggered!`);
      }
    }

    // Check Ethernet Port Status
    if (device.notifyPortDown && monitoringData.portSpeeds && device.portMonitoringConfig) {
      console.log(`  Port Status Check: enabled=${device.notifyPortDown}`);
      
      // Check each configured port
      for (const [portNum, config] of Object.entries(device.portMonitoringConfig)) {
        if (config && config.notifyDown) {
          const portKey = `eth${portNum}-speed`;
          const portSpeed = monitoringData.portSpeeds[portKey];
          
          console.log(`    Port ${portNum} Check: speed=${portSpeed}, config=${JSON.stringify(config)}`);
          
          // If port speed is 0 or undefined, the port is down
          if (portSpeed === 0 || portSpeed === undefined) {
            alerts.push({
              type: 'port_down',
              message: `Port Down Alert: ${formattedDeviceName} - Ethernet Port ${portNum} is down`
            });
            console.log(`    ✓ Port ${portNum} down alert triggered!`);
          }
          
          // Check if port speed is below the configured threshold
          if (config.speed && portSpeed > 0 && portSpeed < parseInt(config.speed)) {
            alerts.push({
              type: 'port_speed',
              message: `Port Speed Alert: ${formattedDeviceName} - Ethernet Port ${portNum} speed (${portSpeed} Mbps) is below threshold (${config.speed} Mbps)`
            });
            console.log(`    ✓ Port ${portNum} speed alert triggered!`);
          }
        }
      }
    } else {
      console.log(`  Port monitoring disabled or no data`);
    }

    console.log(`  Total alerts: ${alerts.length}`);
    return alerts;
  }

  /**
   * Process monitoring result and send notifications if needed
   */
  async processMonitoringResult(device, result) {
    const formattedDeviceName = this.getFormattedDeviceName(device);
    
    if (!result.success) {
      // Handle device offline
      if (device.notifyOffline) {
        // Increment consecutive failures
        const newFailures = (device.consecutiveFailures || 0) + 1;
        
        // Check if we've reached the threshold
        if (newFailures >= device.retryAttempts && !device.isOfflineNotified) {
          // Send offline notification
          const message = `Device Offline: ${formattedDeviceName} at ${device.host} is not responding after ${newFailures} attempts.`;
          await this.sendNotificationToAll(message);
          
          // Update notification state
          this.db.updateDeviceNotificationState(device.id, newFailures, true);
        } else {
          // Just update failure count
          this.db.updateDeviceNotificationState(device.id, newFailures, device.isOfflineNotified);
        }
      }
      return;
    }

    // Device is online
    if (device.notifyOffline && device.isOfflineNotified) {
      // Device came back online
      const message = `Device Online: ${formattedDeviceName} at ${device.host} is back online.`;
      await this.sendNotificationToAll(message);
      
      // Reset notification state
      this.db.updateDeviceNotificationState(device.id, 0, false);
    } else if (device.consecutiveFailures > 0) {
      // Reset failure count
      this.db.updateDeviceNotificationState(device.id, 0, false);
    }

    // Check for threshold alerts
    const alerts = this.shouldNotify(device, result.data);
    
    for (const alert of alerts) {
      console.log(`Alert triggered: ${alert.type} - ${alert.message}`);
      await this.sendNotificationToAll(alert.message);
    }
  }
}

module.exports = NotificationService;
