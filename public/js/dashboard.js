// Dashboard JavaScript - Grouped PRTG-style Layout
let devices = [];
let groups = [];
let monitoringData = {};
let deviceStatuses = {};
let collapsedGroups = new Set();
let lastUpdatedTimestamp = null;

// Check auth on load
window.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadGroups();
    await loadDevices();
    await loadSMSConfig();
    await loadMikroTikControlConfig();
    
    // Setup filter input
    document.getElementById('filterInput').addEventListener('input', renderDevices);
    
    // Setup port speeds configuration toggle
    document.getElementById('showPortSpeeds').addEventListener('change', function() {
        document.getElementById('portSpeedsConfig').style.display = this.checked ? 'block' : 'none';
    });
});

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch('/api/auth/status');
        const data = await response.json();
        
        if (!data.authenticated) {
            window.location.href = '/';
            return;
        }
        
        document.getElementById('currentUser').textContent = data.user.username;
    } catch (error) {
        window.location.href = '/';
    }
}

// Logout
async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        showToast('Logout failed', 'danger');
    }
}

// Load groups
async function loadGroups() {
    try {
        const response = await fetch('/api/groups');
        if (response.ok) {
            groups = await response.json();
        } else {
            groups = [];
        }
        updateGroupsDropdown();
        updateGroupsList();
    } catch (error) {
        console.error('Failed to load groups:', error);
        groups = [];
    }
}

// Update groups dropdown in device form
function updateGroupsDropdown() {
    const select = document.getElementById('deviceGroup');
    select.innerHTML = '<option value="">No Group</option>';
    groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        select.appendChild(option);
    });
}

// Update groups list in manage groups modal
function updateGroupsList() {
    const list = document.getElementById('groupsList');
    if (groups.length === 0) {
        list.innerHTML = '<p class="text-muted small mb-0">No groups yet</p>';
        return;
    }
    
    list.innerHTML = groups.map(group => `
        <div class="list-group-item d-flex justify-content-between align-items-center">
            <span>${escapeHtml(group.name)}</span>
            <button class="btn btn-danger btn-sm" onclick="deleteGroup(${group.id})">
                <i class="bi bi-trash"></i>
            </button>
        </div>
    `).join('');
}

