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
    
    // Add device_type column
    console.log('Adding device_type column...');
    try {
      db.exec(`ALTER TABLE onu_devices ADD COLUMN device_type TEXT`);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) {
        throw err;
      }
      console.log('  device_type column already exists, skipping');
    }
    
    // Migrate existing onu_type to device_type
    console.log('Migrating existing device types...');
    const updateBlue = db.prepare(`
      UPDATE onu_devices 
      SET device_type = 'onu_blue' 
      WHERE onu_type = 'blue' AND (device_type IS NULL OR device_type = '')
    `);
    const blueCount = updateBlue.run().changes;
    console.log(`  Migrated ${blueCount} blue UI devices`);
    
    const updateRed = db.prepare(`
      UPDATE onu_devices 
      SET device_type = 'onu_red' 
      WHERE onu_type = 'red' AND (device_type IS NULL OR device_type = '')
    `);
    const redCount = updateRed.run().changes;
    console.log(`  Migrated ${redCount} red UI devices`);
    
    // Add MikroTik-specific columns
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
        console.log(`  Column ${columnName} already exists, skipping`);
      }
    }
    
    // Add check constraint for device_type (if not exists)
    console.log('Verifying device_type constraints...');
    // Note: SQLite doesn't support adding constraints to existing tables easily
    // The constraint will be enforced at application level
    
    console.log('✓ MikroTik migration completed successfully!');
    
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
