const { Client } = require('ssh2');

/**
 * SSH Connection Manager
 * Manages SSH connections to MikroTik control router and LHG60G devices
 */

class SSHManager {
  constructor() {
    this.connectionTimeout = 10000; // 10 seconds
    this.commandTimeout = 30000;    // 30 seconds
  }

  /**
   * Connect to control router
   */
  async connectToControlRouter(controlConfig) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('Connection timeout'));
      }, this.connectionTimeout);

      conn.on('ready', () => {
        clearTimeout(timeout);
        resolve(conn);
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({
        host: controlConfig.control_ip,
        port: 22,
        username: controlConfig.control_username,
        password: controlConfig.control_password,
        readyTimeout: this.connectionTimeout
      });
    });
  }

  /**
   * Execute command on control router
   */
  async executeCommand(conn, command) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Command execution timeout'));
      }, this.commandTimeout);

      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve({ stdout, stderr, exitCode: code });
          } else {
            reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
          }
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }

  /**
   * Execute command on LHG60G device through control router tunnel
   */
  async executeOnLHG60G(controlConfig, deviceConfig, command) {
    let conn = null;
    try {
      // Connect to control router
      conn = await this.connectToControlRouter(controlConfig);

      // Build nested SSH command
      const tunnelCommand = `sshpass -p '${deviceConfig.mikrotik_ssh_password}' ssh -o StrictHostKeyChecking=no -p ${deviceConfig.mikrotik_ssh_port} ${deviceConfig.mikrotik_ssh_username}@${controlConfig.control_ip} "${command}"`;

      // Execute command
      const result = await this.executeCommand(conn, tunnelCommand);
      
      return result.stdout;
    } finally {
      if (conn) {
        conn.end();
      }
    }
  }

  /**
   * Check if control router is reachable
   */
  async testConnection(controlConfig) {
    let conn = null;
    try {
      conn = await this.connectToControlRouter(controlConfig);
      const result = await this.executeCommand(conn, '/system identity print');
      return { success: true, output: result.stdout };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      if (conn) {
        conn.end();
      }
    }
  }

  /**
   * Verify interface exists on control router
   */
  async verifyInterface(conn, interfaceName) {
    try {
      const result = await this.executeCommand(conn, `/interface print where name="${interfaceName}"`);
      return result.stdout.includes(interfaceName);
    } catch (error) {
      return false;
    }
  }

  /**
   * Close connection
   */
  closeConnection(conn) {
    if (conn) {
      conn.end();
    }
  }
}

module.exports = SSHManager;
