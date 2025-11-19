// Dashboard JavaScript - Grouped PRTG-style Layout
let devices = [];
let groups = [];
let monitoringData = {};
let deviceStatuses = {};
let collapsedGroups = new Set();

// Check auth on load
window.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadGroups();
    await loadDevices();
    await loadSMSConfig();
    
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
        
        // Auto-refresh status for all devices
        await refreshAllStatus();
    } catch (error) {
        showToast('Failed to load devices', 'danger');
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
        // Extract numbers from device names for proper numerical sorting
        const numA = a.name.match(/ONU-(\d+)/);
        const numB = b.name.match(/ONU-(\d+)/);
        
        if (numA && numB) {
            return parseInt(numA[1]) - parseInt(numB[1]);
        }
        
        // Fallback to alphabetical sorting if pattern doesn't match
        return a.name.localeCompare(b.name);
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
          // Format port speed: 1000 -> 1G, 100 -> 100M, 10 -> 10M
          let formattedSpeed;
          if (speed === 1000) {
            formattedSpeed = '1G';
          } else {
            formattedSpeed = `${speed}M`;
          }
          badges += `<span class="sensor-badge badge-blue"><i class="bi bi-diagram-3"></i> ETH${port}: ${formattedSpeed}</span>`;
        }
      });
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

// Refresh all devices status
async function refreshAllStatus() {
    for (const device of devices) {
        await refreshDevice(device.id, false);
    }
}

// Refresh single device
async function refreshDevice(deviceId, showMessage = true) {
    updateDeviceCard(deviceId, 'checking', null);
    
    try {
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
                showToast('Device refreshed successfully', 'success');
            }
        } else {
            updateDeviceCard(deviceId, 'error', null);
            if (showMessage) {
                showToast(result.error || 'Failed to get device data', 'danger');
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
    document.getElementById('deviceHost').value = device.host || '';
    document.getElementById('deviceUsername').value = device.username || '';
    document.getElementById('devicePassword').value = '';
    document.getElementById('devicePassword').required = false;
    document.getElementById('deviceType').value = device.onuType || 'blue';
    document.getElementById('deviceGroup').value = device.groupId || '';
    
    // Monitoring settings
    document.getElementById('monitoringInterval').value = device.monitoringInterval !== undefined ? device.monitoringInterval : 900;
    document.getElementById('retryAttempts').value = device.retryAttempts !== undefined ? device.retryAttempts : 3;
    document.getElementById('retryDelay').value = device.retryDelay !== undefined ? device.retryDelay : 3;
    
    // Notification settings
    document.getElementById('notifyRxPower').checked = device.notifyRxPower === true;
    document.getElementById('rxPowerThreshold').value = device.rxPowerThreshold !== undefined ? device.rxPowerThreshold : -27;
    document.getElementById('notifyTempHigh').checked = device.notifyTempHigh === true;
    document.getElementById('tempHighThreshold').value = device.tempHighThreshold !== undefined ? device.tempHighThreshold : 70;
    document.getElementById('notifyTempLow').checked = device.notifyTempLow === true;
    document.getElementById('tempLowThreshold').value = device.tempLowThreshold !== undefined ? device.tempLowThreshold : 0;
    document.getElementById('notifyOffline').checked = device.notifyOffline === true;
    
    // Display preferences
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
    
    // Reset to defaults
    document.getElementById('monitoringInterval').value = 900;
    document.getElementById('retryAttempts').value = 3;
    document.getElementById('retryDelay').value = 3;
    document.getElementById('rxPowerThreshold').value = -27;
    document.getElementById('tempHighThreshold').value = 70;
    document.getElementById('tempLowThreshold').value = 0;
    
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
}

// Save device
async function saveDevice() {
    const deviceId = document.getElementById('deviceId').value;
    const name = document.getElementById('deviceName').value;
    const host = document.getElementById('deviceHost').value;
    const username = document.getElementById('deviceUsername').value;
    const password = document.getElementById('devicePassword').value;
    const onuType = document.getElementById('deviceType').value;
    const groupId = document.getElementById('deviceGroup').value || null;
    
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
    if (!confirm('Are you sure you want to delete this device?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/devices/${deviceId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showToast('Device deleted successfully', 'success');
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