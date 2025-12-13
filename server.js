const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const DatabaseManager = require('./lib/database');
const { monitorONU, checkConnectivity, getEthernetPortSpeeds } = require('./lib/onuMonitor');
const NotificationService = require('./lib/notificationService');
const MonitoringScheduler = require('./lib/monitoringScheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-key';

// Initialize database
const db = new DatabaseManager();

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
    db: 'sessions.db',
    dir: './data',
    table: 'sessions'
  }),
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
    const safeDevices = devices.map(d => ({
      id: d.id,
      name: d.name,
      host: d.host,
      username: d.username,
      onuType: d.onuType,
      groupId: d.groupId,
      monitoringInterval: d.monitoringInterval,
      retryAttempts: d.retryAttempts,
      retryDelay: d.retryDelay,
      notifyRxPower: d.notifyRxPower,
      rxPowerThreshold: d.rxPowerThreshold,
      notifyTempHigh: d.notifyTempHigh,
      tempHighThreshold: d.tempHighThreshold,
      notifyTempLow: d.notifyTempLow,
      tempLowThreshold: d.tempLowThreshold,
      notifyOffline: d.notifyOffline,
      // Display preferences
      showTemperature: d.showTemperature,
      showUIType: d.showUIType,
      showTXPower: d.showTXPower,
      showPortSpeeds: d.showPortSpeeds,
      portSelections: d.portSelections,
      // Ethernet port monitoring preferences
      portMonitoringConfig: d.portMonitoringConfig,
      notifyPortDown: d.notifyPortDown,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt
    }));
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

// API: Monitor all devices
app.post('/api/devices/monitor-all', requireAuth, async (req, res) => {
  try {
    const devices = db.getAllONUDevices();
    const results = {};
    
    for (const device of devices) {
      try {
        // Check if port speeds should be included based on device configuration
        const includePortSpeeds = device.showPortSpeeds === true;
        
        const result = await monitorONU({
          host: device.host,
          username: device.username,
          password: device.password
        }, includePortSpeeds);
        results[device.id] = result;
      } catch (error) {
        results[device.id] = {
          success: false,
          error: error.message
        };
      }
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
