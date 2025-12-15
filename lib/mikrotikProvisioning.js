const SSHManager = require('./sshManager');

/**
 * MikroTik Provisioning Module
 * Handles control router configuration for LHG60G devices
 */

class MikroTikProvisioning {
  constructor(database) {
    this.db = database;
    this.sshManager = new SSHManager();
  }

  /**
   * Provision device on control router
   */
  async provisionDevice(deviceConfig) {
    const results = {
      success: false,
      steps: [],
      warnings: []
    };

    let conn = null;

    try {
      // Get control router configuration
      const controlConfig = this.db.getMikroTikControlConfig();
      if (!controlConfig) {
        throw new Error('Control router configuration not found. Please configure it first.');
      }

      results.steps.push('Retrieved control router configuration');

      // Connect to control router
      conn = await this.sshManager.connectToControlRouter(controlConfig);
      results.steps.push('Connected to control router');

      // Check and add IP address
      const ipExists = await this.checkIPAssignment(conn, deviceConfig.mikrotik_tunnel_ip, controlConfig.lhg60g_ethernet_interface);
      
      if (ipExists) {
        results.steps.push(`IP address ${deviceConfig.mikrotik_tunnel_ip}/24 already exists on ${controlConfig.lhg60g_ethernet_interface}`);
      } else {
        await this.addIPAddress(conn, deviceConfig.mikrotik_tunnel_ip, controlConfig.lhg60g_ethernet_interface);
        results.steps.push(`Added IP address ${deviceConfig.mikrotik_tunnel_ip}/24 to ${controlConfig.lhg60g_ethernet_interface}`);
      }

      // Check and add NAT rule
      const natExists = await this.checkNATRule(conn, deviceConfig, controlConfig);
      
      if (natExists) {
        results.steps.push(`NAT rule for port ${deviceConfig.mikrotik_ssh_port} already exists`);
      } else {
        await this.addNATRule(conn, deviceConfig, controlConfig);
        results.steps.push(`Added NAT rule for SSH port ${deviceConfig.mikrotik_ssh_port}`);
      }

      results.success = true;
      results.message = 'Device provisioned successfully';

    } catch (error) {
      results.success = false;
      results.error = error.message;
      results.steps.push(`Error: ${error.message}`);
    } finally {
      if (conn) {
        this.sshManager.closeConnection(conn);
      }
    }

    return results;
  }

  /**
   * Check if IP address exists on interface
   */
  async checkIPAssignment(conn, tunnelIP, interfaceName) {
    try {
      const command = `/ip address print where interface="${interfaceName}"`;
      const result = await this.sshManager.executeCommand(conn, command);
      
      // Parse output to check if IP exists
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        if (line.includes(tunnelIP)) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      console.error('Error checking IP assignment:', error.message);
      return false;
    }
  }

  /**
   * Add IP address to interface
   */
  async addIPAddress(conn, tunnelIP, interfaceName) {
    try {
      const command = `/ip address add address="${tunnelIP}/24" interface="${interfaceName}"`;
      await this.sshManager.executeCommand(conn, command);
      console.log(`Added IP ${tunnelIP}/24 to ${interfaceName}`);
    } catch (error) {
      throw new Error(`Failed to add IP address: ${error.message}`);
    }
  }

  /**
   * Check if NAT rule exists
   */
  async checkNATRule(conn, deviceConfig, controlConfig) {
    try {
      const command = `/ip firewall nat print where dst-port=${deviceConfig.mikrotik_ssh_port}`;
      const result = await this.sshManager.executeCommand(conn, command);
      
      // Check if rule exists for this port and target
      const output = result.stdout;
      return output.includes(deviceConfig.mikrotik_ssh_port.toString()) && 
             output.includes(deviceConfig.mikrotik_lhg60g_ip);
    } catch (error) {
      console.error('Error checking NAT rule:', error.message);
      return false;
    }
  }

  /**
   * Add NAT rule
   */
  async addNATRule(conn, deviceConfig, controlConfig) {
    try {
      const command = `/ip firewall nat add action=dst-nat chain=dstnat comment="${deviceConfig.name}" dst-address=${controlConfig.control_ip} dst-port=${deviceConfig.mikrotik_ssh_port} protocol=tcp to-addresses=${deviceConfig.mikrotik_lhg60g_ip} to-ports=22`;
      
      await this.sshManager.executeCommand(conn, command);
      console.log(`Added NAT rule for ${deviceConfig.name}`);
    } catch (error) {
      throw new Error(`Failed to add NAT rule: ${error.message}`);
    }
  }