// Add new group
async function addGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    if (!name) {
        showToast('Please enter a group name', 'warning');
        return;
    }
    
    try {
        const response = await fetch('/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        
        if (response.ok) {
            document.getElementById('newGroupName').value = '';
            await loadGroups();
            renderDevices();
            showToast('Group added successfully', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to add group', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Delete group
async function deleteGroup(groupId) {
    if (!confirm('Are you sure you want to delete this group? Devices in this group will be moved to "No Group".')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/groups/${groupId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            await loadGroups();
            await loadDevices();
            showToast('Group deleted successfully', 'success');
        } else {
            showToast('Failed to delete group', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Load devices
async function loadDevices() {
    try {
        const response = await fetch('/api/devices');
        devices = await response.json();
        renderDevices();
        
        // Load cached status instead of triggering immediate refresh
        await loadCachedStatus();
    } catch (error) {
        showToast('Failed to load devices', 'danger');
    }
}

// Load cached monitoring status from database
async function loadCachedStatus() {
    try {
        const response = await fetch('/api/devices/cached-status');
        const cachedData = await response.json();
        
        let mostRecentUpdate = null;
        
        // Update UI with cached data
        for (const [deviceId, cache] of Object.entries(cachedData)) {
            const id = parseInt(deviceId);
            deviceStatuses[id] = cache.status;
            if (cache.data) {
                monitoringData[id] = cache.data;
            }
            
            // Track most recent update time
            if (cache.lastUpdated) {
                const updateTime = new Date(cache.lastUpdated);
                if (!mostRecentUpdate || updateTime > mostRecentUpdate) {
                    mostRecentUpdate = updateTime;
                }
            }
        }
        
        // Check if we have a manual refresh timestamp stored in localStorage
        const storedTimestamp = localStorage.getItem('lastManualRefresh');
        let manualRefreshTime = storedTimestamp ? new Date(storedTimestamp) : null;
        
        // Always use the most recent timestamp (whether from manual refresh or background monitoring)
        if (manualRefreshTime && mostRecentUpdate) {
            lastUpdatedTimestamp = manualRefreshTime > mostRecentUpdate ? manualRefreshTime : mostRecentUpdate;
            // If background monitoring is more recent, clear the manual refresh timestamp
            if (mostRecentUpdate > manualRefreshTime) {
                localStorage.removeItem('lastManualRefresh');
            }
        } else if (manualRefreshTime) {
            lastUpdatedTimestamp = manualRefreshTime;
        } else if (mostRecentUpdate) {
            lastUpdatedTimestamp = mostRecentUpdate;
        }
        
        if (lastUpdatedTimestamp) {
            updateLastUpdatedDisplay();
        }
        
        // Re-render to show cached data
        renderDevices();
    } catch (error) {
        console.error('Failed to load cached status:', error);
    }
}

// Render devices grouped by group
function renderDevices() {
    const container = document.getElementById('groupsContainer');
    const emptyState = document.getElementById('emptyState');
    const filter = document.getElementById('filterInput').value.toLowerCase();
    
    // Filter devices
    const filteredDevices = devices.filter(device => 
        device.name.toLowerCase().includes(filter) || 
        device.host.toLowerCase().includes(filter)
    );
    
    if (filteredDevices.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        updateStats();
        return;
    }
    
    emptyState.style.display = 'none';
    
    // Group devices
    const grouped = {};
    const ungrouped = [];
    
    filteredDevices.forEach(device => {
        if (device.groupId) {
            if (!grouped[device.groupId]) {
                grouped[device.groupId] = [];
            }
            grouped[device.groupId].push(device);
        } else {
            ungrouped.push(device);
        }
    });
    
    // Render groups
    let html = '';
    
    // Render ungrouped devices first if any
    if (ungrouped.length > 0) {
        html += renderGroup(null, 'Ungrouped Devices', ungrouped);
    }
    
    // Render grouped devices
    groups.forEach(group => {
        if (grouped[group.id] && grouped[group.id].length > 0) {
            html += renderGroup(group.id, group.name, grouped[group.id]);
        }
    });
    
    container.innerHTML = html;
    updateStats();
}

// Render a single group
function renderGroup(groupId, groupName, devicesInGroup) {
    const groupKey = groupId !== null ? groupId.toString() : 'ungrouped';
    const isCollapsed = collapsedGroups.has(groupKey);
    
    // Sort devices numerically by name
    const sortedDevices = [...devicesInGroup].sort((a, b) => {
        // Extract leading number from device names for proper numerical sorting
        // Supports formats like: "1-1406-22", "10-1904-42", "ONU-5", etc.
        const numA = a.name.match(/^(\d+)/);
        const numB = b.name.match(/^(\d+)/);
        
        if (numA && numB) {
            const firstNumA = parseInt(numA[1]);
            const firstNumB = parseInt(numB[1]);
            
            // If leading numbers are different, sort by them
            if (firstNumA !== firstNumB) {
                return firstNumA - firstNumB;
            }
        }
        
        // Fallback to natural string sorting for same leading number or no match
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    
    // Calculate group stats
    const onlineCount = sortedDevices.filter(d => deviceStatuses[d.id] === 'online').length;
    const offlineCount = sortedDevices.filter(d => deviceStatuses[d.id] === 'offline').length;
    const warningCount = sortedDevices.filter(d => deviceStatuses[d.id] === 'error').length;
    
    return `
        <div class="device-group">
            <div class="group-header" onclick="toggleGroup('${groupKey}')">
                <i class="bi bi-chevron-down group-toggle ${isCollapsed ? 'collapsed' : ''}"></i>
                <i class="bi bi-folder group-icon"></i>
                <span class="group-name">${escapeHtml(groupName)} (${sortedDevices.length})</span>
                <div class="group-stats">
                    <div class="group-stat">
                        <span class="stat-dot ok"></span>
                        <span>${onlineCount}</span>
                    </div>
                    <div class="group-stat">
                        <span class="stat-dot down"></span>
                        <span>${offlineCount}</span>
                    </div>
                    <div class="group-stat">
                        <span class="stat-dot warning"></span>
                        <span>${warningCount}</span>
                    </div>
                </div>
            </div>
            <div class="group-body ${isCollapsed ? 'collapsed' : ''}" id="group-body-${groupKey}">
                ${sortedDevices.map(device => renderDeviceCard(device)).join('')}
            </div>
        </div>
    `;
}

// Toggle group collapse
function toggleGroup(groupKey) {
    if (collapsedGroups.has(groupKey)) {
        collapsedGroups.delete(groupKey);
    } else {
        collapsedGroups.add(groupKey);
    }
    renderDevices();
}

// Render a single device card
function renderDeviceCard(device) {
    const status = deviceStatuses[device.id] || 'checking';
    const data = monitoringData[device.id];
    
    // Determine card background class based on status
    let cardClass = 'device-card';
    if (status === 'online') {
        cardClass += ' device-card-online';
    } else if (status === 'offline') {
        cardClass += ' device-card-offline';
    } else if (status === 'error') {
        cardClass += ' device-card-warning';
    } else {
        cardClass += ' device-card-checking';
    }
    
    const iconClass = status === 'online' ? 'status-ok bi-check-circle-fill' : 
                     status === 'offline' ? 'status-error bi-x-circle-fill' : 
                     status === 'error' ? 'status-warning bi-exclamation-triangle-fill' : 
                     'bi-hourglass-split status-checking';
    
    return `
        <div class="${cardClass}" id="card-${device.id}">
            <div class="device-card-header">
                <i class="device-status-icon ${iconClass}"></i>
                <span class="device-card-name" title="${escapeHtml(device.name)}">${escapeHtml(device.name)}</span>
                <div class="device-card-actions">
                    <button class="btn btn-primary btn-mini" onclick="refreshDevice(${device.id}, true)" title="Refresh">
                        <i class="bi bi-arrow-clockwise"></i>
                    </button>
                    <button class="btn btn-warning btn-mini" onclick="editDevice(${device.id})" title="Edit">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-danger btn-mini" onclick="deleteDevice(${device.id})" title="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
            <div class="device-card-body" id="badges-${device.id}">
                ${renderSensorBadges(device, status, data)}
            </div>
            <div class="device-card-footer">
                ${escapeHtml(device.host)}
            </div>
        </div>
    `;
}

// Render PRTG-style sensor badges
function renderSensorBadges(device, status, data) {
  let badges = '';
  
  if (status === 'checking') {
    badges = '<span class="sensor-badge badge-blue"><i class="spinner-mini"></i> Checking</span>';
  } else if (status === 'offline') {
    badges = '<span class="sensor-badge badge-gray"><i class="bi bi-x-circle"></i> Offline</span>';
  } else if (status === 'error') {
    badges = '<span class="sensor-badge badge-red"><i class="bi bi-exclamation-triangle"></i> Error</span>';
  } else if (status === 'online' && data) {
    // Check if this is a MikroTik device
    if (device.device_type === 'mikrotik_lhg60g') {
      // RSSI badge - only show if enabled
      if (data.rssi !== undefined && device.showRssi) {
        const rssiClass = getRSSIBadgeClass(data.rssi);
        badges += `<span class="sensor-badge ${rssiClass}"><i class="bi bi-reception-4"></i> RSSI: ${data.rssi} dBm</span>`;
      }
      
      // Port Speed badge - only show if enabled
      if (data.portSpeed !== undefined && device.showMikrotikPortSpeed) {
        const speedClass = getMikrotikPortSpeedBadgeClass(data.portSpeed);
        let formattedSpeed;
        if (data.portSpeed >= 1000) {
          formattedSpeed = `${(data.portSpeed / 1000).toFixed(1)}G`;
        } else {
          formattedSpeed = `${data.portSpeed}M`;
        }
        badges += `<span class="sensor-badge ${speedClass}"><i class="bi bi-diagram-3"></i> ${formattedSpeed}</span>`;
      }
    } else {
      // ONU device badges
      // Temperature badge - only show if enabled in device preferences
      if (data.temperature && device.showTemperature) {
        const tempClass = getTemperatureBadgeClass(data.temperature);
        const tempValue = extractValue(data.temperature);
        badges += `<span class="sensor-badge ${tempClass}"><i class="bi bi-thermometer-half"></i> ${tempValue}°C</span>`;
      }
      
      // RX Power badge - always shown as it's the primary metric
      if (data.currentValue) {
        const powerClass = getPowerBadgeClass(data.currentValue);
        const powerValue = extractValue(data.currentValue);
        badges += `<span class="sensor-badge ${powerClass}"><i class="bi bi-reception-4"></i> RX ${powerValue}</span>`;
      }
      
      // TX Power badge - only show if enabled in device preferences
      if (data.txPower && device.showTXPower) {
        const txValue = extractValue(data.txPower);
        badges += `<span class="sensor-badge badge-yellow"><i class="bi bi-broadcast"></i> TX ${txValue}</span>`;
      }
      
      // UI Type badge - only show if enabled in device preferences
      if (data.uiType && device.showUIType) {
        badges += `<span class="sensor-badge badge-gray">${data.uiType === 'blue' ? 'Blue' : 'Red'}</span>`;
      }
      
      // Port speeds badges - only show if enabled in device preferences
      if (device.showPortSpeeds && data.portSpeeds && device.portSelections && device.portSelections.length > 0) {
        device.portSelections.forEach(port => {
          const speed = data.portSpeeds[`eth${port}-speed`];
          if (speed !== undefined) {
            let badgeClass = 'badge-blue';
            let formattedSpeed;
            
            // Handle disconnected ports (speed = 0)
            if (speed === 0) {
              formattedSpeed = '--';
              badgeClass = 'port-speed-down'; // Red color for disconnected ports
            } else {
              // Format port speed: 1000 -> 1G, 100 -> 100M, 10 -> 10M
              if (speed === 1000) {
                formattedSpeed = '1G';
                badgeClass = 'port-speed-1g'; // Green color for 1Gbps
              } else if (speed === 100) {
                formattedSpeed = `${speed}M`;
                badgeClass = 'port-speed-100m'; // Blue color for 100Mbps
              } else if (speed === 10) {
                formattedSpeed = `${speed}M`;
                badgeClass = 'port-speed-10m'; // Yellow color for 10Mbps
              } else {
                formattedSpeed = `${speed}M`;
              }
            }
            
            badges += `<span class="sensor-badge ${badgeClass}"><i class="bi bi-diagram-3"></i> ETH${port}: ${formattedSpeed}</span>`;
          }
        });
      }
    }
  } else {
    badges = '<span class="sensor-badge badge-gray"><i class="bi bi-question-circle"></i> Unknown</span>';
  }
  
  return badges;
}

// Extract numeric value from string
function extractValue(str) {
    if (!str) return '';
    const match = str.match(/(-?[\d.]+)/);
    return match ? match[1] : str;
}

// Get temperature badge class
function getTemperatureBadgeClass(tempStr) {
    const match = tempStr.match(/([\d.]+)/);
    if (!match) return 'badge-yellow';
    
    const temp = parseFloat(match[1]);
    if (temp > 85) return 'badge-red';
    if (temp > 70) return 'badge-yellow';
    if (temp < -10) return 'badge-red';
    if (temp < 0) return 'badge-yellow';
    return 'badge-green';
}

// Get power badge class
function getPowerBadgeClass(powerStr) {
    // Check for no signal (-- dBm)
    if (powerStr.includes('--')) {
        return 'badge-red';
    }
    
    const match = powerStr.match(/-?([\d.]+)/);
    if (!match) return 'badge-yellow';
    
    const power = parseFloat(match[1]);
    if (powerStr.startsWith('-')) {
        if (power > 27) return 'badge-red';
        if (power > 25) return 'badge-yellow';
        if (power >= 8) return 'badge-green';
        return 'badge-yellow';
    }
    return 'badge-yellow';
}

// Get RSSI badge class for MikroTik devices
function getRSSIBadgeClass(rssi) {
    if (rssi >= -60) return 'badge-green';  // Excellent signal
    if (rssi >= -70) return 'badge-yellow'; // Good signal
    if (rssi >= -80) return 'badge-red';    // Weak signal
    return 'badge-red';                      // Very weak signal
}

// Get port speed badge class for MikroTik devices
function getMikrotikPortSpeedBadgeClass(speed) {
    if (speed >= 1000) return 'port-speed-1g';   // Green for 1Gbps+
    if (speed >= 100) return 'port-speed-100m';  // Blue for 100Mbps
    if (speed >= 10) return 'port-speed-10m';    // Yellow for 10Mbps
    return 'port-speed-down';                    // Red for down/unknown
}

// Update a single device card
function updateDeviceCard(deviceId, status, data) {
    deviceStatuses[deviceId] = status;
    if (data) {
        monitoringData[deviceId] = data;
    }
    
    const card = document.getElementById(`card-${deviceId}`);
    if (card) {
        // Update card background class based on status
        card.className = 'device-card';
        if (status === 'online') {
            card.className += ' device-card-online';
        } else if (status === 'offline') {
            card.className += ' device-card-offline';
        } else if (status === 'error') {
            card.className += ' device-card-warning';
        } else {
            card.className += ' device-card-checking';
        }
        
        // Update icon
        const icon = card.querySelector('.device-status-icon');
        if (icon) {
            icon.className = 'device-status-icon ';
            if (status === 'online') {
                icon.className += 'status-ok bi-check-circle-fill';
            } else if (status === 'offline') {
                icon.className += 'status-error bi-x-circle-fill';
            } else if (status === 'error') {
                icon.className += 'status-warning bi-exclamation-triangle-fill';
            } else {
                icon.className += 'bi-hourglass-split status-checking';
            }
        }
        
        // Update badges
        const badgesContainer = document.getElementById(`badges-${deviceId}`);
        if (badgesContainer) {
            // Find the device object to pass to renderSensorBadges
            const device = devices.find(d => d.id === deviceId);
            if (device) {
                badgesContainer.innerHTML = renderSensorBadges(device, status, data);
            }
        }
    }
    
    // Re-render to update group stats
    renderDevices();
}

// Update statistics
function updateStats() {
    const online = Object.values(deviceStatuses).filter(s => s === 'online').length;
    const offline = Object.values(deviceStatuses).filter(s => s === 'offline').length;
    const warning = Object.values(deviceStatuses).filter(s => s === 'error').length;
    
    document.getElementById('onlineCount').textContent = online;
    document.getElementById('offlineCount').textContent = offline;
    document.getElementById('warningCount').textContent = warning;
    document.getElementById('totalCount').textContent = devices.length;
}

// Update "Last Updated" display
function updateLastUpdatedDisplay() {
    const element = document.getElementById('lastUpdated');
    if (!lastUpdatedTimestamp) {
        element.textContent = '--';
        return;
    }
    
    const now = new Date();
    const diff = Math.floor((now - lastUpdatedTimestamp) / 1000); // seconds
    
    let displayText;
    if (diff < 60) {
        displayText = `${diff}s ago`;
    } else if (diff < 3600) {
        const minutes = Math.floor(diff / 60);
        displayText = `${minutes}m ago`;
    } else if (diff < 86400) {
        const hours = Math.floor(diff / 3600);
        displayText = `${hours}h ago`;
    } else {
        const days = Math.floor(diff / 86400);
        displayText = `${days}d ago`;
    }
    
    element.textContent = `Last: ${displayText}`;
    element.title = lastUpdatedTimestamp.toLocaleString();
}

// Update the "Last Updated" display every 10 seconds
setInterval(() => {
    updateLastUpdatedDisplay();
}, 10000);

// Check for new background monitoring updates every 30 seconds
setInterval(async () => {
    try {
        const response = await fetch('/api/devices/cached-status');
        const cachedData = await response.json();
        
        let mostRecentUpdate = null;
        let hasNewData = false;
        
        // Check for most recent update in cached data
        for (const [deviceId, cache] of Object.entries(cachedData)) {
            if (cache.lastUpdated) {
                const updateTime = new Date(cache.lastUpdated);
                if (!mostRecentUpdate || updateTime > mostRecentUpdate) {
                    mostRecentUpdate = updateTime;
                }
            }
        }
        
        // If we found a more recent background update, refresh the UI
        if (mostRecentUpdate && (!lastUpdatedTimestamp || mostRecentUpdate > lastUpdatedTimestamp)) {
            hasNewData = true;
            lastUpdatedTimestamp = mostRecentUpdate;
            
            // Update device statuses and data
            for (const [deviceId, cache] of Object.entries(cachedData)) {
                const id = parseInt(deviceId);
                deviceStatuses[id] = cache.status;
                if (cache.data) {
                    monitoringData[id] = cache.data;
                }
            }
            
            // Clear manual refresh timestamp since background is newer
            localStorage.removeItem('lastManualRefresh');
            
            // Re-render to show updated data
            renderDevices();
            updateLastUpdatedDisplay();
        }
    } catch (error) {
        console.error('Failed to check for background updates:', error);
    }
}, 30000); // Check every 30 seconds

// Refresh all devices status (batch mode)
async function refreshAllStatus() {
    // Set all devices to checking state immediately
    for (const device of devices) {
        updateDeviceCard(device.id, 'checking', null);
    }
    
    try {
        // Fetch all devices data in a single batch request
        const response = await fetch('/api/devices/monitor-all', {
            method: 'POST'
        });
        
        if (!response.ok) {
            throw new Error('Batch monitoring request failed');
        }
        
        const results = await response.json();
        
        // Update all device cards with the results
        for (const [deviceIdStr, result] of Object.entries(results)) {
            const deviceId = parseInt(deviceIdStr);
            
            if (result.success) {
                updateDeviceCard(deviceId, 'online', result.data);
            } else {
                // Check if it's a connectivity issue or other error
                if (result.error && result.error.includes('offline')) {
                    updateDeviceCard(deviceId, 'offline', null);
                } else {
                    updateDeviceCard(deviceId, 'error', null);
                }
            }
        }
    } catch (error) {
        console.error('Batch refresh failed:', error);
        // Set all cards to error state if batch request fails
        for (const device of devices) {
            updateDeviceCard(device.id, 'error', null);
        }
    }
    
    // Update timestamp after all devices are refreshed
    lastUpdatedTimestamp = new Date();
    localStorage.setItem('lastManualRefresh', lastUpdatedTimestamp.toISOString());
    updateLastUpdatedDisplay();
}

// Refresh single device
async function refreshDevice(deviceId, showMessage = true) {
    updateDeviceCard(deviceId, 'checking', null);
    
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        if (showMessage) showToast('Device not found', 'danger');
        return;
    }
    
    try {
        // Route to appropriate API based on device type
        if (device.device_type === 'mikrotik_lhg60g') {
            // MikroTik device monitoring
            const response = await fetch(`/api/mikrotik/devices/${deviceId}/monitor`, {
                method: 'POST'
            });
            const result = await response.json();
            
            if (result.success) {
                updateDeviceCard(deviceId, 'online', result.data);
                
                if (showMessage) {
                    lastUpdatedTimestamp = new Date();
                    localStorage.setItem('lastManualRefresh', lastUpdatedTimestamp.toISOString());
                    updateLastUpdatedDisplay();
                    showToast('MikroTik device refreshed successfully', 'success');
                }
            } else {
                updateDeviceCard(deviceId, result.error && result.error.includes('offline') ? 'offline' : 'error', null);
                if (showMessage) {
                    showToast(result.error || 'Failed to get device data', 'danger');
                }
            }
        } else {
            // ONU device monitoring
            // Check connectivity first
            const checkResponse = await fetch(`/api/devices/${deviceId}/check`, {
                method: 'POST'
            });
            const checkData = await checkResponse.json();
            
            if (!checkData.online) {
                updateDeviceCard(deviceId, 'offline', null);
                if (showMessage) {
                    showToast('Device is offline', 'warning');
                }
                return;
            }
            
            // Get monitoring data
            const response = await fetch(`/api/devices/${deviceId}/monitor`, {
                method: 'POST'
            });
            const result = await response.json();
            
            if (result.success) {
                updateDeviceCard(deviceId, 'online', result.data);
                
                if (showMessage) {
                    lastUpdatedTimestamp = new Date();
                    localStorage.setItem('lastManualRefresh', lastUpdatedTimestamp.toISOString());
                    updateLastUpdatedDisplay();
                    showToast('Device refreshed successfully', 'success');
                }
            } else {
                updateDeviceCard(deviceId, 'error', null);
                if (showMessage) {
                    showToast(result.error || 'Failed to get device data', 'danger');
                }
            }
        }
    } catch (error) {
        updateDeviceCard(deviceId, 'error', null);
        if (showMessage) {
            showToast('Failed to connect to device', 'danger');
        }
    }
}

// Refresh all
async function refreshAll() {
    showToast('Refreshing all devices...', 'info');
    
    await refreshAllStatus();
    
    showToast('All devices refreshed', 'success');
}

// Edit device
function editDevice(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        showToast('Device not found', 'danger');
        return;
    }
    
    document.getElementById('deviceModalTitle').textContent = 'Edit Device';
    document.getElementById('deviceId').value = device.id;
    document.getElementById('deviceName').value = device.name || '';
    
    // Determine device type
    const deviceType = device.device_type || device.onuType || 'blue';
    document.getElementById('deviceType').value = deviceType;
    
    // Toggle fields based on device type
    toggleDeviceTypeFields();
    
    if (deviceType === 'mikrotik_lhg60g') {
        // MikroTik-specific fields
        document.getElementById('deviceHost').value = device.host || '';
        document.getElementById('deviceUsername').value = device.username || '';
        document.getElementById('mikrotikLhg60gIP').value = device.mikrotik_lhg60g_ip || '';
        document.getElementById('mikrotikSshPort').value = device.mikrotik_ssh_port || '';
        document.getElementById('mikrotikSshUsername').value = device.mikrotik_ssh_username || '';
        document.getElementById('mikrotikSshPassword').value = '';
        document.getElementById('mikrotikTunnelIP').value = device.mikrotik_tunnel_ip || '';
        
        // MikroTik notification settings
        document.getElementById('notifyRssi').checked = device.notify_rssi === true;
        document.getElementById('rssiThreshold').value = device.rssi_threshold !== undefined ? device.rssi_threshold : -66;
        document.getElementById('notifyMikrotikPortSpeed').checked = device.notify_port_speed === true;
        document.getElementById('portSpeedThreshold').value = device.port_speed_threshold !== undefined ? device.port_speed_threshold : 1000;
        document.getElementById('notifyMikrotikOffline').checked = device.notifyOffline === true;
        
        // MikroTik display preferences
        document.getElementById('showRssi').checked = device.show_rssi === true;
        document.getElementById('showMikrotikPortSpeed').checked = device.show_port_speed === true;
    } else {
        // ONU fields
        document.getElementById('deviceHost').value = device.host || '';
        document.getElementById('deviceUsername').value = device.username || '';
        document.getElementById('devicePassword').value = '';
        document.getElementById('devicePassword').required = false;
        
        // ONU notification settings
        document.getElementById('notifyRxPower').checked = device.notifyRxPower === true;
        document.getElementById('rxPowerThreshold').value = device.rxPowerThreshold !== undefined ? device.rxPowerThreshold : -27;
        document.getElementById('notifyTempHigh').checked = device.notifyTempHigh === true;
        document.getElementById('tempHighThreshold').value = device.tempHighThreshold !== undefined ? device.tempHighThreshold : 70;
        document.getElementById('notifyTempLow').checked = device.notifyTempLow === true;
        document.getElementById('tempLowThreshold').value = device.tempLowThreshold !== undefined ? device.tempLowThreshold : 0;
        document.getElementById('notifyOffline').checked = device.notifyOffline === true;
        
        // Ethernet Port Monitoring settings
        document.getElementById('notifyPortDown').checked = device.notifyPortDown === true;
        
        // Port monitoring configuration
        const portMonitoringConfig = device.portMonitoringConfig || {};
        document.getElementById('port1Speed').value = portMonitoringConfig['1']?.speed || '';
        document.getElementById('port1NotifyDown').checked = portMonitoringConfig['1']?.notifyDown || false;
        document.getElementById('port2Speed').value = portMonitoringConfig['2']?.speed || '';
        document.getElementById('port2NotifyDown').checked = portMonitoringConfig['2']?.notifyDown || false;
        document.getElementById('port3Speed').value = portMonitoringConfig['3']?.speed || '';
        document.getElementById('port3NotifyDown').checked = portMonitoringConfig['3']?.notifyDown || false;
        document.getElementById('port4Speed').value = portMonitoringConfig['4']?.speed || '';
        document.getElementById('port4NotifyDown').checked = portMonitoringConfig['4']?.notifyDown || false;
        
        // ONU display preferences
        document.getElementById('showTemperature').checked = device.showTemperature === true;
        document.getElementById('showUIType').checked = device.showUIType === true;
        document.getElementById('showTXPower').checked = device.showTXPower === true;
        
        // Port speed preferences
        const showPortSpeeds = device.showPortSpeeds === true;
        document.getElementById('showPortSpeeds').checked = showPortSpeeds;
        document.getElementById('portSpeedsConfig').style.display = showPortSpeeds ? 'block' : 'none';
        
        const portSelections = device.portSelections || [];
        document.getElementById('showPort1').checked = portSelections.includes('1');
        document.getElementById('showPort2').checked = portSelections.includes('2');
        document.getElementById('showPort3').checked = portSelections.includes('3');
        document.getElementById('showPort4').checked = portSelections.includes('4');
    }
    
    document.getElementById('deviceGroup').value = device.groupId || '';
    
    // Monitoring settings (common to both types)
    document.getElementById('monitoringInterval').value = device.monitoringInterval !== undefined ? device.monitoringInterval : 900;
    document.getElementById('retryAttempts').value = device.retryAttempts !== undefined ? device.retryAttempts : 3;
    document.getElementById('retryDelay').value = device.retryDelay !== undefined ? device.retryDelay : 3;
    
    const modal = new bootstrap.Modal(document.getElementById('addDeviceModal'));
    modal.show();
}

// Reset device form
function resetDeviceForm() {
    document.getElementById('deviceModalTitle').textContent = 'Add Device';
    document.getElementById('deviceForm').reset();
    document.getElementById('deviceId').value = '';
    document.getElementById('devicePassword').required = true;
    document.getElementById('deviceGroup').value = '';
    document.getElementById('deviceType').value = 'blue';
    
    // Toggle fields to show ONU by default
    toggleDeviceTypeFields();
    
    // Reset to defaults
    document.getElementById('monitoringInterval').value = 900;
    document.getElementById('retryAttempts').value = 3;
    document.getElementById('retryDelay').value = 3;
    document.getElementById('rxPowerThreshold').value = -27;
    document.getElementById('tempHighThreshold').value = 70;
    document.getElementById('tempLowThreshold').value = 0;
    document.getElementById('rssiThreshold').value = -66;
    document.getElementById('portSpeedThreshold').value = 1000;
    
    // Reset notification settings to default (unchecked)
    document.getElementById('notifyRxPower').checked = false;
    document.getElementById('notifyTempHigh').checked = false;
    document.getElementById('notifyTempLow').checked = false;
    document.getElementById('notifyOffline').checked = false;
    document.getElementById('notifyPortDown').checked = false;
    document.getElementById('notifyRssi').checked = false;
    document.getElementById('notifyMikrotikPortSpeed').checked = false;
    document.getElementById('notifyMikrotikOffline').checked = false;
    
    // Reset port monitoring configuration
    document.getElementById('port1Speed').value = '';
    document.getElementById('port1NotifyDown').checked = false;
    document.getElementById('port2Speed').value = '';
    document.getElementById('port2NotifyDown').checked = false;
    document.getElementById('port3Speed').value = '';
    document.getElementById('port3NotifyDown').checked = false;
    document.getElementById('port4Speed').value = '';
    document.getElementById('port4NotifyDown').checked = false;
    
    // Reset display preferences to default (unchecked)
    document.getElementById('showTemperature').checked = false;
    document.getElementById('showUIType').checked = false;
    document.getElementById('showTXPower').checked = false;
    document.getElementById('showPortSpeeds').checked = false;
    document.getElementById('portSpeedsConfig').style.display = 'none';
    document.getElementById('showPort1').checked = false;
    document.getElementById('showPort2').checked = false;
    document.getElementById('showPort3').checked = false;
    document.getElementById('showPort4').checked = false;
    document.getElementById('showRssi').checked = false;
    document.getElementById('showMikrotikPortSpeed').checked = false;
}

// Save device
async function saveDevice() {
    const deviceId = document.getElementById('deviceId').value;
    const deviceType = document.getElementById('deviceType').value;
    const name = document.getElementById('deviceName').value;
    const groupId = document.getElementById('deviceGroup').value || null;
    
    if (deviceType === 'mikrotik_lhg60g') {
        // Save MikroTik device
        await saveMikroTikDevice(deviceId, name, groupId);
    } else {
        // Save ONU device
        await saveONUDevice(deviceId, name, groupId, deviceType);
    }
}

// Save MikroTik device
async function saveMikroTikDevice(deviceId, name, groupId) {
    const lhg60gIP = document.getElementById('mikrotikLhg60gIP').value;
    const sshPort = parseInt(document.getElementById('mikrotikSshPort').value);
    const sshUsername = document.getElementById('mikrotikSshUsername').value;
    const sshPassword = document.getElementById('mikrotikSshPassword').value;
    const tunnelIP = document.getElementById('mikrotikTunnelIP').value;
    
    if (!lhg60gIP || !sshPort || !sshUsername || !tunnelIP) {
        showToast('Please fill all MikroTik required fields', 'danger');
        return;
    }
    
    if (!deviceId && !sshPassword) {
        showToast('SSH Password is required for new devices', 'danger');
        return;
    }
    
    // Collect configuration
    const config = {
        monitoringInterval: parseInt(document.getElementById('monitoringInterval').value),
        retryAttempts: parseInt(document.getElementById('retryAttempts').value),
        retryDelay: parseInt(document.getElementById('retryDelay').value),
        notifyOffline: document.getElementById('notifyMikrotikOffline').checked
    };
    
    const data = {
        name,
        lhg60gIP,
        sshPort,
        sshUsername,
        tunnelIP,
        groupId,
        config,
        notifyRssi: document.getElementById('notifyRssi').checked,
        rssiThreshold: parseInt(document.getElementById('rssiThreshold').value),
        notifyPortSpeed: document.getElementById('notifyMikrotikPortSpeed').checked,
        portSpeedThreshold: parseInt(document.getElementById('portSpeedThreshold').value),
        showRssi: document.getElementById('showRssi').checked,
        showPortSpeed: document.getElementById('showMikrotikPortSpeed').checked
    };
    
    if (sshPassword) {
        data.sshPassword = sshPassword;
    }
    
    try {
        let response;
        if (deviceId) {
            // Update
            response = await fetch(`/api/mikrotik/devices/${deviceId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } else {
            // Create
            response = await fetch('/api/mikrotik/devices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        }
        
        if (response.ok) {
            const result = await response.json();
            const modal = bootstrap.Modal.getInstance(document.getElementById('addDeviceModal'));
            modal.hide();
            resetDeviceForm();
            
            let message = deviceId ? 'MikroTik device updated successfully' : 'MikroTik device added successfully';
            if (result.provisioning) {
                message += `. Provisioning: ${result.provisioning.message || 'completed'}`;
            }
            showToast(message, 'success');
            await loadDevices();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save MikroTik device', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Save ONU device
async function saveONUDevice(deviceId, name, groupId, onuType) {
    const host = document.getElementById('deviceHost').value;
    const username = document.getElementById('deviceUsername').value;
    const password = document.getElementById('devicePassword').value;
    
    // Collect port monitoring configuration
    const portMonitoringConfig = {
        '1': {
            speed: document.getElementById('port1Speed').value,
            notifyDown: document.getElementById('port1NotifyDown').checked
        },
        '2': {
            speed: document.getElementById('port2Speed').value,
            notifyDown: document.getElementById('port2NotifyDown').checked
        },
        '3': {
            speed: document.getElementById('port3Speed').value,
            notifyDown: document.getElementById('port3NotifyDown').checked
        },
        '4': {
            speed: document.getElementById('port4Speed').value,
            notifyDown: document.getElementById('port4NotifyDown').checked
        }
    };
    
    // Collect configuration
    const config = {
        monitoringInterval: parseInt(document.getElementById('monitoringInterval').value),
        retryAttempts: parseInt(document.getElementById('retryAttempts').value),
        retryDelay: parseInt(document.getElementById('retryDelay').value),
        notifyRxPower: document.getElementById('notifyRxPower').checked,
        rxPowerThreshold: parseFloat(document.getElementById('rxPowerThreshold').value),
        notifyTempHigh: document.getElementById('notifyTempHigh').checked,
        tempHighThreshold: parseFloat(document.getElementById('tempHighThreshold').value),
        notifyTempLow: document.getElementById('notifyTempLow').checked,
        tempLowThreshold: parseFloat(document.getElementById('tempLowThreshold').value),
        notifyOffline: document.getElementById('notifyOffline').checked,
        notifyPortDown: document.getElementById('notifyPortDown').checked,
        portMonitoringConfig: portMonitoringConfig,
        // Display preferences
        showTemperature: document.getElementById('showTemperature').checked,
        showUIType: document.getElementById('showUIType').checked,
        showTXPower: document.getElementById('showTXPower').checked,
        showPortSpeeds: document.getElementById('showPortSpeeds').checked,
        portSelections: [
            document.getElementById('showPort1').checked ? '1' : null,
            document.getElementById('showPort2').checked ? '2' : null,
            document.getElementById('showPort3').checked ? '3' : null,
            document.getElementById('showPort4').checked ? '4' : null
        ].filter(port => port !== null)
    };
    
    const data = { name, host, username, onuType, groupId, config };
    if (password) {
        data.password = password;
    }
    
    try {
        let response;
        if (deviceId) {
            // Update
            response = await fetch(`/api/devices/${deviceId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } else {
            // Create
            if (!password) {
                showToast('Password is required', 'danger');
                return;
            }
            data.password = password;
            response = await fetch('/api/devices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        }
        
        if (response.ok) {
            const modal = bootstrap.Modal.getInstance(document.getElementById('addDeviceModal'));
            modal.hide();
            resetDeviceForm();
            showToast(deviceId ? 'Device updated successfully' : 'Device added successfully', 'success');
            await loadDevices();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save device', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Delete device
async function deleteDevice(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        showToast('Device not found', 'danger');
        return;
    }
    
    if (!confirm('Are you sure you want to delete this device?')) {
        return;
    }
    
    try {
        let response;
        if (device.device_type === 'mikrotik_lhg60g') {
            // Delete MikroTik device (includes cleanup)
            response = await fetch(`/api/mikrotik/devices/${deviceId}`, {
                method: 'DELETE'
            });
        } else {
            // Delete ONU device
            response = await fetch(`/api/devices/${deviceId}`, {
                method: 'DELETE'
            });
        }
        
        if (response.ok) {
            const result = await response.json();
            let message = 'Device deleted successfully';
            if (result.cleanup) {
                message += `. Cleanup: ${result.cleanup.message || 'completed'}`;
            }
            showToast(message, 'success');
            await loadDevices();
        } else {
            showToast('Failed to delete device', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Change password
async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (newPassword !== confirmPassword) {
        showToast('Passwords do not match', 'danger');
        return;
    }
    
    if (newPassword.length < 6) {
        showToast('Password must be at least 6 characters', 'danger');
        return;
    }
    
    try {
        const response = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        
        if (response.ok) {
            const modal = bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'));
            modal.hide();
            document.getElementById('changePasswordForm').reset();
            showToast('Password changed successfully', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to change password', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Show toast notification
function showToast(message, type = 'info') {
    const toastHtml = `
        <div class="toast align-items-center text-white bg-${type} border-0" role="alert">
            <div class="d-flex">
                <div class="toast-body">
                    ${escapeHtml(message)}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>
        </div>
    `;
    
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    container.insertAdjacentHTML('beforeend', toastHtml);
    const toastElement = container.lastElementChild;
    const toast = new bootstrap.Toast(toastElement, { delay: 3000 });
    toast.show();
    
    toastElement.addEventListener('hidden.bs.toast', () => {
        toastElement.remove();
    });
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Load SMS config
async function loadSMSConfig() {
    try {
        const response = await fetch('/api/sms-config');
        if (response.ok) {
            const config = await response.json();
            document.getElementById('apiUrl').value = config.apiUrl || '';
            document.getElementById('phoneNumbers').value = config.phoneNumbers || '';
            document.getElementById('apiEnabled').checked = config.enabled !== false;
        }
    } catch (error) {
        console.error('Failed to load SMS config:', error);
    }
}

// Save SMS config
async function saveSMSConfig() {
    const apiUrl = document.getElementById('apiUrl').value.trim();
    const phoneNumbers = document.getElementById('phoneNumbers').value.trim();
    const enabled = document.getElementById('apiEnabled').checked;
    
    if (!apiUrl) {
        showToast('API URL is required', 'danger');
        return;
    }
    
    if (!apiUrl.includes('{phone}') || !apiUrl.includes('{message}')) {
        showToast('API URL must contain {phone} and {message} placeholders', 'danger');
        return;
    }
    
    if (!phoneNumbers && enabled) {
        showToast('Please enter at least one phone number', 'warning');
        return;
    }
    
    try {
        const response = await fetch('/api/sms-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiUrl, phoneNumbers, enabled })
        });
        
        if (response.ok) {
            const modal = bootstrap.Modal.getInstance(document.getElementById('apiConfigModal'));
            modal.hide();
            showToast('SMS API configuration saved successfully', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save configuration', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Toggle device type fields
function toggleDeviceTypeFields() {
    const deviceType = document.getElementById('deviceType').value;
    
    // Toggle field sections
    const mikrotikFields = document.getElementById('mikrotikFields');
    const onuNotifications = document.getElementById('onuNotifications');
    const mikrotikNotifications = document.getElementById('mikrotikNotifications');
    const onuPortMonitoring = document.getElementById('onuPortMonitoring');
    const onuDisplayPrefs = document.getElementById('onuDisplayPrefs');
    const mikrotikDisplayPrefs = document.getElementById('mikrotikDisplayPrefs');
    
    if (deviceType === 'mikrotik_lhg60g') {
        // Show MikroTik fields, hide ONU fields
        mikrotikFields.style.display = 'block';
        onuNotifications.style.display = 'none';
        mikrotikNotifications.style.display = 'block';
        onuPortMonitoring.style.display = 'none';
        onuDisplayPrefs.style.display = 'none';
        mikrotikDisplayPrefs.style.display = 'block';
        
        // Hide ONU-specific basic fields
        document.getElementById('deviceHost').parentElement.style.display = 'none';
        document.getElementById('deviceUsername').parentElement.style.display = 'none';
        document.getElementById('devicePassword').parentElement.style.display = 'none';
    } else {
        // Show ONU fields, hide MikroTik fields
        mikrotikFields.style.display = 'none';
        onuNotifications.style.display = 'block';
        mikrotikNotifications.style.display = 'none';
        onuPortMonitoring.style.display = 'block';
        onuDisplayPrefs.style.display = 'block';
        mikrotikDisplayPrefs.style.display = 'none';
        
        // Show ONU-specific basic fields
        document.getElementById('deviceHost').parentElement.style.display = 'block';
        document.getElementById('deviceUsername').parentElement.style.display = 'block';
        document.getElementById('devicePassword').parentElement.style.display = 'block';
    }
}

// Load MikroTik Control Router configuration
async function loadMikroTikControlConfig() {
    try {
        const response = await fetch('/api/mikrotik/control-config');
        if (response.ok) {
            const config = await response.json();
            document.getElementById('controlRouterIP').value = config.controlIp || '';
            document.getElementById('controlRouterUsername').value = config.username || '';
            document.getElementById('wireguardInterface').value = config.wireguardInterface || '';
            document.getElementById('lhg60gInterface').value = config.lhg60gInterface || '';
            document.getElementById('basePort').value = config.basePort || '';
            // Don't populate password for security
            document.getElementById('controlRouterPassword').value = '';
        }
    } catch (error) {
        console.error('Failed to load MikroTik control config:', error);
    }
}

// Save MikroTik Control Router configuration
async function saveMikroTikControlConfig() {
    const controlIp = document.getElementById('controlRouterIP').value.trim();
    const username = document.getElementById('controlRouterUsername').value.trim();
    const password = document.getElementById('controlRouterPassword').value;
    const wireguardInterface = document.getElementById('wireguardInterface').value.trim();
    const lhg60gInterface = document.getElementById('lhg60gInterface').value.trim();
    const basePort = parseInt(document.getElementById('basePort').value);
    
    if (!controlIp || !username || !wireguardInterface || !lhg60gInterface || !basePort) {
        showToast('Please fill all required fields', 'danger');
        return;
    }
    
    const data = {
        controlIp,
        username,
        wireguardInterface,
        lhg60gInterface,
        basePort
    };
    
    if (password) {
        data.password = password;
    }
    
    try {
        const response = await fetch('/api/mikrotik/control-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            const modal = bootstrap.Modal.getInstance(document.getElementById('mikrotikControlModal'));
            modal.hide();
            showToast('MikroTik control router configuration saved successfully', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save configuration', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

// Test MikroTik Control Router connection
async function testControlRouterConnection() {
    const controlIp = document.getElementById('controlRouterIP').value.trim();
    const username = document.getElementById('controlRouterUsername').value.trim();
    const password = document.getElementById('controlRouterPassword').value;
    
    if (!controlIp || !username) {
        showToast('Please enter control router IP and username', 'warning');
        return;
    }
    
    // If password is empty and config exists, we need password from user
    if (!password) {
        showToast('Password is required to test connection', 'warning');
        return;
    }
    
    showToast('Testing connection...', 'info');
    
    try {
        const response = await fetch('/api/mikrotik/control-config/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ controlIp, username, password })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showToast('Connection successful!', 'success');
        } else {
            showToast(result.error || 'Connection failed', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}