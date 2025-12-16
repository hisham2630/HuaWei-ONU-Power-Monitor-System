const SSHManager = require('./sshManager');

/**
 * MikroTik LHG60G Monitor Module
 * Monitors RSSI and Ethernet port speed for LHG60G devices
 */

class MikroTikMonitor {
  constructor(database) {
    this.db = database;
    this.sshManager = new SSHManager();
  }

  /**
   * Monitor MikroTik LHG60G device
   */
  async monitorMikroTik(deviceConfig) {
    try {
      console.log(`[MikroTik Monitor] Starting monitoring for device: ${deviceConfig.name}`);
      
      // Get control router configuration
      const controlConfig = this.db.getMikroTikControlConfig();
      if (!controlConfig) {
        console.error('[MikroTik Monitor] Control router configuration not found');
        return {
          success: false,
          error: 'Control router configuration not found'
        };
      }

      console.log(`[MikroTik Monitor] Connecting to ${controlConfig.control_ip}:${deviceConfig.mikrotik_ssh_port}`);
      console.log(`[MikroTik Monitor] Target LHG60G: ${deviceConfig.mikrotik_lhg60g_ip}`);

      // Get RSSI and port speed
      const rssi = await this.getRSSI(controlConfig, deviceConfig);
      console.log(`[MikroTik Monitor] RSSI result: ${rssi}`);
      
      const portSpeed = await this.getPortSpeed(controlConfig, deviceConfig);
      console.log(`[MikroTik Monitor] Port speed result: ${portSpeed}`);

      if (rssi === null && portSpeed === null) {
        console.error('[MikroTik Monitor] Both RSSI and port speed failed');
        return {
          success: false,
          error: 'Failed to retrieve monitoring data'
        };
      }

      console.log(`[MikroTik Monitor] Success - RSSI: ${rssi} dBm, Speed: ${portSpeed} Mbps`);
      return {
        success: true,
        data: {
          rssi: rssi,
          rssiUnit: 'dBm',
          portSpeed: portSpeed,
          portSpeedUnit: 'Mbps',
          portSpeedRaw: this.formatPortSpeed(portSpeed),
          timestamp: new Date().toISOString()
        }
      };

    } catch (error) {
      console.error(`[MikroTik Monitor] Error:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get RSSI value from LHG60G
   */
  async getRSSI(controlConfig, deviceConfig) {
    try {
      const command = '/interface w60g monitor [find] once';
      const output = await this.sshManager.executeOnLHG60G(controlConfig, deviceConfig, command);
      
      // Parse RSSI from output
      const rssi = this.parseRSSI(output);
      return rssi;

    } catch (error) {
      console.error(`Failed to get RSSI for ${deviceConfig.name}:`, error.message);
      return null;
    }
  }

  /**
   * Get Ethernet port speed from LHG60G
   */
  async getPortSpeed(controlConfig, deviceConfig) {
    try {
      const command = '/interface ethernet monitor [find] once';
      const output = await this.sshManager.executeOnLHG60G(controlConfig, deviceConfig, command);
      
      // Parse port speed from output
      const speed = this.parsePortSpeed(output);
      return speed;

    } catch (error) {
      console.error(`Failed to get port speed for ${deviceConfig.name}:`, error.message);
      return null;
    }
  }

  /**
   * Parse RSSI value from command output
   */
  parseRSSI(output) {
    try {
      // Look for pattern: rssi: -56
      const rssiMatch = output.match(/rssi:\s*(-?\d+)/);
      if (rssiMatch) {
        return parseInt(rssiMatch[1]);
      }
      
      console.warn('RSSI not found in output:', output);
      return null;
    } catch (error) {
      console.error('Error parsing RSSI:', error.message);
      return null;
    }
  }

  /**
   * Parse port speed from command output
   */
  parsePortSpeed(output) {
    try {
      // Look for pattern: rate: 1Gbps or rate: 100Mbps
      const speedMatch = output.match(/rate:\s*(\d+(?:\.\d+)?)\s*(Mbps|Gbps)/i);
      if (speedMatch) {
        const value = parseFloat(speedMatch[1]);
        const unit = speedMatch[2].toLowerCase();
        
        // Convert to Mbps
        if (unit === 'gbps') {
          return Math.round(value * 1000);
        } else {
          return Math.round(value);
        }
      }
      
      console.warn('Port speed not found in output:', output);
      return null;
    } catch (error) {
      console.error('Error parsing port speed:', error.message);
      return null;
    }
  }

  /**
   * Format port speed for display
   */
  formatPortSpeed(speedMbps) {
    if (speedMbps === null || speedMbps === undefined) {
      return '--';
    }
    
    if (speedMbps >= 1000) {
      return `${speedMbps / 1000}Gbps`;
    } else {
      return `${speedMbps}Mbps`;
    }
  }

  /**
   * Check connectivity to LHG60G device
   */
  async checkConnectivity(deviceConfig) {
    try {
      const controlConfig = this.db.getMikroTikControlConfig();
      if (!controlConfig) {
        return false;
      }

      // Try to execute a simple command
      const command = '/system identity print';
      await this.sshManager.executeOnLHG60G(controlConfig, deviceConfig, command);
      return true;

    } catch (error) {
      return false;
    }
  }
}

module.exports = MikroTikMonitor;
