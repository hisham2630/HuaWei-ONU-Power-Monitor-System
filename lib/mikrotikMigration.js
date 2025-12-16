const Database = require('better-sqlite3');
const path = require('path');

/**
 * MikroTik Database Migration
 * Adds support for MikroTik LHG60G devices
 */

function migrateMikroTikSupport(dbPath = './data/onu_monitor.db') {
  const db = new Database(dbPath);
  
  console.log('Starting MikroTik database migration...');
  
  try {
    // Create mikrotik_control_config table
    console.log('Creating mikrotik_control_config table...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS mikrotik_control_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        control_ip TEXT NOT NULL,
        control_username TEXT NOT NULL,
        control_password_encrypted TEXT NOT NULL,
        wireguard_interface TEXT NOT NULL,
        lhg60g_ethernet_interface TEXT NOT NULL,
        base_port INTEGER DEFAULT 60001,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Check if we need to recreate the onu_devices table
    console.log('Checking if table recreation is needed...');
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='onu_devices'").get();
    
    if (tableInfo && tableInfo.sql.includes("CHECK(onu_type IN ('blue', 'red'))")) {
      console.log('Table has old CHECK constraint, recreating table...');
      
      // Begin transaction
      db.exec('BEGIN TRANSACTION');
      
      try {
        // Rename old table
        db.exec('ALTER TABLE onu_devices RENAME TO onu_devices_old');
        
        // Drop monitoring_cache to remove FOREIGN KEY constraint
        db.exec('DROP TABLE IF EXISTS monitoring_cache');
        
        // Create new table without CHECK constraint on onu_type
        db.exec(`
          CREATE TABLE onu_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            username TEXT NOT NULL,
            password_encrypted TEXT NOT NULL,
            onu_type TEXT,
            device_type TEXT,
            enabled INTEGER DEFAULT 1,
            
            -- Monitoring settings
            monitoring_interval INTEGER DEFAULT 900,
            retry_attempts INTEGER DEFAULT 3,
            retry_delay INTEGER DEFAULT 3,
            
            -- ONU Notification settings
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
            
            -- Group
            group_id INTEGER,
            
            -- Display preferences
            show_temperature INTEGER DEFAULT 0,
            show_ui_type INTEGER DEFAULT 0,
            show_tx_power INTEGER DEFAULT 0,
            show_port_speeds INTEGER DEFAULT 0,
            port_selections TEXT,
            
            -- Ethernet port monitoring preferences
            port_monitoring_config TEXT,
            notify_port_down INTEGER DEFAULT 0,
            
            -- MikroTik-specific fields
            mikrotik_lhg60g_ip TEXT,
            mikrotik_ssh_port INTEGER,
            mikrotik_tunnel_ip TEXT,
            mikrotik_ssh_username TEXT,
            mikrotik_ssh_password_encrypted TEXT,
            notify_rssi INTEGER DEFAULT 0,
            rssi_threshold REAL DEFAULT -66.0,
            notify_port_speed INTEGER DEFAULT 0,
            port_speed_threshold INTEGER DEFAULT 1000,
            show_rssi INTEGER DEFAULT 1,
            show_port_speed INTEGER DEFAULT 1,
            
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        
        // Copy data from old table to new table
        console.log('Copying existing device data...');
        db.exec(`
          INSERT INTO onu_devices (
            id, name, host, username, password_encrypted, onu_type, device_type, enabled,
            monitoring_interval, retry_attempts, retry_delay,
            notify_rx_power, rx_power_threshold,
            notify_temp_high, temp_high_threshold,
            notify_temp_low, temp_low_threshold,
            notify_offline,
            last_notification_sent, is_offline_notified, consecutive_failures,
            group_id,
            show_temperature, show_ui_type, show_tx_power, show_port_speeds, port_selections,
            port_monitoring_config, notify_port_down,
            created_at, updated_at
          )
          SELECT 
            id, name, host, username, password_encrypted, onu_type,
            CASE 
              WHEN onu_type = 'blue' THEN 'onu_blue'
              WHEN onu_type = 'red' THEN 'onu_red'
              ELSE onu_type
            END as device_type,
            enabled,
            COALESCE(monitoring_interval, 900),
            COALESCE(retry_attempts, 3),
            COALESCE(retry_delay, 3),
            COALESCE(notify_rx_power, 0),
            COALESCE(rx_power_threshold, -27.0),
            COALESCE(notify_temp_high, 0),
            COALESCE(temp_high_threshold, 70.0),
            COALESCE(notify_temp_low, 0),
            COALESCE(temp_low_threshold, 0.0),
            COALESCE(notify_offline, 0),
            last_notification_sent,
            COALESCE(is_offline_notified, 0),
            COALESCE(consecutive_failures, 0),
            group_id,
            COALESCE(show_temperature, 0),
            COALESCE(show_ui_type, 0),
            COALESCE(show_tx_power, 0),
            COALESCE(show_port_speeds, 0),
            port_selections,
            port_monitoring_config,
            COALESCE(notify_port_down, 0),
            created_at,
            updated_at
          FROM onu_devices_old
        `);
        
        const rowCount = db.prepare('SELECT COUNT(*) as count FROM onu_devices').get().count;
        console.log(`  Migrated ${rowCount} devices`);
        
        // Drop old table
        db.exec('DROP TABLE onu_devices_old');
        
        // Recreate monitoring_cache table with proper FOREIGN KEY
        db.exec(`
          CREATE TABLE monitoring_cache (
            device_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            data TEXT,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (device_id) REFERENCES onu_devices(id) ON DELETE CASCADE
          )
        `);
        console.log('  Recreated monitoring_cache table');
        
        // Commit transaction
        db.exec('COMMIT');
        
        console.log('✓ Table recreated successfully without CHECK constraint');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } else {
      console.log('Table structure is already compatible, skipping recreation');
      
      // Just add device_type column if it doesn't exist
      try {
        db.exec(`ALTER TABLE onu_devices ADD COLUMN device_type TEXT`);
        console.log('Added device_type column');
      } catch (err) {
        if (!err.message.includes('duplicate column name')) {
          throw err;
        }
        console.log('device_type column already exists');
      }
      
      // Migrate existing onu_type to device_type if needed
      const needsMigration = db.prepare(`
        SELECT COUNT(*) as count FROM onu_devices 
        WHERE (device_type IS NULL OR device_type = '') AND onu_type IS NOT NULL
      `).get().count;
      
      if (needsMigration > 0) {
        console.log('Migrating existing device types...');
        db.exec(`
          UPDATE onu_devices 
          SET device_type = CASE 
            WHEN onu_type = 'blue' THEN 'onu_blue'
            WHEN onu_type = 'red' THEN 'onu_red'
            ELSE onu_type
          END
          WHERE device_type IS NULL OR device_type = ''
        `);
        console.log(`  Migrated ${needsMigration} devices`);
      }
      
      // Add MikroTik-specific columns if they don't exist
      const mikrotikColumns = [
        'mikrotik_lhg60g_ip TEXT',
        'mikrotik_ssh_port INTEGER',
        'mikrotik_tunnel_ip TEXT',
        'mikrotik_ssh_username TEXT',
        'mikrotik_ssh_password_encrypted TEXT',
        'notify_rssi INTEGER DEFAULT 0',
        'rssi_threshold REAL DEFAULT -66.0',
        'notify_port_speed INTEGER DEFAULT 0',
        'port_speed_threshold INTEGER DEFAULT 1000',
        'show_rssi INTEGER DEFAULT 1',
        'show_port_speed INTEGER DEFAULT 1'
      ];
      
      console.log('Adding MikroTik-specific columns...');
      for (const column of mikrotikColumns) {
        const columnName = column.split(' ')[0];
        try {
          db.exec(`ALTER TABLE onu_devices ADD COLUMN ${column}`);
          console.log(`  Added column: ${columnName}`);
        } catch (err) {
          if (!err.message.includes('duplicate column name')) {
            throw err;
          }
        }
      }
    }
    
    console.log('✓ MikroTik migration completed successfully!');
    console.log('');
    console.log('Database is now ready to support both ONU and MikroTik devices');
    
  } catch (error) {
    console.error('✗ Migration failed:', error.message);
    throw error;
  } finally {
    db.close();
  }
}

// Run migration if executed directly
if (require.main === module) {
  const dbPath = process.argv[2] || './data/onu_monitor.db';
  migrateMikroTikSupport(dbPath);
}

module.exports = { migrateMikroTikSupport };