  /**
   * Deprovision device from control router
   */
  async deprovisionDevice(deviceConfig, remainingDevices) {
    const results = {
      success: false,
      steps: [],
      warnings: []
    };

    let conn = null;

    try {
      // Get control router configuration
      const controlConfig = this.db.getMikroTikControlConfig();
      if (!controlConfig) {
        results.warnings.push('Control router configuration not found, skipping cleanup');
        results.success = true; // Continue with database deletion
        return results;
      }

      results.steps.push('Retrieved control router configuration');

      // Connect to control router
      conn = await this.sshManager.connectToControlRouter(controlConfig);
      results.steps.push('Connected to control router');

      // Remove NAT rule
      try {
        await this.removeNATRule(conn, deviceConfig);
        results.steps.push(`Removed NAT rule for port ${deviceConfig.mikrotik_ssh_port}`);
      } catch (error) {
        results.warnings.push(`Failed to remove NAT rule: ${error.message}`);
      }

      // Check if subnet is still in use
      const subnetInUse = this.checkSubnetUsage(deviceConfig.mikrotik_tunnel_ip, remainingDevices);
      
      if (subnetInUse) {
        results.steps.push(`IP address ${deviceConfig.mikrotik_tunnel_ip}/24 preserved (used by other devices)`);
      } else {
        try {
          await this.removeIPAddress(conn, deviceConfig.mikrotik_tunnel_ip, controlConfig.lhg60g_ethernet_interface);
          results.steps.push(`Removed IP address ${deviceConfig.mikrotik_tunnel_ip}/24 from ${controlConfig.lhg60g_ethernet_interface}`);
        } catch (error) {
          results.warnings.push(`Failed to remove IP address: ${error.message}`);
        }
      }

      results.success = true;
      results.message = 'Device deprovisioned successfully';

    } catch (error) {
      results.warnings.push(`Cleanup error: ${error.message}`);
      results.success = true; // Still allow database deletion
    } finally {
      if (conn) {
        this.sshManager.closeConnection(conn);
      }
    }

    return results;
  }

  /**
   * Remove NAT rule
   */
  async removeNATRule(conn, deviceConfig) {
    try {
      const command = `/ip firewall nat remove [find where dst-port=${deviceConfig.mikrotik_ssh_port} and to-addresses=${deviceConfig.mikrotik_lhg60g_ip}]`;
      await this.sshManager.executeCommand(conn, command);
      console.log(`Removed NAT rule for port ${deviceConfig.mikrotik_ssh_port}`);
    } catch (error) {
      if (!error.message.includes('no such item')) {
        throw error;
      }
      console.warn('NAT rule not found, may have been already removed');
    }
  }

  /**
   * Check if tunnel IP subnet is used by other devices
   */
  checkSubnetUsage(tunnelIP, remainingDevices) {
    // Extract subnet from tunnel IP (e.g., 10.117.114.40 -> 10.117.114.0/24)
    const parts = tunnelIP.split('.');
    if (parts.length !== 4) return false;
    
    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0`;

    // Check if any remaining device uses this subnet
    for (const device of remainingDevices) {
      if (device.device_type === 'mikrotik_lhg60g' && device.mikrotik_lhg60g_ip) {
        const deviceParts = device.mikrotik_lhg60g_ip.split('.');
        if (deviceParts.length === 4) {
          const deviceSubnet = `${deviceParts[0]}.${deviceParts[1]}.${deviceParts[2]}.0`;
          if (deviceSubnet === subnet) {
            console.log(`Subnet ${subnet} still in use by device ${device.name}`);
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Remove IP address from interface
   */
  async removeIPAddress(conn, tunnelIP, interfaceName) {
    try {
      const command = `/ip address remove [find where address="${tunnelIP}/24" and interface="${interfaceName}"]`;
      await this.sshManager.executeCommand(conn, command);
      console.log(`Removed IP ${tunnelIP}/24 from ${interfaceName}`);
    } catch (error) {
      if (!error.message.includes('no such item')) {
        throw error;
      }
      console.warn('IP address not found, may have been already removed');
    }
  }
}

module.exports = MikroTikProvisioning;
