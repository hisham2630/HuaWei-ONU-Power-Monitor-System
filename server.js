const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const DatabaseManager = require('./lib/database');
const { monitorONU, checkConnectivity, getEthernetPortSpeeds } = require('./lib/onuMonitor');
const MikroTikMonitor = require('./lib/mikrotikMonitor');
const MikroTikProvisioning = require('./lib/mikrotikProvisioning');
const NotificationService = require('./lib/notificationService');
const MonitoringScheduler = require('./lib/monitoringScheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-key';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'onu_monitor_session';
const SESSION_DB_NAME = process.env.SESSION_DB_NAME || 'sessions.db';

// Initialize database
const db = new DatabaseManager();

// Initialize MikroTik services
const mikrotikMonitor = new MikroTikMonitor(db);
const mikrotikProvisioning = new MikroTikProvisioning(db);

// Initialize notification service
const notificationService = new NotificationService(db);

// Initialize monitoring scheduler
const monitoringScheduler = new MonitoringScheduler(db, notificationService);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration with database storage
app.use(session({
  store: new SQLiteStore({
    db: SESSION_DB_NAME,
    dir: './data',
    table: 'sessions'
  }),
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 86400000, // 24 hours (1 day) in milliseconds
    httpOnly: true,
    secure: false // Set to true if using HTTPS
  }
}));

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// ==================== ROUTES ====================

// Login page
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

// API: Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  const user = db.authenticateUser(username, password);
  
  if (user) {
    req.session.user = user;
    res.json({ success: true, user: { username: user.username } });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// API: Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// API: Check authentication status
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: { username: req.session.user.username } });
  } else {
    res.json({ authenticated: false });
  }
});

