// Dashboard JavaScript - Grouped PRTG-style Layout
let devices = [];
let groups = [];
let rebootSchedules = {};
let monitoringData = {};
let deviceStatuses = {};
let collapsedGroups = new Set();
let editingGroupId = null;
let lastUpdatedTimestamp = null;
let isRefreshingAll = false; // Flag to track if refresh all is in progress

// SQLite stores UTC as "YYYY-MM-DD HH:MM:SS" without Z; parse as UTC
function parseCacheTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return date;
    }
    const normalized = String(value).trim().replace(' ', 'T');
    const utc = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
    return Number.isNaN(utc.getTime()) ? null : utc;
}

// Check auth on load
window.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    await loadGroups();
    await loadDevices();
    await loadRebootSchedules();
    await loadSMSConfig();
    await loadMikroTikControlConfig();

    // Setup filter input
    document.getElementById('filterInput').addEventListener('input', renderDevices);

    // Setup port speeds configuration toggle
    document.getElementById('showPortSpeeds').addEventListener('change', function () {
        document.getElementById('portSpeedsConfig').style.display = this.checked ? 'block' : 'none';
        if (this.checked) {
            const anyPortSelected =
                document.getElementById('showPort1').checked ||
                document.getElementById('showPort2').checked ||
                document.getElementById('showPort3').checked ||
                document.getElementById('showPort4').checked;
            if (!anyPortSelected) {
                document.getElementById('showPort1').checked = true;
                document.getElementById('showPort2').checked = true;
            }
        }
    });

    const rebootConfirmEl = document.getElementById('rebootConfirmModal');
    if (rebootConfirmEl) {
        rebootConfirmEl.addEventListener('hidden.bs.modal', onRebootConfirmModalHidden);
    }
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

    list.innerHTML = groups.map(group => {
        if (editingGroupId === group.id) {
            return `
        <div class="list-group-item d-flex justify-content-between align-items-center gap-2">
            <input type="text" class="form-control form-control-sm" id="renameGroupInput-${group.id}" value="${escapeHtml(group.name)}" onkeydown="handleRenameGroupKeydown(event, ${group.id})">
            <div class="btn-group btn-group-sm flex-shrink-0">
                <button class="btn btn-primary btn-sm" onclick="saveRenameGroup(${group.id})" title="Save">
                    <i class="bi bi-check"></i>
                </button>
                <button class="btn btn-secondary btn-sm" onclick="cancelRenameGroup()" title="Cancel">
                    <i class="bi bi-x"></i>
                </button>
            </div>
        </div>`;
        }

        return `
        <div class="list-group-item d-flex justify-content-between align-items-center">
            <span>${escapeHtml(group.name)}</span>
            <div class="btn-group btn-group-sm">
                <button class="btn btn-outline-primary btn-sm" onclick="startRenameGroup(${group.id})" title="Rename">
                    <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteGroup(${group.id})" title="Delete">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');

    if (editingGroupId) {
        const input = document.getElementById(`renameGroupInput-${editingGroupId}`);
        if (input) {
            input.focus();
            input.select();
        }
    }
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

function startRenameGroup(groupId) {
    editingGroupId = groupId;
    updateGroupsList();
}

function cancelRenameGroup() {
    editingGroupId = null;
    updateGroupsList();
}

function handleRenameGroupKeydown(event, groupId) {
    if (event.key === 'Enter') {
        event.preventDefault();
        saveRenameGroup(groupId);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRenameGroup();
    }
}

async function saveRenameGroup(groupId) {
    const input = document.getElementById(`renameGroupInput-${groupId}`);
    const name = input?.value.trim();

    if (!name) {
        showToast('Please enter a group name', 'warning');
        return;
    }

    const group = groups.find(g => g.id === groupId);
    if (group && group.name === name) {
        cancelRenameGroup();
        return;
    }

    try {
        const response = await fetch(`/api/groups/${groupId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (response.ok) {
            editingGroupId = null;
            await loadGroups();
            renderDevices();
            showToast('Group renamed successfully', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to rename group', 'danger');
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
            if (editingGroupId === groupId) {
                editingGroupId = null;
            }
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
        await loadRebootSchedules();
        renderDevices();

        // Load cached status instead of triggering immediate refresh
        await loadCachedStatus();
    } catch (error) {
        showToast('Failed to load devices', 'danger');
    }
}

// Load reboot schedules
async function loadRebootSchedules() {
    try {
        const response = await fetch('/api/reboot-schedules');
        if (!response.ok) {
            rebootSchedules = {};
            return;
        }
        const list = await response.json();
        rebootSchedules = {};
        list.forEach((s) => {
            rebootSchedules[s.deviceId] = s;
        });
    } catch (error) {
        console.error('Failed to load reboot schedules:', error);
        rebootSchedules = {};
    }
}

const REBOOT_DAY_BITS = [1, 2, 4, 8, 16, 32, 64];
const REBOOT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isRebootCapableDevice(device) {
    return (
        device.onuType === 'blue' ||
        device.onuType === 'red' ||
        device.device_type === 'onu_blue' ||
        device.device_type === 'onu_red'
    );
}

function getRebootCapableOnuDevices() {
    return devices.filter(isRebootCapableDevice);
}

let pendingRebootDeviceId = null;
let rebootConfirmModal = null;

function getRebootConfirmModal() {
    if (!rebootConfirmModal) {
        rebootConfirmModal = new bootstrap.Modal(document.getElementById('rebootConfirmModal'));
    }
    return rebootConfirmModal;
}

function setRebootConfirmLoading(loading) {
    const idleEl = document.getElementById('rebootConfirmIdle');
    const loadingEl = document.getElementById('rebootConfirmLoading');
    const cancelBtn = document.getElementById('rebootConfirmCancelBtn');
    const confirmBtn = document.getElementById('rebootConfirmBtn');
    const closeBtn = document.querySelector('#rebootConfirmModal .btn-close');

    idleEl.style.display = loading ? 'none' : '';
    loadingEl.style.display = loading ? 'block' : 'none';
    cancelBtn.disabled = loading;
    if (closeBtn) closeBtn.disabled = loading;

    if (loading) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML =
            '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Rebooting…';
        const modal = bootstrap.Modal.getInstance(document.getElementById('rebootConfirmModal'));
        if (modal) {
            modal._config.backdrop = 'static';
            modal._config.keyboard = false;
        }
    } else {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Reboot now';
        const modal = bootstrap.Modal.getInstance(document.getElementById('rebootConfirmModal'));
        if (modal) {
            modal._config.backdrop = true;
            modal._config.keyboard = true;
        }
    }
}

function openRebootConfirmModal(deviceId) {
    const device = devices.find((d) => d.id === deviceId);
    if (!device || !isRebootCapableDevice(device)) {
        showToast('Reboot is only supported for Blue and Red UI Huawei ONU devices', 'warning');
        return;
    }

    pendingRebootDeviceId = deviceId;
    document.getElementById('rebootConfirmDeviceName').textContent = device.name;
    document.getElementById('rebootConfirmDeviceHost').textContent = device.host;
    document.getElementById('rebootConfirmLoadingName').textContent = device.name;
    setRebootConfirmLoading(false);
    getRebootConfirmModal().show();
}

async function confirmRebootDevice() {
    if (!pendingRebootDeviceId) return;

    const deviceId = pendingRebootDeviceId;
    setRebootConfirmLoading(true);

    try {
        const response = await fetch(`/api/devices/${deviceId}/reboot`, { method: 'POST' });
        const data = await response.json().catch(() => ({}));

        if (response.ok) {
            getRebootConfirmModal().hide();
            pendingRebootDeviceId = null;
            showToast(data.message || 'Reboot command sent successfully', 'success');
            setTimeout(() => refreshDevice(deviceId, true), 3000);
        } else {
            showToast(data.error || 'Reboot failed', 'danger');
            setRebootConfirmLoading(false);
        }
    } catch (error) {
        showToast('Network error while rebooting device', 'danger');
        setRebootConfirmLoading(false);
    }
}

function onRebootConfirmModalHidden() {
    pendingRebootDeviceId = null;
    setRebootConfirmLoading(false);
}

function buildRebootDaysMask() {
    let mask = 0;
    document.querySelectorAll('.reboot-day:checked').forEach((el) => {
        mask |= parseInt(el.value, 10);
    });
    return mask;
}

function setRebootDaysMask(mask) {
    document.querySelectorAll('.reboot-day').forEach((el) => {
        const bit = parseInt(el.value, 10);
        el.checked = (mask & bit) !== 0;
    });
}

function formatRebootDaysAndTime(schedule) {
    if (!schedule) return '';
    const days = [];
    for (let i = 0; i < 7; i++) {
        if (schedule.daysMask & REBOOT_DAY_BITS[i]) {
            days.push(REBOOT_DAY_NAMES[i]);
        }
    }
    return `${days.join(', ')} at ${schedule.timeLocal}`;
}

function formatRebootScheduleLabel(schedule) {
    if (!schedule) return '';
    const when = formatRebootDaysAndTime(schedule);
    if (!schedule.enabled) {
        return `Reboot paused: ${when}`;
    }
    return `Reboot ${when}`;
}

function formatRebootLastRun(schedule) {
    if (!schedule || !schedule.lastRunAt) {
        return '<span class="text-muted">Never</span>';
    }
    const status = schedule.lastRunStatus || 'unknown';
    const badgeClass =
        status === 'success' ? 'bg-success' : status === 'skipped' ? 'bg-warning text-dark' : 'bg-danger';
    const msg = schedule.lastRunMessage ? ` — ${escapeHtml(schedule.lastRunMessage)}` : '';
    return `<span class="text-nowrap">${escapeHtml(schedule.lastRunAt)}</span> <span class="badge ${badgeClass}">${escapeHtml(status)}</span>${msg}`;
}

function rebootLogStatusBadge(status) {
    const badgeClass =
        status === 'success' ? 'bg-success' : status === 'skipped' ? 'bg-warning text-dark' : 'bg-danger';
    return `<span class="badge ${badgeClass}">${escapeHtml(status)}</span>`;
}

const REBOOT_UNGROUPED_KEY = 'none';

function getRebootGroupKeyForDevice(device) {
    if (!device) return '';
    return device.groupId ? String(device.groupId) : REBOOT_UNGROUPED_KEY;
}

function getRebootCapableOnuInGroup(groupKey) {
    const rebootDevices = getRebootCapableOnuDevices();
    if (!groupKey) return [];
    if (groupKey === REBOOT_UNGROUPED_KEY) {
        return rebootDevices.filter((d) => d.groupId == null || d.groupId === '');
    }
    const groupId = parseInt(groupKey, 10);
    return rebootDevices.filter((d) => Number(d.groupId) === groupId);
}

function setRebootDeviceSelectVisible(visible) {
    const wrap = document.getElementById('rebootDeviceSelectWrap');
    if (wrap) {
        wrap.style.display = visible ? 'block' : 'none';
    }
}

function rebootOnuCountLabel(count) {
    if (count === 0) return ' — no Blue/Red ONU';
    return ` — ${count} ONU${count !== 1 ? 's' : ''}`;
}

function populateRebootGroupSelect(selectedGroupKey) {
    const select = document.getElementById('rebootGroupSelect');
    if (!select) return;

    let html = '<option value="">Select a group...</option>';

    if (groups.length === 0) {
        html += '<option value="" disabled>No groups — create one via Manage Groups</option>';
    } else {
        groups.forEach((group) => {
            const count = getRebootCapableOnuInGroup(String(group.id)).length;
            const selected = selectedGroupKey === String(group.id) ? ' selected' : '';
            html += `<option value="${group.id}"${selected}>${escapeHtml(group.name)}${rebootOnuCountLabel(count)}</option>`;
        });
    }

    const ungroupedCount = getRebootCapableOnuInGroup(REBOOT_UNGROUPED_KEY).length;
    if (ungroupedCount > 0) {
        const selected = selectedGroupKey === REBOOT_UNGROUPED_KEY ? ' selected' : '';
        html += `<option value="${REBOOT_UNGROUPED_KEY}"${selected}>No Group${rebootOnuCountLabel(ungroupedCount)}</option>`;
    }

    select.innerHTML = html;
    if (selectedGroupKey) {
        select.value = selectedGroupKey;
    }
}

function populateRebootDeviceSelectForGroup(groupKey, selectedDeviceId) {
    const select = document.getElementById('rebootDeviceSelect');
    if (!select) return;

    const list = getRebootCapableOnuInGroup(groupKey).sort((a, b) =>
        (a.name || '').localeCompare(b.name || '')
    );

    let html;
    if (list.length === 0) {
        html =
            '<option value="">No Blue/Red ONU in this group — assign a device via Edit Device</option>';
    } else {
        html = '<option value="">Select an ONU...</option>';
        list.forEach((d) => {
            const typeLabel = d.onuType === 'red' ? 'Red' : 'Blue';
            html += `<option value="${d.id}">${escapeHtml(d.name)} [${typeLabel}] (${escapeHtml(d.host)})</option>`;
        });
    }

    select.innerHTML = html;
    if (selectedDeviceId) {
        select.value = String(selectedDeviceId);
    }
}

function setRebootDevicePicker(groupKey, deviceId) {
    populateRebootGroupSelect(groupKey || '');
    if (groupKey) {
        setRebootDeviceSelectVisible(true);
        populateRebootDeviceSelectForGroup(groupKey, deviceId || null);
    } else {
        setRebootDeviceSelectVisible(false);
        const deviceSelect = document.getElementById('rebootDeviceSelect');
        if (deviceSelect) {
            deviceSelect.innerHTML = '<option value="">Select an ONU...</option>';
        }
    }
}

function onRebootGroupSelected() {
    const groupKey = document.getElementById('rebootGroupSelect').value;
    if (!groupKey) {
        setRebootDeviceSelectVisible(false);
        document.getElementById('rebootDeviceSelect').innerHTML = '<option value="">Select an ONU...</option>';
        setRebootDaysMask(0);
        document.getElementById('rebootTimeLocal').value = '';
        updateRebootLastRunInfo(null);
        loadRebootLogs(null);
        return;
    }

    setRebootDeviceSelectVisible(true);
    populateRebootDeviceSelectForGroup(groupKey, null);
    setRebootDaysMask(0);
    document.getElementById('rebootTimeLocal').value = '';
    updateRebootLastRunInfo(null);
    loadRebootLogs(null);
    document.getElementById('rebootDeviceSelect').focus();
}

function updateRebootLastRunInfo(schedule) {
    const el = document.getElementById('rebootLastRunInfo');
    const deleteBtn = document.getElementById('rebootDeleteBtn');

    if (!schedule) {
        el.style.display = 'none';
        deleteBtn.style.display = 'none';
        return;
    }

    deleteBtn.style.display = 'inline-block';
    el.style.display = 'block';
    if (schedule.lastRunAt) {
        el.innerHTML = `<strong>Last run:</strong> ${formatRebootLastRun(schedule)}`;
    } else {
        el.textContent = 'No reboot runs recorded yet for this device.';
    }
}

function renderRebootSchedulesTable() {
    const tbody = document.getElementById('rebootSchedulesTableBody');
    if (!tbody) return;

    const list = Object.values(rebootSchedules).sort((a, b) =>
        (a.deviceName || '').localeCompare(b.deviceName || '')
    );

    if (list.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="5" class="text-muted text-center py-3">No schedules yet. Use <strong>New schedule</strong> or the form below.</td></tr>';
        return;
    }

    tbody.innerHTML = list
        .map((schedule) => {
            const groupLabel = schedule.groupName ? `${escapeHtml(schedule.groupName)} — ` : '';
            const typeLabel = schedule.onuType === 'red' ? 'Red' : 'Blue';
            const enabledChecked = schedule.enabled ? 'checked' : '';
            return `
        <tr>
            <td>
                <div class="fw-medium">${groupLabel}${escapeHtml(schedule.deviceName)}</div>
                <div class="text-muted small">${escapeHtml(schedule.deviceHost)} · ${typeLabel}</div>
            </td>
            <td>${escapeHtml(formatRebootDaysAndTime(schedule))}</td>
            <td>
                <div class="form-check form-switch mb-0">
                    <input class="form-check-input" type="checkbox" role="switch"
                        id="rebootEnabled-${schedule.deviceId}"
                        ${enabledChecked}
                        onchange="toggleRebootScheduleEnabled(${schedule.deviceId}, this.checked)">
                </div>
            </td>
            <td class="small">${formatRebootLastRun(schedule)}</td>
            <td class="text-end text-nowrap">
                <button type="button" class="btn btn-outline-primary btn-sm" onclick="editRebootSchedule(${schedule.deviceId})" title="Edit">
                    <i class="bi bi-pencil"></i>
                </button>
                <button type="button" class="btn btn-outline-danger btn-sm" onclick="deleteRebootScheduleById(${schedule.deviceId})" title="Delete">
                    <i class="bi bi-trash"></i>
                </button>
            </td>
        </tr>`;
        })
        .join('');
}

async function loadRebootLogs(deviceId) {
    const section = document.getElementById('rebootLogsSection');
    const tbody = document.getElementById('rebootLogsTableBody');
    if (!section || !tbody) return;

    if (!deviceId) {
        section.style.display = 'none';
        tbody.innerHTML = '';
        return;
    }

    section.style.display = 'block';
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted text-center py-2">Loading history…</td></tr>';

    try {
        const response = await fetch(`/api/reboot-schedules/${deviceId}/logs`);
        if (!response.ok) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-danger text-center py-2">Failed to load reboot history</td></tr>';
            return;
        }

        const logs = await response.json();
        if (logs.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="4" class="text-muted text-center py-2">No reboot runs recorded yet.</td></tr>';
            return;
        }

        tbody.innerHTML = logs
            .map(
                (log) => `
            <tr>
                <td class="text-nowrap small">${escapeHtml(log.startedAt || '—')}</td>
                <td class="text-nowrap small">${escapeHtml(log.scheduledFor || '—')}</td>
                <td>${rebootLogStatusBadge(log.status)}</td>
                <td class="small">${escapeHtml(log.message || '')}</td>
            </tr>`
            )
            .join('');
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-danger text-center py-2">Network error loading history</td></tr>';
    }
}

function startNewRebootSchedule() {
    document.getElementById('rebootSchedulerForm').reset();
    document.getElementById('rebootScheduleEnabled').checked = true;
    document.getElementById('rebootNotifyOnFailure').checked = true;
    populateRebootGroupSelect('');
    setRebootDevicePicker('', null);
    setRebootDaysMask(0);
    updateRebootLastRunInfo(null);
    loadRebootLogs(null);
    document.getElementById('rebootGroupSelect').focus();
}

function editRebootSchedule(deviceId) {
    const device = devices.find((d) => d.id === deviceId || String(d.id) === String(deviceId));
    const schedule = rebootSchedules[deviceId] || rebootSchedules[parseInt(deviceId, 10)];
    let groupKey = '';

    if (device) {
        groupKey = getRebootGroupKeyForDevice(device);
    } else if (schedule) {
        groupKey = schedule.groupId ? String(schedule.groupId) : REBOOT_UNGROUPED_KEY;
    }

    setRebootDevicePicker(groupKey, deviceId);
    onRebootDeviceSelected();
    document.getElementById('rebootSchedulerForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function toggleRebootScheduleEnabled(deviceId, enabled) {
    const schedule = rebootSchedules[deviceId];
    if (!schedule) {
        showToast('Schedule not found', 'warning');
        await loadRebootSchedules();
        renderRebootSchedulesTable();
        return;
    }

    try {
        const response = await fetch(`/api/reboot-schedules/${deviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                daysMask: schedule.daysMask,
                timeLocal: schedule.timeLocal,
                enabled,
                notifyOnFailure: schedule.notifyOnFailure
            })
        });

        if (response.ok) {
            await loadRebootSchedules();
            renderRebootSchedulesTable();
            renderDevices();
            const selectedId = document.getElementById('rebootDeviceSelect').value;
            if (selectedId === String(deviceId)) {
                const updated = await response.json();
                document.getElementById('rebootScheduleEnabled').checked = updated.enabled;
                updateRebootLastRunInfo(updated);
            }
            showToast(enabled ? 'Schedule enabled' : 'Schedule disabled', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to update schedule', 'danger');
            renderRebootSchedulesTable();
        }
    } catch (error) {
        showToast('Network error', 'danger');
        renderRebootSchedulesTable();
    }
}

async function deleteRebootScheduleById(deviceId) {
    const schedule = rebootSchedules[deviceId];
    const name = schedule ? schedule.deviceName : 'this device';
    if (!confirm(`Delete reboot schedule for ${name}?`)) return;

    try {
        const response = await fetch(`/api/reboot-schedules/${deviceId}`, { method: 'DELETE' });
        if (response.ok) {
            await loadRebootSchedules();
            renderRebootSchedulesTable();
            renderDevices();
            if (document.getElementById('rebootDeviceSelect').value === String(deviceId)) {
                startNewRebootSchedule();
            }
            showToast('Schedule deleted', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to delete', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

async function openRebootSchedulerModal() {
    populateRebootGroupSelect('');
    await loadRebootSchedules();
    renderRebootSchedulesTable();
    startNewRebootSchedule();
}

async function onRebootDeviceSelected() {
    const deviceId = document.getElementById('rebootDeviceSelect').value;
    if (!deviceId) {
        setRebootDaysMask(0);
        document.getElementById('rebootTimeLocal').value = '';
        updateRebootLastRunInfo(null);
        loadRebootLogs(null);
        return;
    }

    loadRebootLogs(deviceId);

    const cached = rebootSchedules[deviceId] || rebootSchedules[parseInt(deviceId, 10)];
    if (cached) {
        setRebootDaysMask(cached.daysMask);
        document.getElementById('rebootTimeLocal').value = cached.timeLocal;
        document.getElementById('rebootScheduleEnabled').checked = cached.enabled;
        document.getElementById('rebootNotifyOnFailure').checked = cached.notifyOnFailure;
        updateRebootLastRunInfo(cached);
        return;
    }

    try {
        const response = await fetch(`/api/reboot-schedules/${deviceId}`);
        if (response.status === 404) {
            setRebootDaysMask(0);
            document.getElementById('rebootTimeLocal').value = '03:00';
            document.getElementById('rebootScheduleEnabled').checked = true;
            document.getElementById('rebootNotifyOnFailure').checked = true;
            updateRebootLastRunInfo(null);
            return;
        }

        if (!response.ok) {
            showToast('Failed to load schedule', 'danger');
            return;
        }

        const schedule = await response.json();
        rebootSchedules[schedule.deviceId] = schedule;
        setRebootDaysMask(schedule.daysMask);
        document.getElementById('rebootTimeLocal').value = schedule.timeLocal;
        document.getElementById('rebootScheduleEnabled').checked = schedule.enabled;
        document.getElementById('rebootNotifyOnFailure').checked = schedule.notifyOnFailure;
        updateRebootLastRunInfo(schedule);
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

async function saveRebootSchedule() {
    const groupKey = document.getElementById('rebootGroupSelect').value;
    if (!groupKey) {
        showToast('Please select a group', 'warning');
        return;
    }

    const deviceId = document.getElementById('rebootDeviceSelect').value;
    if (!deviceId) {
        showToast('Please select an ONU', 'warning');
        return;
    }

    const daysMask = buildRebootDaysMask();
    if (daysMask === 0) {
        showToast('Select at least one day', 'warning');
        return;
    }

    const timeLocal = document.getElementById('rebootTimeLocal').value;
    if (!timeLocal) {
        showToast('Please set a time', 'warning');
        return;
    }

    try {
        const response = await fetch(`/api/reboot-schedules/${deviceId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                daysMask,
                timeLocal,
                enabled: document.getElementById('rebootScheduleEnabled').checked,
                notifyOnFailure: document.getElementById('rebootNotifyOnFailure').checked
            })
        });

        if (response.ok) {
            const schedule = await response.json();
            await loadRebootSchedules();
            renderRebootSchedulesTable();
            renderDevices();
            updateRebootLastRunInfo(schedule);
            await loadRebootLogs(deviceId);
            showToast('Reboot schedule saved', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to save schedule', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

async function deleteRebootSchedule() {
    const deviceId = document.getElementById('rebootDeviceSelect').value;
    if (!deviceId) return;

    if (!confirm('Delete reboot schedule for this device?')) return;

    try {
        const response = await fetch(`/api/reboot-schedules/${deviceId}`, { method: 'DELETE' });
        if (response.ok) {
            await loadRebootSchedules();
            renderRebootSchedulesTable();
            renderDevices();
            startNewRebootSchedule();
            showToast('Schedule deleted', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to delete', 'danger');
        }
    } catch (error) {
        showToast('Network error', 'danger');
    }
}

function renderRebootScheduleBadge(deviceId) {
    const schedule = rebootSchedules[deviceId];
    if (!schedule) return '';
    const label = formatRebootScheduleLabel(schedule);
    const badgeClass = schedule.enabled ? 'badge-purple' : 'badge-secondary';
    const icon = schedule.enabled ? 'bi-calendar-check' : 'bi-calendar-x';
    return `<span class="sensor-badge ${badgeClass}" title="${escapeHtml(label)}"><i class="bi ${icon}"></i> ${escapeHtml(label)}</span>`;
}

// Apply cached monitoring data to in-memory device state
function syncStatusFromCache(cachedData, { onlyUnresolved = false } = {}) {
    let mostRecentUpdate = null;
    let changed = false;

    for (const [deviceId, cache] of Object.entries(cachedData)) {
        const id = parseInt(deviceId, 10);
        const currentStatus = deviceStatuses[id];
        const isUnresolved = currentStatus === undefined || currentStatus === 'checking';

        if (onlyUnresolved && !isUnresolved) {
            const updateTime = parseCacheTimestamp(cache.lastUpdated);
            if (updateTime && (!mostRecentUpdate || updateTime > mostRecentUpdate)) {
                mostRecentUpdate = updateTime;
            }
            continue;
        }

        if (!cache.status) {
            continue;
        }

        const statusChanged = currentStatus !== cache.status;
        if (statusChanged) {
            deviceStatuses[id] = cache.status;
        }

        if (cache.data) {
            monitoringData[id] = cache.data;
        }

        if (statusChanged || (isUnresolved && cache.status)) {
            changed = true;
        }

        const updateTime = parseCacheTimestamp(cache.lastUpdated);
        if (updateTime && (!mostRecentUpdate || updateTime > mostRecentUpdate)) {
            mostRecentUpdate = updateTime;
        }
    }

    return { changed, mostRecentUpdate };
}

function updateLastUpdatedFromCache(mostRecentUpdate) {
    const storedTimestamp = localStorage.getItem('lastManualRefresh');
    const manualRefreshTime = storedTimestamp ? new Date(storedTimestamp) : null;

    if (manualRefreshTime && mostRecentUpdate) {
        lastUpdatedTimestamp = manualRefreshTime > mostRecentUpdate ? manualRefreshTime : mostRecentUpdate;
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
}

function hasUnresolvedDevices() {
    return devices.some((device) => {
        const status = deviceStatuses[device.id];
        return status === undefined || status === 'checking';
    });
}

// Load cached monitoring status from database
async function loadCachedStatus() {
    try {
        const response = await fetch('/api/devices/cached-status');
        const cachedData = await response.json();
        const { changed, mostRecentUpdate } = syncStatusFromCache(cachedData);

        updateLastUpdatedFromCache(mostRecentUpdate);

        if (changed) {
            renderDevices();
        }
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
                    <button class="btn btn-info btn-mini" onclick="copyDevice(${device.id})" title="Copy">
                        <i class="bi bi-copy"></i>
                    </button>
                    ${isRebootCapableDevice(device) ? `
                    <button class="btn btn-outline-secondary btn-mini" onclick="openRebootConfirmModal(${device.id})" title="Reboot ONU">
                        <i class="bi bi-arrow-repeat"></i>
                    </button>
                    ` : ''}
                    <button class="btn btn-danger btn-mini" onclick="deleteDevice(${device.id})" title="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
            <div class="device-card-body" id="badges-${device.id}">
                ${renderRebootScheduleBadge(device.id)}
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
            if (data.portSpeed !== undefined && data.portSpeed !== null && device.showMikrotikPortSpeed) {
                const speedClass = getMikrotikPortSpeedBadgeClass(data.portSpeed);
                let formattedSpeed;

                // Handle no-link status
                if (data.portSpeed === 'no-link' || data.portSpeed === 'No Link') {
                    formattedSpeed = 'No Link';
                } else if (data.portSpeed >= 1000) {
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
                const uiLabel = data.uiType === 'blue' ? 'Blue' :
                    data.uiType === 'tenda' ? 'Tenda' : 'Red';
                badges += `<span class="sensor-badge badge-gray">${uiLabel}</span>`;
            }

            // Port speeds badges - only show if enabled in device preferences
            if (device.showPortSpeeds && data.portSpeeds) {
                const selectedPorts = (device.portSelections && device.portSelections.length > 0)
                    ? device.portSelections
                    : Object.keys(data.portSpeeds)
                        .map((key) => {
                            const match = key.match(/^eth(\d+)-speed$/);
                            return match ? match[1] : null;
                        })
                        .filter(Boolean);

                selectedPorts.forEach(port => {
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

            // Online Duration badge - show if enabled in device preferences
            if (device.showOnlineDuration) {
                if (data.onlineDuration && data.onlineDuration.uptimeSeconds > 0) {
                    // WAN is connected - show uptime with purple badge
                    const duration = data.onlineDuration;
                    const formattedDuration = duration.formatted || `${duration.days}d ${duration.hours}h`;
                    badges += `<span class="sensor-badge badge-purple"><i class="bi bi-clock-history"></i> Up: ${formattedDuration}</span>`;
                } else {
                    // WAN is disconnected - show red badge with exclamation
                    badges += `<span class="sensor-badge badge-red"><i class="bi bi-exclamation-triangle-fill"></i> WAN Disconnected</span>`;
                }
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
    // Handle no-link status
    if (speed === 'no-link' || speed === 'No Link') return 'port-speed-down';
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

// Poll faster while devices are still waiting for their first status
setInterval(async () => {
    if (!hasUnresolvedDevices()) {
        return;
    }

    try {
        const response = await fetch('/api/devices/cached-status');
        const cachedData = await response.json();
        const { changed, mostRecentUpdate } = syncStatusFromCache(cachedData, { onlyUnresolved: true });

        if (changed) {
            updateLastUpdatedFromCache(mostRecentUpdate);
            renderDevices();
        }
    } catch (error) {
        console.error('Failed to poll unresolved device status:', error);
    }
}, 5000);

// Check for new background monitoring updates every 30 seconds
setInterval(async () => {
    try {
        const response = await fetch('/api/devices/cached-status');
        const cachedData = await response.json();
        const { changed, mostRecentUpdate } = syncStatusFromCache(cachedData);
        const previousTimestamp = lastUpdatedTimestamp;

        if (mostRecentUpdate) {
            updateLastUpdatedFromCache(mostRecentUpdate);
        }

        const hasNewBackgroundData =
            mostRecentUpdate &&
            (!previousTimestamp || mostRecentUpdate > previousTimestamp);

        if (changed || hasNewBackgroundData) {
            if (hasNewBackgroundData) {
                localStorage.removeItem('lastManualRefresh');
            }
            renderDevices();
        }
    } catch (error) {
        console.error('Failed to check for background updates:', error);
    }
}, 30000);

// Refresh all devices status - uses sequential mode for better visual feedback
async function refreshAllStatus() {
    // Always use sequential mode so users can see progress as each device completes
    await refreshAllStatusSequential();
}

// Refresh all devices status (batch mode - all at once, faster for many devices)
async function refreshAllStatusBatch() {
    const totalDevices = devices.length;

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
                if (result.error && (result.error.includes('offline') || result.error.includes('not reachable'))) {
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

// Refresh all devices status (sequential mode - one by one, better visual feedback)
async function refreshAllStatusSequential() {
    const totalDevices = devices.length;
    const maxConcurrent = 10; // Process 3 devices at a time
    let completedCount = 0;

    // Set ALL devices to checking state immediately
    for (const device of devices) {
        updateDeviceCard(device.id, 'checking', null);
    }

    // Process devices in small batches for better UX
    for (let i = 0; i < devices.length; i += maxConcurrent) {
        const batch = devices.slice(i, i + maxConcurrent);

        // Process batch in parallel
        const batchPromises = batch.map(async (device) => {
            try {
                // Determine API endpoint based on device type
                let apiUrl, method = 'POST';

                if (device.device_type === 'mikrotik_lhg60g') {
                    // MikroTik device monitoring
                    apiUrl = `/api/mikrotik/devices/${device.id}/monitor`;
                } else {
                    // ONU device monitoring
                    apiUrl = `/api/devices/${device.id}/monitor`;
                }

                // Fetch device data
                const response = await fetch(apiUrl, { method });
                const result = await response.json();

                // Update device card based on result immediately
                if (result.success) {
                    updateDeviceCard(device.id, 'online', result.data);
                } else {
                    // Check if it's a connectivity issue or other error
                    if (result.error && (result.error.includes('offline') || result.error.includes('not reachable'))) {
                        updateDeviceCard(device.id, 'offline', null);
                    } else {
                        updateDeviceCard(device.id, 'error', null);
                    }
                }

                completedCount++;
                console.log(`Completed ${completedCount}/${totalDevices}: ${device.name}`);

            } catch (error) {
                console.error(`Failed to refresh device ${device.id}:`, error);
                updateDeviceCard(device.id, 'error', null);
                completedCount++;
            }
        });

        // Wait for current batch to complete before starting next batch
        await Promise.all(batchPromises);
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
    const totalDevices = devices.length;

    if (totalDevices === 0) {
        showToast('No devices to refresh', 'warning');
        return;
    }

    if (isRefreshingAll) {
        showToast('Refresh already in progress', 'warning');
        return;
    }

    isRefreshingAll = true;

    // Show message
    showToast(`Refreshing ${totalDevices} devices (updating as they complete)...`, 'info');

    try {
        await refreshAllStatus();
        showToast(`All ${totalDevices} device${totalDevices > 1 ? 's' : ''} refreshed successfully`, 'success');
    } catch (error) {
        showToast('Refresh failed: ' + error.message, 'danger');
    } finally {
        isRefreshingAll = false;
    }
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

    // Determine device type - map from backend format to form format
    let deviceType = device.device_type || device.onuType || 'blue';
    // Map onu_blue -> blue, onu_red -> red, onu_tenda -> tenda
    if (deviceType === 'onu_blue') {
        deviceType = 'blue';
    } else if (deviceType === 'onu_red') {
        deviceType = 'red';
    } else if (deviceType === 'onu_tenda') {
        deviceType = 'tenda';
    }
    document.getElementById('deviceType').value = deviceType;

    if (deviceType === 'mikrotik_lhg60g') {
        // MikroTik-specific fields
        document.getElementById('deviceHost').value = device.host || '';
        document.getElementById('deviceUsername').value = device.username || '';
        document.getElementById('mikrotikLhg60gIP').value = device.mikrotikLhg60gIp || '';
        document.getElementById('mikrotikSshPort').value = device.mikrotikSshPort || '';
        document.getElementById('mikrotikSshUsername').value = device.mikrotikSshUsername || '';
        document.getElementById('mikrotikSshPassword').value = '';
        document.getElementById('mikrotikTunnelIP').value = device.mikrotikTunnelIp || '';

        // MikroTik notification settings
        document.getElementById('notifyRssi').checked = device.notifyRssi === true;
        document.getElementById('rssiThreshold').value = device.rssiThreshold !== undefined ? device.rssiThreshold : -66;
        document.getElementById('notifyMikrotikPortSpeed').checked = device.notifyPortSpeed === true;
        document.getElementById('portSpeedThreshold').value = device.portSpeedThreshold !== undefined ? device.portSpeedThreshold : 1000;
        document.getElementById('notifyMikrotikOffline').checked = device.notifyOffline === true;

        // MikroTik display preferences
        document.getElementById('showRssi').checked = device.showRssi === true;
        document.getElementById('showMikrotikPortSpeed').checked = device.showMikrotikPortSpeed === true;
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

        // Online Duration preference (supported by both Blue and Red UI)
        document.getElementById('showOnlineDuration').checked = device.showOnlineDuration === true;
        // Always show for ONU devices (both Blue and Red UI support this)
        document.getElementById('showOnlineDurationContainer').style.display = 'block';
    }

    document.getElementById('deviceGroup').value = device.groupId || '';

    // Monitoring settings (common to both types)
    document.getElementById('monitoringInterval').value = device.monitoringInterval !== undefined ? device.monitoringInterval : 900;
    document.getElementById('retryAttempts').value = device.retryAttempts !== undefined ? device.retryAttempts : 3;
    document.getElementById('retryDelay').value = device.retryDelay !== undefined ? device.retryDelay : 3;

    // IMPORTANT: Toggle fields AFTER all fields are populated
    toggleDeviceTypeFields();

    const modal = new bootstrap.Modal(document.getElementById('addDeviceModal'));
    modal.show();
}

// Copy device - loads device config without ID to create a new copy
function copyDevice(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device) {
        showToast('Device not found', 'danger');
        return;
    }

    // Reset form first
    resetDeviceForm();

    // Set modal title to indicate this is a copy
    document.getElementById('deviceModalTitle').textContent = 'Copy Device';

    // Clear the device ID so it saves as a new device
    document.getElementById('deviceId').value = '';

    // Set the name with "(Copy)" suffix
    document.getElementById('deviceName').value = device.name + ' (Copy)';

    // Password is required for new devices
    document.getElementById('devicePassword').required = true;

    // Determine the device type
    if (device.deviceType === 'mikrotik_lhg60g') {
        document.getElementById('deviceType').value = 'mikrotik_lhg60g';
        // MikroTik-specific fields
        document.getElementById('mikrotikLhg60gIP').value = device.mikrotikLhg60gIP || '';
        document.getElementById('mikrotikSshPort').value = device.mikrotikSshPort || 22;
        document.getElementById('mikrotikTunnelIP').value = device.mikrotikTunnelIP || '';
        document.getElementById('mikrotikSshUsername').value = device.mikrotikSshUsername || '';
        // Password needs to be re-entered for security
        document.getElementById('mikrotikSshPassword').value = '';
        // MikroTik notifications
        document.getElementById('notifyMikrotikRssi').checked = device.notifyRssi === true;
        document.getElementById('mikrotikRssiThreshold').value = device.rssiThreshold || -65;
        document.getElementById('notifyMikrotikPortSpeed').checked = device.notifyPortSpeed === true;
        document.getElementById('mikrotikPortSpeedThreshold').value = device.portSpeedThreshold || 1000;
        // MikroTik display preferences
        document.getElementById('showRssi').checked = device.showRssi === true;
        document.getElementById('showMikrotikPortSpeed').checked = device.showPortSpeed === true;
    } else {
        // ONU device
        document.getElementById('deviceType').value = device.onuType || 'blue';
        document.getElementById('deviceHost').value = device.host || '';
        document.getElementById('deviceUsername').value = device.username || '';
        // Password needs to be re-entered for security
        document.getElementById('devicePassword').value = '';

        // ONU notification settings
        document.getElementById('notifyRxPower').checked = device.notifyRxPower === true;
        document.getElementById('rxPowerThreshold').value = device.rxPowerThreshold || -25;
        document.getElementById('notifyTempHigh').checked = device.notifyTempHigh === true;
        document.getElementById('tempHighThreshold').value = device.tempHighThreshold || 70;
        document.getElementById('notifyTempLow').checked = device.notifyTempLow === true;
        document.getElementById('tempLowThreshold').value = device.tempLowThreshold || 0;
        document.getElementById('notifyOffline').checked = device.notifyOffline === true;
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

        // Online Duration preference
        document.getElementById('showOnlineDuration').checked = device.showOnlineDuration === true;
        document.getElementById('showOnlineDurationContainer').style.display = 'block';
    }

    document.getElementById('deviceGroup').value = device.groupId || '';

    // Monitoring settings (common to both types)
    document.getElementById('monitoringInterval').value = device.monitoringInterval !== undefined ? device.monitoringInterval : 900;
    document.getElementById('retryAttempts').value = device.retryAttempts !== undefined ? device.retryAttempts : 3;
    document.getElementById('retryDelay').value = device.retryDelay !== undefined ? device.retryDelay : 3;

    // Toggle fields to show correct device type fields
    toggleDeviceTypeFields();

    const modal = new bootstrap.Modal(document.getElementById('addDeviceModal'));
    modal.show();

    showToast('Device configuration copied. Enter password and save as new device.', 'info');
}

// Reset device form
function resetDeviceForm() {
    document.getElementById('deviceModalTitle').textContent = 'Add Device';
    document.getElementById('deviceForm').reset();
    document.getElementById('deviceId').value = '';
    document.getElementById('devicePassword').required = true;
    document.getElementById('deviceGroup').value = '';
    document.getElementById('deviceType').value = 'blue';

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
    document.getElementById('showOnlineDuration').checked = false;
    document.getElementById('showOnlineDurationContainer').style.display = 'block'; // Show by default for new Blue UI devices
    document.getElementById('showRssi').checked = false;
    document.getElementById('showMikrotikPortSpeed').checked = false;

    // IMPORTANT: Toggle fields to show ONU by default
    toggleDeviceTypeFields();
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
            const targetId = deviceId || result.id;
            if (targetId) {
                refreshDevice(targetId, false);
            }
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
        showOnlineDuration: document.getElementById('showOnlineDuration').checked,
        portSelections: (() => {
            const selections = [
                document.getElementById('showPort1').checked ? '1' : null,
                document.getElementById('showPort2').checked ? '2' : null,
                document.getElementById('showPort3').checked ? '3' : null,
                document.getElementById('showPort4').checked ? '4' : null
            ].filter(port => port !== null);
            if (document.getElementById('showPortSpeeds').checked && selections.length === 0) {
                return ['1', '2'];
            }
            return selections;
        })()
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
            const result = await response.json();
            const modal = bootstrap.Modal.getInstance(document.getElementById('addDeviceModal'));
            modal.hide();
            resetDeviceForm();
            showToast(deviceId ? 'Device updated successfully' : 'Device added successfully', 'success');
            await loadDevices();
            const targetId = deviceId || result.id;
            if (targetId) {
                refreshDevice(targetId, false);
            }
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
    const onlineDurationContainer = document.getElementById('showOnlineDurationContainer');
    const showPortSpeedsCheckbox = document.getElementById('showPortSpeeds');
    const showPortSpeedsContainer = showPortSpeedsCheckbox ? showPortSpeedsCheckbox.parentElement : null;

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
    } else if (deviceType === 'tenda') {
        // Tenda ONU - show ONU fields but hide port monitoring (not supported)
        mikrotikFields.style.display = 'none';
        onuNotifications.style.display = 'block';
        mikrotikNotifications.style.display = 'none';
        onuPortMonitoring.style.display = 'none'; // Tenda doesn't support port monitoring
        onuDisplayPrefs.style.display = 'block';
        mikrotikDisplayPrefs.style.display = 'none';

        // Show ONU-specific basic fields
        document.getElementById('deviceHost').parentElement.style.display = 'block';
        document.getElementById('deviceUsername').parentElement.style.display = 'block';
        document.getElementById('devicePassword').parentElement.style.display = 'block';

        // Hide port speeds option in display preferences for Tenda
        if (showPortSpeedsContainer) {
            showPortSpeedsContainer.style.display = 'none';
        }
        document.getElementById('portSpeedsConfig').style.display = 'none';

        // Show online duration for Tenda
        if (onlineDurationContainer) {
            onlineDurationContainer.style.display = 'block';
        }
    } else {
        // Huawei ONU (Blue/Red UI) - show all ONU fields
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

        // Show port speeds option for Huawei
        if (showPortSpeedsContainer) {
            showPortSpeedsContainer.style.display = 'block';
        }

        // Show online duration for all ONU types (both Blue and Red UI support this)
        if (onlineDurationContainer) {
            onlineDurationContainer.style.display = 'block';
        }
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