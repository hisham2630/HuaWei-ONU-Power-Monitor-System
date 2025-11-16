const Database = require('better-sqlite3');
const CryptoJS = require('crypto-js');
const bcrypt = require('bcryptjs');
const path = require('path');

/**
 * Database Module
 * Handles all database operations with encryption for sensitive data
 */

class DatabaseManager {
  constructor(dbPath = './data/onu_monitor.db', encryptionKey = process.env.ENCRYPTION_KEY || 'default-key-change-me') {
    this.dbPath = dbPath;
    this.encryptionKey = encryptionKey;
    this.db = null;
    this.init();
  }

  /**
   * Initialize database and create tables
   */
  init() {
    const dbDir = path.dirname(this.dbPath);
    const fs = require('fs');
    
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    
    // Create users table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      )
    `);
    
    // Create ONU devices table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS onu_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        username TEXT NOT NULL,
        password_encrypted TEXT NOT NULL,
        onu_type TEXT NOT NULL CHECK(onu_type IN ('blue', 'red')),
        enabled INTEGER DEFAULT 1,
        
        -- Monitoring settings
        monitoring_interval INTEGER DEFAULT 900,
        retry_attempts INTEGER DEFAULT 3,
        retry_delay INTEGER DEFAULT 3,
        
        -- Notification settings
        notify_rx_power INTEGER DEFAULT 0,
        rx_power_threshold REAL DEFAULT -27.0,
        notify_temp_high INTEGER DEFAULT 0,
        temp_high_threshold REAL DEFAULT 70.0,
        notify_temp_low INTEGER DEFAULT 0,
        temp_low_threshold REAL DEFAULT 0.0,
        notify_offline INTEGER DEFAULT 0,
        
        -- Notification state tracking
        last_notification_sent DATETIME,
        is_offline_notified INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create SMS API configuration table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sms_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_url TEXT NOT NULL,
        phone_numbers TEXT,
        enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create device groups table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Migrate existing tables if needed
    this.migrateDatabase();
    
    // Create default admin user if not exists
    this.createDefaultAdmin();
  }

  /**
   * Migrate database schema for new columns
   */
  migrateDatabase() {
    const columns = [
      'monitoring_interval INTEGER DEFAULT 900',
      'retry_attempts INTEGER DEFAULT 3',
      'retry_delay INTEGER DEFAULT 3',
      'notify_rx_power INTEGER DEFAULT 0',
      'rx_power_threshold REAL DEFAULT -27.0',
      'notify_temp_high INTEGER DEFAULT 0',
      'temp_high_threshold REAL DEFAULT 70.0',
      'notify_temp_low INTEGER DEFAULT 0',
      'temp_low_threshold REAL DEFAULT 0.0',
      'notify_offline INTEGER DEFAULT 0',
      'last_notification_sent DATETIME',
      'is_offline_notified INTEGER DEFAULT 0',
      'consecutive_failures INTEGER DEFAULT 0',
      'group_id INTEGER',
      // Display preferences
      'show_temperature INTEGER DEFAULT 0',
      'show_ui_type INTEGER DEFAULT 0',
      'show_tx_power INTEGER DEFAULT 0'
    ];
    
    for (const column of columns) {
      const columnName = column.split(' ')[0];
      try {
        this.db.exec(`ALTER TABLE onu_devices ADD COLUMN ${column}`);
      } catch (err) {
        // Column already exists, ignore
      }
    }
    
    // Add phone_numbers column to sms_config if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE sms_config ADD COLUMN phone_numbers TEXT`);
    } catch (err) {
      // Column already exists, ignore
    }
  }

  /**
   * Create default admin user
   */
  createDefaultAdmin() {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM users');
    const result = stmt.get();
    
    if (result.count === 0) {
      const defaultPassword = 'admin123';
      const passwordHash = bcrypt.hashSync(defaultPassword, 10);
      
      const insert = this.db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      insert.run('admin', passwordHash);
      
      console.log('Default admin user created: admin / admin123');
      console.log('IMPORTANT: Please change the default password!');
    }
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(data) {
    return CryptoJS.AES.encrypt(data, this.encryptionKey).toString();
  }

  /**
   * Decrypt sensitive data
   */
  decrypt(encryptedData) {
    const bytes = CryptoJS.AES.decrypt(encryptedData, this.encryptionKey);
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  /**
   * User Authentication
   */
  authenticateUser(username, password) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    const user = stmt.get(username);
    
    if (!user) {
      return null;
    }
    
    const isValid = bcrypt.compareSync(password, user.password_hash);
    
    if (isValid) {
      // Update last login
      const updateStmt = this.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?');
      updateStmt.run(user.id);
      
      return {
        id: user.id,
        username: user.username
      };
    }
    
    return null;
  }

  /**
   * Change user password
   */
  changePassword(username, newPassword) {
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    const stmt = this.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?');
    const result = stmt.run(passwordHash, username);
    return result.changes > 0;
  }

  /**
   * Add ONU device
   */
  addONUDevice(name, host, username, password, onuType, config = {}) {
    const encryptedPassword = this.encrypt(password);
    
    const stmt = this.db.prepare(`
      INSERT INTO onu_devices (
        name, host, username, password_encrypted, onu_type, group_id,
        monitoring_interval, retry_attempts, retry_delay,
        notify_rx_power, rx_power_threshold,
        notify_temp_high, temp_high_threshold,
        notify_temp_low, temp_low_threshold,
        notify_offline,
        show_temperature, show_ui_type, show_tx_power
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      name, host, username, encryptedPassword, onuType, config.groupId || null,
      config.monitoringInterval || 900,
      config.retryAttempts || 3,
      config.retryDelay || 3,
      config.notifyRxPower ? 1 : 0,
      config.rxPowerThreshold || -27.0,
      config.notifyTempHigh ? 1 : 0,
      config.tempHighThreshold || 70.0,
      config.notifyTempLow ? 1 : 0,
      config.tempLowThreshold || 0.0,
      config.notifyOffline ? 1 : 0,
      config.showTemperature ? 1 : 0,
      config.showUIType ? 1 : 0,
      config.showTXPower ? 1 : 0
    );
    return result.lastInsertRowid;
  }

  /**
   * Update ONU device
   */
  updateONUDevice(id, name, host, username, password, onuType, config = {}) {
    const encryptedPassword = password ? this.encrypt(password) : null;
    
    let sql, params;
    if (encryptedPassword) {
      sql = `
        UPDATE onu_devices 
        SET name = ?, host = ?, username = ?, password_encrypted = ?, onu_type = ?, group_id = ?,
            monitoring_interval = ?, retry_attempts = ?, retry_delay = ?,
            notify_rx_power = ?, rx_power_threshold = ?,
            notify_temp_high = ?, temp_high_threshold = ?,
            notify_temp_low = ?, temp_low_threshold = ?,
            notify_offline = ?,
            show_temperature = ?, show_ui_type = ?, show_tx_power = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
      params = [
        name, host, username, encryptedPassword, onuType, config.groupId || null,
        config.monitoringInterval || 900,
        config.retryAttempts || 3,
        config.retryDelay || 3,
        config.notifyRxPower ? 1 : 0,
        config.rxPowerThreshold || -27.0,
        config.notifyTempHigh ? 1 : 0,
        config.tempHighThreshold || 70.0,
        config.notifyTempLow ? 1 : 0,
        config.tempLowThreshold || 0.0,
        config.notifyOffline ? 1 : 0,
        config.showTemperature ? 1 : 0,
        config.showUIType ? 1 : 0,
        config.showTXPower ? 1 : 0,
        id
      ];
    } else {
      sql = `
        UPDATE onu_devices 
        SET name = ?, host = ?, username = ?, onu_type = ?, group_id = ?,
            monitoring_interval = ?, retry_attempts = ?, retry_delay = ?,
            notify_rx_power = ?, rx_power_threshold = ?,
            notify_temp_high = ?, temp_high_threshold = ?,
            notify_temp_low = ?, temp_low_threshold = ?,
            notify_offline = ?,
            show_temperature = ?, show_ui_type = ?, show_tx_power = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
      params = [
        name, host, username, onuType, config.groupId || null,
        config.monitoringInterval || 900,
        config.retryAttempts || 3,
        config.retryDelay || 3,
        config.notifyRxPower ? 1 : 0,
        config.rxPowerThreshold || -27.0,
        config.notifyTempHigh ? 1 : 0,
        config.tempHighThreshold || 70.0,
        config.notifyTempLow ? 1 : 0,
        config.tempLowThreshold || 0.0,
        config.notifyOffline ? 1 : 0,
        config.showTemperature ? 1 : 0,
        config.showUIType ? 1 : 0,
        config.showTXPower ? 1 : 0,
        id
      ];
    }
    
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Delete ONU device
   */
  deleteONUDevice(id) {
    const stmt = this.db.prepare('DELETE FROM onu_devices WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get all ONU devices
   */
  getAllONUDevices() {
    const stmt = this.db.prepare('SELECT * FROM onu_devices WHERE enabled = 1 ORDER BY name');
    const devices = stmt.all();
    
    return devices.map(device => ({
      id: device.id,
      name: device.name,
      host: device.host,
      username: device.username,
      password: this.decrypt(device.password_encrypted),
      onuType: device.onu_type,
      groupId: device.group_id,
      monitoringInterval: device.monitoring_interval,
      retryAttempts: device.retry_attempts,
      retryDelay: device.retry_delay,
      notifyRxPower: device.notify_rx_power === 1,
      rxPowerThreshold: device.rx_power_threshold,
      notifyTempHigh: device.notify_temp_high === 1,
      tempHighThreshold: device.temp_high_threshold,
      notifyTempLow: device.notify_temp_low === 1,
      tempLowThreshold: device.temp_low_threshold,
      notifyOffline: device.notify_offline === 1,
      showTemperature: device.show_temperature === 1,
      showUIType: device.show_ui_type === 1,
      showTXPower: device.show_tx_power === 1,
      isOfflineNotified: device.is_offline_notified === 1,
      consecutiveFailures: device.consecutive_failures,
      createdAt: device.created_at,
      updatedAt: device.updated_at
    }));
  }

  /**
   * Get ONU device by ID
   */
  getONUDevice(id) {
    const stmt = this.db.prepare('SELECT * FROM onu_devices WHERE id = ?');
    const device = stmt.get(id);
    
    if (!device) return null;
    
    return {
      id: device.id,
      name: device.name,
      host: device.host,
      username: device.username,
      password: this.decrypt(device.password_encrypted),
      onuType: device.onu_type,
      groupId: device.group_id,
      monitoringInterval: device.monitoring_interval,
      retryAttempts: device.retry_attempts,
      retryDelay: device.retry_delay,
      notifyRxPower: device.notify_rx_power === 1,
      rxPowerThreshold: device.rx_power_threshold,
      notifyTempHigh: device.notify_temp_high === 1,
      tempHighThreshold: device.temp_high_threshold,
      notifyTempLow: device.notify_temp_low === 1,
      tempLowThreshold: device.temp_low_threshold,
      notifyOffline: device.notify_offline === 1,
      showTemperature: device.show_temperature === 1,
      showUIType: device.show_ui_type === 1,
      showTXPower: device.show_tx_power === 1,
      isOfflineNotified: device.is_offline_notified === 1,
      consecutiveFailures: device.consecutive_failures,
      createdAt: device.created_at,
      updatedAt: device.updated_at
    };
  }

  /**
   * Update device notification state
   */
  updateDeviceNotificationState(id, consecutiveFailures, isOfflineNotified) {
    const stmt = this.db.prepare(`
      UPDATE onu_devices 
      SET consecutive_failures = ?, 
          is_offline_notified = ?,
          last_notification_sent = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const result = stmt.run(consecutiveFailures, isOfflineNotified ? 1 : 0, id);
    return result.changes > 0;
  }

  /**
   * SMS API Configuration Methods
   */
  
  getSMSConfig() {
    const stmt = this.db.prepare('SELECT * FROM sms_config WHERE id = 1');
    const config = stmt.get();
    
    if (config && config.phone_numbers) {
      // Parse phone numbers from comma-separated string
      config.phoneNumbersArray = config.phone_numbers.split(',').map(p => p.trim()).filter(p => p);
    }
    
    return config;
  }
  
  saveSMSConfig(apiUrl, phoneNumbers, enabled = true) {
    const existing = this.getSMSConfig();
    
    // Convert array to comma-separated string if needed
    const phoneNumbersStr = Array.isArray(phoneNumbers) 
      ? phoneNumbers.join(', ') 
      : phoneNumbers || '';
    
    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE sms_config 
        SET api_url = ?, phone_numbers = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = 1
      `);
      stmt.run(apiUrl, phoneNumbersStr, enabled ? 1 : 0);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO sms_config (id, api_url, phone_numbers, enabled) 
        VALUES (1, ?, ?, ?)
      `);
      stmt.run(apiUrl, phoneNumbersStr, enabled ? 1 : 0);
    }
    return true;
  }

  /**
   * Toggle ONU device enabled status
   */
  toggleONUDevice(id, enabled) {
    const stmt = this.db.prepare('UPDATE onu_devices SET enabled = ? WHERE id = ?');
    const result = stmt.run(enabled ? 1 : 0, id);
    return result.changes > 0;
  }

  /**
   * Group Management Methods
   */

  /**
   * Create a new device group
   */
  createGroup(name) {
    try {
      const stmt = this.db.prepare('INSERT INTO device_groups (name) VALUES (?)');
      const result = stmt.run(name);
      return { id: result.lastInsertRowid, name };
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Group name already exists');
      }
      throw error;
    }
  }

  /**
   * Get all device groups
   */
  getAllGroups() {
    const stmt = this.db.prepare('SELECT * FROM device_groups ORDER BY name');
    return stmt.all();
  }

  /**
   * Get a device group by ID
   */
  getGroup(id) {
    const stmt = this.db.prepare('SELECT * FROM device_groups WHERE id = ?');
    return stmt.get(id);
  }

  /**
   * Update a device group
   */
  updateGroup(id, name) {
    try {
      const stmt = this.db.prepare('UPDATE device_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const result = stmt.run(name, id);
      return result.changes > 0;
    } catch (error) {
      if (error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Group name already exists');
      }
      throw error;
    }
  }

  /**
   * Delete a device group
   */
  deleteGroup(id) {
    // First, remove the group_id from all devices in this group
    const updateStmt = this.db.prepare('UPDATE onu_devices SET group_id = NULL WHERE group_id = ?');
    updateStmt.run(id);
    
    // Then delete the group
    const deleteStmt = this.db.prepare('DELETE FROM device_groups WHERE id = ?');
    const result = deleteStmt.run(id);
    return result.changes > 0;
  }

  /**
   * Assign a device to a group
   */
  assignDeviceToGroup(deviceId, groupId) {
    // First verify the group exists
    if (groupId !== null) {
      const group = this.getGroup(groupId);
      if (!group) {
        throw new Error('Group not found');
      }
    }
    
    const stmt = this.db.prepare('UPDATE onu_devices SET group_id = ? WHERE id = ?');
    const result = stmt.run(groupId, deviceId);
    return result.changes > 0;
  }

  /**
   * Get all devices in a group
   */
  getDevicesInGroup(groupId) {
    const stmt = this.db.prepare('SELECT * FROM onu_devices WHERE group_id = ?');
    return stmt.all(groupId);
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = DatabaseManager;
