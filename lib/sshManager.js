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
          
          // MikroTik RouterOS may return non-zero exit codes even on success
          // If stderr is empty and stdout has some content or is empty (for add commands),
          // treat it as success
          if (code === 0 || (stderr.trim() === '' && !stderr.includes('failure') && !stderr.includes('error'))) {
            resolve({ stdout, stderr, exitCode: code });
          } else {
            // Only reject if there's actual error output
            if (stderr.includes('failure') || stderr.includes('error') || stderr.includes('invalid')) {
              reject(new Error(`Command failed: ${stderr || stdout}`));
            } else {
              // Non-zero exit but no error output - treat as success (MikroTik quirk)
              console.warn(`Command returned exit code ${code} but no error output, treating as success`);
              resolve({ stdout, stderr, exitCode: code });
            }
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
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('LHG60G connection timeout'));
      }, this.connectionTimeout);

      conn.on('ready', () => {
        clearTimeout(timeout);
        
        // Execute command on LHG60G device
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code, signal) => {
            conn.end();
            
            // MikroTik devices may return non-zero exit codes
            if (stderr.includes('failure') || stderr.includes('error') || stderr.includes('invalid')) {
              reject(new Error(`Command failed: ${stderr}`));
            } else {
              resolve(stdout);
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

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Connect to LHG60G through NAT port on control router
      conn.connect({
        host: controlConfig.control_ip,
        port: deviceConfig.mikrotik_ssh_port,  // NAT forwarded port
        username: deviceConfig.mikrotik_ssh_username,
        password: deviceConfig.mikrotik_ssh_password,
        readyTimeout: this.connectionTimeout
      });
    });
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
