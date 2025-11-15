// Dashboard JavaScript
let devices = [];
let monitoringData = {};

// Check auth on load
window.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadDevices();
    await loadSMSConfig();
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

// Render devices
function renderDevices() {
    const container = document.getElementById('devicesContainer');
    const emptyState = document.getElementById('emptyState');
    
    if (devices.length === 0) {
        container.innerHTML = '';
        emptyState.style.display = 'block';
        return;
    }
    
    emptyState.style.display = 'none';
    
    container.innerHTML = devices.map(device => `
        <div class="col-md-6 col-lg-4 col-xl-3 mb-3 fade-in">
            <div class="card device-card shadow-sm">
                <div class="device-header">
                    <div class="d-flex justify-content-between align-items-center">
                        <h5 class="mb-0">
                            <i class="bi bi-router me-1"></i>${escapeHtml(device.name)}
                        </h5>
                        <span class="status-badge status-checking" id="status-${device.id}">
                            <i class="bi bi-hourglass-split"></i> Checking
                        </span>
                    </div>
                    <small class="text-white-50">
                        <i class="bi bi-globe me-1"></i>${escapeHtml(device.host)}
                    </small>
                </div>
                <div class="card-body device-body">
                    <div id="data-${device.id}">
                        <div class="loading-spinner"></div>
                    </div>
                    <div class="device-actions">
                        <div class="d-grid gap-1">
                            <button class="btn btn-sm btn-primary" onclick="refreshDevice(${device.id})">
                                <i class="bi bi-arrow-clockwise me-1"></i>Refresh
                            </button>
                            <div class="btn-group" role="group">
                                <button class="btn btn-sm btn-outline-secondary" onclick="editDevice(${device.id})">
                                    <i class="bi bi-pencil"></i> Edit
                                </button>
                                <button class="btn btn-sm btn-outline-danger" onclick="deleteDevice(${device.id})">
                                    <i class="bi bi-trash"></i> Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// Refresh all devices status
async function refreshAllStatus() {
    for (const device of devices) {
        await refreshDevice(device.id, false);
    }
}

// Refresh single device
async function refreshDevice(deviceId, showMessage = true) {
    const dataContainer = document.getElementById(`data-${deviceId}`);
    const statusBadge = document.getElementById(`status-${deviceId}`);
    
    dataContainer.innerHTML = '<div class="loading-spinner"></div>';
    statusBadge.className = 'status-badge status-checking';
    statusBadge.innerHTML = '<i class="bi bi-hourglass-split"></i> Checking';
    
    try {
        // Check connectivity first
        const checkResponse = await fetch(`/api/devices/${deviceId}/check`, {
            method: 'POST'
        });
        const checkData = await checkResponse.json();
        
        if (!checkData.online) {
            statusBadge.className = 'status-badge status-offline';
            statusBadge.innerHTML = '<i class="bi bi-x-circle"></i> Offline';
            dataContainer.innerHTML = `
                <div class="text-center text-muted py-2">
                    <i class="bi bi-exclamation-triangle" style="font-size: 1.5rem;"></i>
                    <p class="mt-1 mb-0 small">Device is offline</p>
                </div>
            `;
            return;
        }
        
        // Get monitoring data
        const response = await fetch(`/api/devices/${deviceId}/monitor`, {
            method: 'POST'
        });
        const result = await response.json();
        
        if (result.success) {
            statusBadge.className = 'status-badge status-online';
            statusBadge.innerHTML = '<i class="bi bi-check-circle"></i> Online';
            
            monitoringData[deviceId] = result.data;
            
            dataContainer.innerHTML = `
                <div class="metric-section">
                    <div class="metric-label">RX Optical Power</div>
                    <div class="metric-value ${getPowerClass(result.data.currentValue)}">${escapeHtml(result.data.currentValue)}</div>
                    <div class="metric-reference">Range: ${escapeHtml(result.data.referenceValue)}</div>
                </div>
                <div class="metric-section">
                    <div class="metric-label">Working Temperature</div>
                    <div class="metric-value ${getTemperatureClass(result.data.temperature)}">${escapeHtml(result.data.temperature)}</div>
                    <div class="metric-reference">Range: ${escapeHtml(result.data.temperatureRange)}</div>
                </div>
                <div class="metric-section">
                    <div class="metric-label">TX Optical Power</div>
                    <div class="metric-value">${escapeHtml(result.data.txPower)}</div>
                </div>
                <div class="text-muted" style="font-size: 0.7rem; margin-top: 6px;">
                    <i class="bi bi-info-circle me-1"></i>${result.data.uiType === 'blue' ? 'Blue UI' : 'Red UI'}
                </div>
            `;
            
            if (showMessage) {
                showToast('Device refreshed successfully', 'success');
            }
        } else {
            statusBadge.className = 'status-badge status-offline';
            statusBadge.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Error';
            
            dataContainer.innerHTML = `
                <div class="text-center text-danger py-2">
                    <i class="bi bi-exclamation-triangle" style="font-size: 1.5rem;"></i>
                    <p class="mt-1 mb-0 small">${escapeHtml(result.error)}</p>
                </div>
            `;
        }
    } catch (error) {
        statusBadge.className = 'status-badge status-offline';
        statusBadge.innerHTML = '<i class="bi bi-x-circle"></i> Error';
        
        dataContainer.innerHTML = `
            <div class="text-center text-danger py-2">
                <i class="bi bi-exclamation-triangle" style="font-size: 1.5rem;"></i>
                <p class="mt-1 mb-0 small">Failed to connect</p>
            </div>
        `;
    }
}

// Get power class for color coding
function getPowerClass(powerStr) {
    const match = powerStr.match(/-?([\d.]+)/);
    if (!match) return '';
    
    const power = parseFloat(match[1]);
    if (powerStr.startsWith('-')) {
        // RX power
        if (power >= 8 && power <= 27) return 'good';
        if (power < 8 || power > 27) return 'warning';
    }
    return '';
}

// Get temperature class for color coding
function getTemperatureClass(tempStr) {
    const match = tempStr.match(/([\d.]+)/);
    if (!match) return '';
    
    const temp = parseFloat(match[1]);
    // Normal range: -10 to +85 °C
    // Warning if outside -10 to +85, good if within 0 to 70
    if (temp >= 0 && temp <= 70) return 'good';
    if (temp < -10 || temp > 85) return 'warning';
    return '';
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
    
    console.log('Editing device:', device); // Debug log
    
    document.getElementById('deviceModalTitle').textContent = 'Edit Device';
    document.getElementById('deviceId').value = device.id;
    document.getElementById('deviceName').value = device.name || '';
    document.getElementById('deviceHost').value = device.host || '';
    document.getElementById('deviceUsername').value = device.username || '';
    document.getElementById('devicePassword').value = '';
    document.getElementById('devicePassword').required = false;
    document.getElementById('deviceType').value = device.onuType || 'blue';
    
    // Monitoring settings with proper defaults
    document.getElementById('monitoringInterval').value = device.monitoringInterval !== undefined ? device.monitoringInterval : 900;
    document.getElementById('retryAttempts').value = device.retryAttempts !== undefined ? device.retryAttempts : 3;
    document.getElementById('retryDelay').value = device.retryDelay !== undefined ? device.retryDelay : 3;
    
    // Notification settings with proper defaults
    document.getElementById('notifyRxPower').checked = device.notifyRxPower === true;
    document.getElementById('rxPowerThreshold').value = device.rxPowerThreshold !== undefined ? device.rxPowerThreshold : -27;
    document.getElementById('notifyTempHigh').checked = device.notifyTempHigh === true;
    document.getElementById('tempHighThreshold').value = device.tempHighThreshold !== undefined ? device.tempHighThreshold : 70;
    document.getElementById('notifyTempLow').checked = device.notifyTempLow === true;
    document.getElementById('tempLowThreshold').value = device.tempLowThreshold !== undefined ? device.tempLowThreshold : 0;
    document.getElementById('notifyOffline').checked = device.notifyOffline === true;
    
    const modal = new bootstrap.Modal(document.getElementById('addDeviceModal'));
    modal.show();
}

// Reset device form
function resetDeviceForm() {
    document.getElementById('deviceModalTitle').textContent = 'Add Device';
    document.getElementById('deviceForm').reset();
    document.getElementById('deviceId').value = '';
    document.getElementById('devicePassword').required = true;
    
    // Reset to defaults
    document.getElementById('monitoringInterval').value = 900;
    document.getElementById('retryAttempts').value = 3;
    document.getElementById('retryDelay').value = 3;
    document.getElementById('rxPowerThreshold').value = -27;
    document.getElementById('tempHighThreshold').value = 70;
    document.getElementById('tempLowThreshold').value = 0;
}

// Save device
async function saveDevice() {
    const deviceId = document.getElementById('deviceId').value;
    const name = document.getElementById('deviceName').value;
    const host = document.getElementById('deviceHost').value;
    const username = document.getElementById('deviceUsername').value;
    const password = document.getElementById('devicePassword').value;
    const onuType = document.getElementById('deviceType').value;
    
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
        notifyOffline: document.getElementById('notifyOffline').checked
    };
    
    const data = { name, host, username, onuType, config };
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

// SMS API Configuration Functions

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

// Reset form when modal closes (only after successful save or cancel)
// Removed automatic reset on modal hide to prevent interfering with edit functionality