// API: Change password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  
  // Verify current password
  const user = db.authenticateUser(req.session.user.username, currentPassword);
  if (!user) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  
  // Change password
  const success = db.changePassword(req.session.user.username, newPassword);
  
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// API: Get all ONU devices
app.get('/api/devices', requireAuth, (req, res) => {
  try {
    const devices = db.getAllONUDevices();
    // Don't send passwords to client
    const safeDevices = devices.map(d => {
      const safeDevice = {
        id: d.id,
        name: d.name,
        host: d.host,
        device_type: d.device_type,
        groupId: d.groupId,
        monitoringInterval: d.monitoringInterval,
        retryAttempts: d.retryAttempts,
        retryDelay: d.retryDelay,
        notifyOffline: d.notifyOffline,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      };

      // Add device-type-specific fields
      if (d.device_type === 'mikrotik_lhg60g') {
        // MikroTik device fields
        safeDevice.mikrotikLhg60gIp = d.mikrotikLhg60gIp;
        safeDevice.mikrotikSshPort = d.mikrotikSshPort;
        safeDevice.mikrotikTunnelIp = d.mikrotikTunnelIp;
        safeDevice.mikrotikSshUsername = d.mikrotikSshUsername;
        // Don't send password
        safeDevice.notifyRssi = d.notifyRssi;
        safeDevice.rssiThreshold = d.rssiThreshold;
        safeDevice.notifyPortSpeed = d.notifyPortSpeed;
        safeDevice.portSpeedThreshold = d.portSpeedThreshold;
        safeDevice.showRssi = d.showRssi;
        safeDevice.showMikrotikPortSpeed = d.showMikrotikPortSpeed;
      } else {
        // ONU device fields
        safeDevice.username = d.username;
        safeDevice.onuType = d.onuType;
        safeDevice.notifyRxPower = d.notifyRxPower;
        safeDevice.rxPowerThreshold = d.rxPowerThreshold;
        safeDevice.notifyTempHigh = d.notifyTempHigh;
        safeDevice.tempHighThreshold = d.tempHighThreshold;
        safeDevice.notifyTempLow = d.notifyTempLow;
        safeDevice.tempLowThreshold = d.tempLowThreshold;
        safeDevice.showTemperature = d.showTemperature;
        safeDevice.showUIType = d.showUIType;
        safeDevice.showTXPower = d.showTXPower;
        safeDevice.showPortSpeeds = d.showPortSpeeds;
        safeDevice.portSelections = d.portSelections;
        safeDevice.portMonitoringConfig = d.portMonitoringConfig;
        safeDevice.notifyPortDown = d.notifyPortDown;
      }

      return safeDevice;
    });
    res.json(safeDevices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Add ONU device
app.post('/api/devices', requireAuth, (req, res) => {
  try {
    const { name, host, username, password, onuType, groupId, config } = req.body;
    
    if (!name || !host || !username || !password || !onuType) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    if (!['blue', 'red'].includes(onuType)) {
      return res.status(400).json({ error: 'Invalid ONU type' });
    }
    
    // Add groupId to config if provided
    const updatedConfig = config || {};
    if (groupId !== undefined) {
      updatedConfig.groupId = groupId;
    }
    
    const id = db.addONUDevice(name, host, username, password, onuType, updatedConfig);
    res.json({ success: true, id: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Update ONU device
app.put('/api/devices/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { name, host, username, password, onuType, groupId, config } = req.body;
    
    if (!name || !host || !username || !onuType) {
      return res.status(400).json({ error: 'Name, host, username, and ONU type are required' });
    }
    
    if (!['blue', 'red'].includes(onuType)) {
      return res.status(400).json({ error: 'Invalid ONU type' });
    }
    
    // Add groupId to config if provided
    const updatedConfig = config || {};
    if (groupId !== undefined) {
      updatedConfig.groupId = groupId;
    }
    
    const success = db.updateONUDevice(id, name, host, username, password || null, onuType, updatedConfig);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Delete ONU device
app.delete('/api/devices/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const success = db.deleteONUDevice(id);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Monitor ONU device
app.post('/api/devices/:id/monitor', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const device = db.getONUDevice(id);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Check if port speeds should be included based on device configuration
    const includePortSpeeds = device.showPortSpeeds === true;
    
    const result = await monitorONU({
      host: device.host,
      username: device.username,
      password: device.password
    }, includePortSpeeds);
    
    // Update monitoring cache with the fresh result
    let status, data;
    if (result.success) {
      status = 'online';
      data = result.data;
    } else {
      status = 'offline';
      data = null;
    }
    db.updateMonitoringCache(id, status, data);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get Ethernet port speeds for ONU device
app.post('/api/devices/:id/port-speeds', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const device = db.getONUDevice(id);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Login to the device
    const loginResult = await require('./lib/onuMonitor').login(device.host, device.username, device.password);
    
    if (!loginResult.success) {
      return res.status(401).json({ error: 'Failed to login to device' });
    }
    
    // Get Ethernet port speeds
    const portSpeeds = await getEthernetPortSpeeds(loginResult.apiClient, loginResult.cookies, device.host);
    
    res.json({ success: true, portSpeeds });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Check ONU connectivity
app.post('/api/devices/:id/check', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const device = db.getONUDevice(id);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const isOnline = await checkConnectivity(device.host);
    res.json({ online: isOnline });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get cached monitoring data for all devices
app.get('/api/devices/cached-status', requireAuth, (req, res) => {
  try {
    const cache = db.getAllMonitoringCache();
    const result = {};
    
    cache.forEach(item => {
      result[item.deviceId] = {
        status: item.status,
        data: item.data,
        lastUpdated: item.lastUpdated
      };
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Monitor all devices (parallel batch processing with concurrency limit)
app.post('/api/devices/monitor-all', requireAuth, async (req, res) => {
  try {
    const devices = db.getAllONUDevices();
    const maxConcurrent = 10; // Limit concurrent monitoring operations (conservative for SSH)
    const results = {};
    
    // Process devices in batches to avoid overwhelming the server
    for (let i = 0; i < devices.length; i += maxConcurrent) {
      const batch = devices.slice(i, i + maxConcurrent);
      
      console.log(`Processing batch ${Math.floor(i / maxConcurrent) + 1}/${Math.ceil(devices.length / maxConcurrent)} (${batch.length} devices)`);
      
      const batchPromises = batch.map(async (device) => {
        try {
          // Get full device with credentials
          const fullDevice = db.getDeviceWithCredentials(device.id);
          if (!fullDevice) {
            return {
              deviceId: device.id,
              result: {
                success: false,
                error: 'Device not found'
              }
            };
          }
          
          let result;
          
          // Check device type and call appropriate monitoring function
          if (fullDevice.device_type === 'mikrotik_lhg60g') {
            // MikroTik device monitoring
            result = await mikrotikMonitor.monitorMikroTik(fullDevice);
          } else {
            // ONU device monitoring
            const includePortSpeeds = fullDevice.showPortSpeeds === true;
            result = await monitorONU({
              host: fullDevice.host,
              username: fullDevice.username,
              password: fullDevice.password
            }, includePortSpeeds);
          }
          
          // Update monitoring cache with the result
          let status, data;
          if (result.success) {
            status = 'online';
            data = result.data;
          } else {
            status = 'offline';
            data = null;
          }
          db.updateMonitoringCache(device.id, status, data);
          
          return { deviceId: device.id, result };
        } catch (error) {
          return {
            deviceId: device.id,
            result: {
              success: false,
              error: error.message
            }
          };
        }
      });
      
      // Wait for current batch to complete
      const batchResults = await Promise.all(batchPromises);
      
      // Add batch results to main results object
      batchResults.forEach(({ deviceId, result }) => {
        results[deviceId] = result;
      });
    }
    
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get SMS configuration
app.get('/api/sms-config', requireAuth, (req, res) => {
  try {
    const config = db.getSMSConfig();
    if (config) {
      res.json({
        apiUrl: config.api_url,
        phoneNumbers: config.phone_numbers || '',
        enabled: config.enabled === 1
      });
    } else {
      res.json({
        apiUrl: '',
        phoneNumbers: '',
        enabled: false
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MIKROTIK API ====================

// API: Get MikroTik control router configuration
app.get('/api/mikrotik/control-config', requireAuth, (req, res) => {
  try {
    const config = db.getMikroTikControlConfig();
    if (config) {
      // Don't send password to client
      res.json({
        controlIp: config.control_ip,
        controlUsername: config.control_username,
        wireguardInterface: config.wireguard_interface,
        lhg60gEthernetInterface: config.lhg60g_ethernet_interface,
        basePort: config.base_port
      });
    } else {
      res.json(null);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Save MikroTik control router configuration
app.post('/api/mikrotik/control-config', requireAuth, (req, res) => {
  try {
    const { controlIp, username, password, wireguardInterface, lhg60gInterface, basePort } = req.body;
    
    if (!controlIp || !username || !wireguardInterface || !lhg60gInterface) {
      return res.status(400).json({ error: 'All fields are required (password optional when updating)' });
    }
    
    db.saveMikroTikControlConfig(
      controlIp,
      username,
      password,  // Can be undefined when updating
      wireguardInterface,
      lhg60gInterface,
      basePort || 60001
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Test MikroTik control router connection
app.post('/api/mikrotik/control-config/test', requireAuth, async (req, res) => {
  try {
    const { controlIp, username, password } = req.body;
    
    if (!controlIp || !username || !password) {
      return res.status(400).json({ error: 'All credentials required for testing' });
    }
    
    const SSHManager = require('./lib/sshManager');
    const sshManager = new SSHManager();
    
    const result = await sshManager.testConnection({
      control_ip: controlIp,
      control_username: username,
      control_password: password
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Add MikroTik LHG60G device
app.post('/api/mikrotik/devices', requireAuth, async (req, res) => {
  try {
    const { name, lhg60gIP, sshPort, sshUsername, sshPassword, tunnelIP, groupId, config } = req.body;
    
    if (!name || !lhg60gIP || !sshPort || !sshUsername || !sshPassword || !tunnelIP) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Add groupId to config if provided
    const updatedConfig = config || {};
    if (groupId !== undefined) {
      updatedConfig.groupId = groupId;
    }
    
    // Add device to database
    const deviceId = db.addMikroTikDevice(name, lhg60gIP, sshPort, sshUsername, sshPassword, tunnelIP, updatedConfig);
    
    // Get the full device config for provisioning
    const device = db.getDeviceWithCredentials(deviceId);
    device.name = name; // Ensure name is set
    
    // Provision device on control router
    const provisionResult = await mikrotikProvisioning.provisionDevice(device);
    
    res.json({ 
      success: true, 
      id: deviceId,
      provisioning: provisionResult
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Update MikroTik LHG60G device
app.put('/api/mikrotik/devices/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, lhg60gIP, sshPort, sshUsername, sshPassword, tunnelIP, groupId, config } = req.body;
    
    if (!name || !lhg60gIP || !sshPort || !sshUsername || !tunnelIP) {
      return res.status(400).json({ error: 'Name, IP, port, username, and tunnel IP are required' });
    }
    
    // Add groupId to config if provided
    const updatedConfig = config || {};
    if (groupId !== undefined) {
      updatedConfig.groupId = groupId;
    }
    
    const success = db.updateMikroTikDevice(id, name, lhg60gIP, sshPort, sshUsername, sshPassword || null, tunnelIP, updatedConfig);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Device not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Delete MikroTik LHG60G device with cleanup
app.delete('/api/mikrotik/devices/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get device before deletion
    const device = db.getDeviceWithCredentials(id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Get all remaining MikroTik devices (excluding this one)
    const allDevices = db.getAllONUDevices();
    const remainingDevices = allDevices.filter(d => d.id !== parseInt(id));
    
    // Delete from database first
    const deleted = db.deleteONUDevice(id);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Attempt cleanup on control router
    const cleanupResult = await mikrotikProvisioning.deprovisionDevice(device, remainingDevices);
    
    res.json({ 
      success: true,
      cleanup: cleanupResult
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Monitor MikroTik device
app.post('/api/mikrotik/devices/:id/monitor', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const device = db.getDeviceWithCredentials(id);
    
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const result = await mikrotikMonitor.monitorMikroTik(device);
    
    // Update monitoring cache
    let status, data;
    if (result.success) {
      status = 'online';
      data = result.data;
    } else {
      status = 'offline';
      data = null;
    }
    db.updateMonitoringCache(id, status, data);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== END MIKROTIK API ====================

// ==================== GROUP MANAGEMENT API ====================

// API: Get all groups
app.get('/api/groups', requireAuth, (req, res) => {
  try {
    const groups = db.getAllGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Create a new group
app.post('/api/groups', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    
    const group = db.createGroup(name);
    res.json(group);
  } catch (error) {
    if (error.message === 'Group name already exists') {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// API: Update a group
app.put('/api/groups/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    
    const success = db.updateGroup(id, name);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Group not found' });
    }
  } catch (error) {
    if (error.message === 'Group name already exists') {
      res.status(400).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// API: Delete a group
app.delete('/api/groups/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const success = db.deleteGroup(id);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Group not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Assign device to group
app.post('/api/devices/:deviceId/group/:groupId', requireAuth, (req, res) => {
  try {
    const { deviceId, groupId } = req.params;
    
    // Check if device exists
    const device = db.getONUDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    // Check if group exists (null is allowed to remove from group)
    if (groupId !== 'null' && groupId !== 'undefined') {
      const group = db.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
    }
    
    const groupIdValue = groupId === 'null' || groupId === 'undefined' ? null : parseInt(groupId);
    const success = db.assignDeviceToGroup(deviceId, groupIdValue);
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to assign device to group' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== END GROUP MANAGEMENT API ====================

// API: Save SMS configuration
app.post('/api/sms-config', requireAuth, (req, res) => {
  try {
    const { apiUrl, phoneNumbers, enabled } = req.body;
    
    if (!apiUrl) {
      return res.status(400).json({ error: 'API URL is required' });
    }
    
    // Validate URL contains placeholders
    if (!apiUrl.includes('{phone}') || !apiUrl.includes('{message}')) {
      return res.status(400).json({ 
        error: 'API URL must contain {phone} and {message} placeholders' 
      });
    }
    
    db.saveSMSConfig(apiUrl, phoneNumbers, enabled !== false);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`);
  console.log(`║   ONU Power Monitor WebUI Server Started      ║`);
  console.log(`╠═══════════════════════════════════════════════╣`);
  console.log(`║  Server running at: http://localhost:${PORT}     ║`);
  console.log(`║  Default credentials: admin / admin123        ║`);
  console.log(`║  CHANGE DEFAULT PASSWORD IMMEDIATELY!         ║`);
  console.log(`╠═══════════════════════════════════════════════╣`);
  console.log(`║  Background monitoring: ENABLED               ║`);
  console.log(`╚═══════════════════════════════════════════════╝\n`);
  
  // Start background monitoring
  monitoringScheduler.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, stopping monitoring and closing database...');
  monitoringScheduler.stop();
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, stopping monitoring and closing database...');
  monitoringScheduler.stop();
  db.close();
  process.exit(0);
});
