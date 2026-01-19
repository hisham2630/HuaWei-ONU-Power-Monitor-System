const axios = require('axios');

/**
 * Tenda ONU Monitoring Module
 * Handles authentication and data extraction from Tenda ONU devices
 * 
 * Tenda ONUs have a simpler web interface compared to Huawei:
 * - Status page: /status.asp (shows uptime, WAN configuration)
 * - PON Status page: /status_pon.asp (shows optical power, temperature)
 * - Simple HTTP Basic Auth with admin/admin credentials
 * - No LAN port speed information available
 */

/**
 * Login to Tenda ONU device using HTTP Basic Auth
 * Tenda uses a simpler authentication compared to Huawei
 */
async function loginTenda(host, username, password) {
    const apiClient = axios.create({
        baseURL: `http://${host}`,
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
        auth: {
            username: username,
            password: password
        },
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    try {
        // Test authentication by accessing the status page
        const response = await apiClient.get('/status.asp');

        if (response.status === 401) {
            return {
                success: false,
                error: 'Authentication failed'
            };
        }

        if (response.status === 200 && response.data) {
            return {
                success: true,
                apiClient: apiClient
            };
        }

        return {
            success: false,
            error: 'Unexpected response'
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Extract PON optical power data from Tenda status_pon.asp page
 * The page contains a simple HTML table with the optical metrics
 */
async function getTendaPonStatus(apiClient) {
    try {
        const response = await apiClient.get('/status_pon.asp');

        if (response.status !== 200) {
            throw new Error('Failed to access PON status page');
        }

        const html = response.data;

        // Extract values from the HTML table structure:
        // <tr><th width="40%">Rx Power</th><td width="60%">-20.655015 dBm</td></tr>

        // Extract Tx Power
        const txPowerMatch = html.match(/<th[^>]*>\s*Tx\s*Power\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*dBm/i);
        const txPower = txPowerMatch ? txPowerMatch[1].trim() : 'N/A';

        // Extract Rx Power
        const rxPowerMatch = html.match(/<th[^>]*>\s*Rx\s*Power\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*dBm/i);
        const rxPower = rxPowerMatch ? rxPowerMatch[1].trim() : 'N/A';

        // Extract Temperature
        const tempMatch = html.match(/<th[^>]*>\s*Temperature\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*C/i);
        const temperature = tempMatch ? tempMatch[1].trim() : 'N/A';

        // Extract Voltage
        const voltageMatch = html.match(/<th[^>]*>\s*Voltage\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*V/i);
        const voltage = voltageMatch ? voltageMatch[1].trim() : 'N/A';

        // Extract Bias Current
        const biasMatch = html.match(/<th[^>]*>\s*Bias\s*Current\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*mA/i);
        const biasCurrent = biasMatch ? biasMatch[1].trim() : 'N/A';

        // Extract ONU State (e.g., O5)
        const stateMatch = html.match(/<th[^>]*>\s*ONU\s*State\s*<\/th>\s*<td[^>]*>\s*(\w+)/i);
        const onuState = stateMatch ? stateMatch[1].trim() : 'N/A';

        // Extract Vendor
        const vendorMatch = html.match(/<th[^>]*>\s*Vendor\s*Name\s*<\/th>\s*<td[^>]*>\s*(\w+)/i);
        const vendor = vendorMatch ? vendorMatch[1].trim() : 'Tenda';

        return {
            rxPower: rxPower,
            txPower: txPower,
            temperature: temperature,
            voltage: voltage,
            biasCurrent: biasCurrent,
            onuState: onuState,
            vendor: vendor
        };
    } catch (error) {
        throw new Error(`Failed to get PON status: ${error.message}`);
    }
}

/**
 * Extract WAN online duration from Tenda status.asp page
 * The format is: "up 5days,19:35:56 / 5days,19:35:56"
 */
async function getTendaOnlineDuration(apiClient) {
    try {
        const response = await apiClient.get('/status.asp');

        if (response.status !== 200) {
            throw new Error('Failed to access status page');
        }

        const html = response.data;

        // Extract uptime from WAN Configuration table
        // Format: "up 5days,19:35:56 / 5days,19:35:56"
        // We want to parse the first duration
        const uptimeMatch = html.match(/up\s+(\d+)days?,\s*(\d{1,2}):(\d{2}):(\d{2})/i);

        if (uptimeMatch) {
            const days = parseInt(uptimeMatch[1]) || 0;
            const hours = parseInt(uptimeMatch[2]) || 0;
            const minutes = parseInt(uptimeMatch[3]) || 0;
            const seconds = parseInt(uptimeMatch[4]) || 0;

            const totalSeconds = (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;

            // Format as "XXD hh:mm:ss" to match Huawei format
            const formatted = `${days.toString().padStart(2, '0')}D ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

            return {
                uptimeSeconds: totalSeconds,
                formatted: formatted,
                days: days,
                hours: hours,
                minutes: minutes,
                seconds: seconds
            };
        }

        // Fallback: try to extract from System Uptime (format: "5 days, 19:35")
        const systemUptimeMatch = html.match(/Uptime\s*<\/th>\s*<td[^>]*>\s*(\d+)\s*days?,\s*(\d{1,2}):(\d{2})/i);

        if (systemUptimeMatch) {
            const days = parseInt(systemUptimeMatch[1]) || 0;
            const hours = parseInt(systemUptimeMatch[2]) || 0;
            const minutes = parseInt(systemUptimeMatch[3]) || 0;
            const seconds = 0;

            const totalSeconds = (days * 86400) + (hours * 3600) + (minutes * 60);

            const formatted = `${days.toString().padStart(2, '0')}D ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

            return {
                uptimeSeconds: totalSeconds,
                formatted: formatted,
                days: days,
                hours: hours,
                minutes: minutes,
                seconds: seconds
            };
        }

        return null;
    } catch (error) {
        console.warn('Error fetching Tenda online duration:', error.message);
        return null;
    }
}

/**
 * Monitor Tenda ONU device - Main entry point
 * @param {Object} deviceConfig - Device configuration object
 * @param {boolean} includeOnlineDuration - Whether to fetch WAN online duration
 */
async function monitorTendaONU(deviceConfig, includeOnlineDuration = false) {
    try {
        const { host, username, password } = deviceConfig;

        // Login
        const loginResult = await loginTenda(host, username, password);

        if (!loginResult.success) {
            return {
                success: false,
                error: loginResult.error || 'Login failed'
            };
        }

        // Get PON optical power data
        const ponData = await getTendaPonStatus(loginResult.apiClient);

        // Format data to match expected structure from Huawei monitor
        const data = {
            currentValue: `${ponData.rxPower} dBm`,
            referenceValue: '-27 to -8 dBm', // Standard GPON range
            txPower: `${ponData.txPower} dBm`,
            temperature: `${ponData.temperature} ℃`,
            temperatureRange: '-10 to +85 ℃',
            voltage: `${parseFloat(ponData.voltage) * 1000} mV`, // Convert V to mV to match Huawei format
            uiType: 'tenda',
            onuState: ponData.onuState,
            vendor: ponData.vendor
        };

        // Get WAN online duration if requested
        if (includeOnlineDuration) {
            try {
                const onlineDuration = await getTendaOnlineDuration(loginResult.apiClient);
                if (onlineDuration) {
                    data.onlineDuration = onlineDuration;
                }
            } catch (error) {
                // Don't fail the entire operation if online duration can't be fetched
                console.warn('Failed to fetch Tenda online duration:', error.message);
            }
        }

        return {
            success: true,
            data: data
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Check Tenda ONU connectivity
 */
async function checkTendaConnectivity(host) {
    try {
        const response = await axios.get(`http://${host}/`, {
            timeout: 5000,
            validateStatus: (status) => status < 500
        });
        // Tenda returns 401 if not authenticated, which means it's reachable
        return response.status === 200 || response.status === 401;
    } catch (error) {
        return false;
    }
}

module.exports = {
    monitorTendaONU,
    checkTendaConnectivity,
    loginTenda,
    getTendaPonStatus,
    getTendaOnlineDuration
};
