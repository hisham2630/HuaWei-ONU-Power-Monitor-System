const Database = require('better-sqlite3');
const path = require('path');

/**
 * Tenda Database Migration
 * Adds support for Tenda ONU devices by removing the restrictive CHECK constraint
 * on the onu_type column
 */

function migrateTendaSupport(dbPath = './data/onu_monitor.db') {
    const db = new Database(dbPath);

    console.log('Starting Tenda ONU support migration...');

    try {
        // Check if the table has the old CHECK constraint
        console.log('Checking current table structure...');
        const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='onu_devices'").get();

        if (!tableInfo) {
            console.log('Table onu_devices does not exist yet. No migration needed.');
            db.close();
            return;
        }

        // Check if the constraint needs updating (doesn't include 'tenda')
        if (tableInfo.sql.includes("CHECK(onu_type IN ('blue', 'red'))") && !tableInfo.sql.includes("'tenda'")) {
            console.log('Found old CHECK constraint that needs updating...');

            // Begin transaction
            db.exec('BEGIN TRANSACTION');

            try {
                // Rename old table
                console.log('  Renaming old table...');
                db.exec('ALTER TABLE onu_devices RENAME TO onu_devices_old');

                // Drop monitoring_cache to remove FOREIGN KEY constraint
                console.log('  Dropping monitoring_cache table...');
                db.exec('DROP TABLE IF EXISTS monitoring_cache');

                // Create new table with updated CHECK constraint (including 'tenda')
                console.log('  Creating new table with Tenda support...');
                db.exec(`
          CREATE TABLE onu_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            username TEXT NOT NULL,
            password_encrypted TEXT NOT NULL,
            onu_type TEXT NOT NULL CHECK(onu_type IN ('blue', 'red', 'tenda')),
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
            show_online_duration INTEGER DEFAULT 0,
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
                console.log('  Copying existing device data...');

                // Get column names from old table
                const oldColumns = db.pragma('table_info(onu_devices_old)');
                const columnNames = oldColumns.map(col => col.name).filter(name =>
                    name !== 'id' && // Exclude auto-generated ID
                    !['mikrotik_lhg60g_ip', 'mikrotik_ssh_port', 'mikrotik_tunnel_ip',
                        'mikrotik_ssh_username', 'mikrotik_ssh_password_encrypted',
                        'notify_rssi', 'rssi_threshold', 'notify_port_speed', 'port_speed_threshold',
                        'show_rssi', 'show_port_speed', 'device_type', 'show_online_duration'].includes(name) ||
                    oldColumns.find(col => col.name === name)
                );

                // Build safe INSERT statement with only columns that exist
                const existingColumns = oldColumns.map(col => col.name);
                const copyColumns = existingColumns.join(', ');

                db.exec(`
          INSERT INTO onu_devices (${copyColumns})
          SELECT ${copyColumns}
          FROM onu_devices_old
        `);

                const rowCount = db.prepare('SELECT COUNT(*) as count FROM onu_devices').get().count;
                console.log(`  Migrated ${rowCount} devices`);

                // Drop old table
                console.log('  Dropping old table...');
                db.exec('DROP TABLE onu_devices_old');

                // Recreate monitoring_cache table
                console.log('  Recreating monitoring_cache table...');
                db.exec(`
          CREATE TABLE monitoring_cache (
            device_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            data TEXT,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (device_id) REFERENCES onu_devices(id) ON DELETE CASCADE
          )
        `);

                // Commit transaction
                db.exec('COMMIT');

                console.log('✓ Table recreated successfully with Tenda support!');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        } else if (tableInfo.sql.includes("'tenda'")) {
            console.log('Table already supports Tenda ONU type. No migration needed.');
        } else if (!tableInfo.sql.includes('CHECK(onu_type')) {
            console.log('Table has no CHECK constraint on onu_type. No migration needed.');
        } else {
            console.log('Unknown table state. Please check manually.');
        }

        console.log('✓ Tenda migration completed successfully!');
        console.log('');
        console.log('Database now supports Tenda ONU devices.');

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
    migrateTendaSupport(dbPath);
}

module.exports = { migrateTendaSupport };
