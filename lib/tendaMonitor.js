const axios = require('axios');
const http = require('http');
const querystring = require('querystring');

/**
 * Tenda ONU Monitoring Module
 * Handles authentication and data extraction from Tenda ONU devices
 *
 * Tenda HG1/xPON ONUs use Realtek/Boa firmware:
 * - Login page: /admin/login.asp
 * - Login POST: /boaform/admin/formLogin (with postSecurityFlag checksum)
 * - PON Status page: /status_pon.asp
 * - Device status page: /status.asp
 * - Server: Boa/0.93.15 with HTTP/1.0 Connection: close
 */

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function isParseError(error) {
    const message = error && error.message ? error.message : '';
    return message.includes('Parse Error') || message.includes('Expected HTTP/');
}

function encodeFormField(name, value) {
    let encodedName = name.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    let encodedValue = encodeURIComponent(String(value))
        .replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/~/g, '%7E')
        .replace(/%20/g, '+');

    return `${encodedName}=${encodedValue}&`;
}

/**
 * Compute Boa postSecurityFlag checksum used by Realtek/Tenda web forms
 */
function computePostSecurityFlag(fields) {
    let inputVal = '';

    for (const [name, value] of Object.entries(fields)) {
        if (!name || name === 'postSecurityFlag' || name === 'csrftoken') {
            continue;
        }
        inputVal += encodeFormField(name, value);
    }

    let checksum = 0;
    let index = 0;

    while (index < inputVal.length) {
        if (index + 4 > inputVal.length) {
            if (index < inputVal.length) {
                checksum += (inputVal.charCodeAt(index) << 24);
            }
            if (index + 1 < inputVal.length) {
                checksum += (inputVal.charCodeAt(index + 1) << 16);
            }
            if (index + 2 < inputVal.length) {
                checksum += (inputVal.charCodeAt(index + 2) << 8);
            }
            break;
        }

        checksum += (inputVal.charCodeAt(index) << 24)
            + (inputVal.charCodeAt(index + 1) << 16)
            + (inputVal.charCodeAt(index + 2) << 8)
            + inputVal.charCodeAt(index + 3);
        index += 4;
    }

    checksum = (checksum & 0xffff) + (checksum >> 16);
    checksum = checksum & 0xffff;
    return (~checksum) & 0xffff;
}

function createTendaClient(host) {
    const cookieJar = {};
    const httpAgent = new http.Agent({ keepAlive: false });

    const apiClient = axios.create({
        baseURL: `http://${host}`,
        timeout: 15000,
        httpAgent,
        maxRedirects: 0,
        validateStatus: (status) => status < 500,
        headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Connection: 'close'
        }
    });

    apiClient.interceptors.response.use((response) => {
        const setCookie = response.headers['set-cookie'];
        if (!setCookie) {
            return response;
        }

        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const cookie of cookies) {
            const [pair] = cookie.split(';');
            const separator = pair.indexOf('=');
            if (separator > 0) {
                cookieJar[pair.slice(0, separator)] = pair.slice(separator + 1);
            }
        }

        return response;
    });

    apiClient.interceptors.request.use((config) => {
        const cookieHeader = Object.entries(cookieJar)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');

        if (cookieHeader) {
            config.headers.Cookie = cookieHeader;
        }

        return config;
    });

    return apiClient;
}

async function requestWithRetry(apiClient, requestFn, attempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            lastError = error;
            if (!isParseError(error) || attempt === attempts) {
                throw error;
            }

            // Boa can return malformed responses on the first connection attempt
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
    }

    throw lastError;
}

/**
 * Warm up the Boa web server before authenticated requests
 */
async function warmUpTendaWebServer(apiClient, host) {
    await requestWithRetry(apiClient, () => apiClient.get('/admin/login.asp', {
        headers: {
            Referer: `http://${host}/`
        }
    }));
}

/**
 * Login to Tenda ONU device using Boa form authentication
 */
async function loginTenda(host, username, password) {
    try {
        const apiClient = createTendaClient(host);

        await warmUpTendaWebServer(apiClient, host);

        const loginPage = await requestWithRetry(apiClient, () => apiClient.get('/admin/login.asp', {
            headers: {
                Referer: `http://${host}/admin/login.asp`
            }
        }));

        if (loginPage.status !== 200) {
            return {
                success: false,
                error: `Failed to load login page (HTTP ${loginPage.status})`
            };
        }

        const timezoneMatch = loginPage.data.match(/name="timezone"[^>]*value="([^"]*)"/i);
        const dstMatch = loginPage.data.match(/name="dst_enabled"[^>]*value="([^"]*)"/i);

        const loginFields = {
            username,
            password,
            timezone: timezoneMatch ? timezoneMatch[1] : '',
            dst_enabled: dstMatch ? dstMatch[1] : '',
            save: 'Login',
            'submit-url': '/admin/login.asp'
        };

        const loginBody = querystring.stringify({
            ...loginFields,
            postSecurityFlag: computePostSecurityFlag(loginFields)
        });

        const loginResponse = await requestWithRetry(apiClient, () => apiClient.post('/boaform/admin/formLogin', loginBody, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Referer: `http://${host}/admin/login.asp`
            }
        }));

        const loginHtml = String(loginResponse.data || '');
        const authFailed = /authentication error/i.test(loginHtml);

        if (authFailed) {
            return {
                success: false,
                error: 'Authentication failed'
            };
        }

        const homeResponse = await requestWithRetry(apiClient, () => apiClient.get('/', {
            headers: {
                Referer: `http://${host}/admin/login.asp`
            }
        }));

        const loggedIn = /logout|confirmlogout/i.test(String(homeResponse.data || ''));
        const ponProbe = await requestWithRetry(apiClient, () => apiClient.get('/status_pon.asp', {
            headers: {
                Referer: `http://${host}/`
            }
        }));

        const ponHtml = String(ponProbe.data || '');
        const hasPonData = /Rx\s*Power/i.test(ponHtml)
            && !/N\/A\s*dBm/i.test(ponHtml);

        if (!loggedIn && !hasPonData) {
            return {
                success: false,
                error: 'Login succeeded but PON status is unavailable'
            };
        }

        return {
            success: true,
            apiClient
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
 */
async function getTendaPonStatus(apiClient, host) {
    try {
        const response = await requestWithRetry(apiClient, () => apiClient.get('/status_pon.asp', {
            headers: {
                Referer: `http://${host}/`
            }
        }));

        if (response.status !== 200) {
            throw new Error('Failed to access PON status page');
        }

        const html = response.data;

        const txPowerMatch = html.match(/<th[^>]*>\s*Tx\s*Power\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*dBm/i);
        const txPower = txPowerMatch ? txPowerMatch[1].trim() : 'N/A';

        const rxPowerMatch = html.match(/<th[^>]*>\s*Rx\s*Power\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*dBm/i);
        const rxPower = rxPowerMatch ? rxPowerMatch[1].trim() : 'N/A';

        const tempMatch = html.match(/<th[^>]*>\s*Temperature\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*C/i);
        const temperature = tempMatch ? tempMatch[1].trim() : 'N/A';

        const voltageMatch = html.match(/<th[^>]*>\s*Voltage\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*V/i);
        const voltage = voltageMatch ? voltageMatch[1].trim() : 'N/A';

        const biasMatch = html.match(/<th[^>]*>\s*Bias\s*Current\s*<\/th>\s*<td[^>]*>\s*([-\d.]+)\s*mA/i);
        const biasCurrent = biasMatch ? biasMatch[1].trim() : 'N/A';

        const stateMatch = html.match(/<th[^>]*>\s*ONU\s*State\s*<\/th>\s*<td[^>]*>\s*(\w+)/i);
        const onuState = stateMatch ? stateMatch[1].trim() : 'N/A';

        const vendorMatch = html.match(/<th[^>]*>\s*Vendor\s*Name\s*<\/th>\s*<td[^>]*>\s*(\w+)/i);
        const vendor = vendorMatch ? vendorMatch[1].trim() : 'Tenda';

        if (rxPower === 'N/A') {
            throw new Error('PON status page did not contain Rx Power data');
        }

        return {
            rxPower,
            txPower,
            temperature,
            voltage,
            biasCurrent,
            onuState,
            vendor
        };
    } catch (error) {
        throw new Error(`Failed to get PON status: ${error.message}`);
    }
}

/**
 * Extract WAN online duration from Tenda status.asp page
 */
async function getTendaOnlineDuration(apiClient, host) {
    try {
        const response = await requestWithRetry(apiClient, () => apiClient.get('/status.asp', {
            headers: {
                Referer: `http://${host}/`
            }
        }));

        if (response.status !== 200) {
            throw new Error('Failed to access status page');
        }

        const html = response.data;
        const uptimeMatch = html.match(/up\s+(\d+)days?,\s*(\d{1,2}):(\d{2}):(\d{2})/i);

        if (uptimeMatch) {
            const days = parseInt(uptimeMatch[1], 10) || 0;
            const hours = parseInt(uptimeMatch[2], 10) || 0;
            const minutes = parseInt(uptimeMatch[3], 10) || 0;
            const seconds = parseInt(uptimeMatch[4], 10) || 0;
            const totalSeconds = (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
            const formatted = `${days.toString().padStart(2, '0')}D ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

            return {
                uptimeSeconds: totalSeconds,
                formatted,
                days,
                hours,
                minutes,
                seconds
            };
        }

        const systemUptimeMatch = html.match(/Uptime\s*<\/th>\s*<td[^>]*>\s*(\d+)\s*days?,\s*(\d{1,2}):(\d{2})/i);

        if (systemUptimeMatch) {
            const days = parseInt(systemUptimeMatch[1], 10) || 0;
            const hours = parseInt(systemUptimeMatch[2], 10) || 0;
            const minutes = parseInt(systemUptimeMatch[3], 10) || 0;
            const totalSeconds = (days * 86400) + (hours * 3600) + (minutes * 60);
            const formatted = `${days.toString().padStart(2, '0')}D ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`;

            return {
                uptimeSeconds: totalSeconds,
                formatted,
                days,
                hours,
                minutes,
                seconds: 0
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
 */
async function monitorTendaONU(deviceConfig, includeOnlineDuration = false) {
    try {
        const { host, username, password } = deviceConfig;
        const loginResult = await loginTenda(host, username, password);

        if (!loginResult.success) {
            return {
                success: false,
                error: loginResult.error || 'Login failed'
            };
        }

        const ponData = await getTendaPonStatus(loginResult.apiClient, host);

        const data = {
            currentValue: `${ponData.rxPower} dBm`,
            referenceValue: '-27 to -8 dBm',
            txPower: `${ponData.txPower} dBm`,
            temperature: `${ponData.temperature} ℃`,
            temperatureRange: '-10 to +85 ℃',
            voltage: `${parseFloat(ponData.voltage) * 1000} mV`,
            uiType: 'tenda',
            onuState: ponData.onuState,
            vendor: ponData.vendor
        };

        if (includeOnlineDuration) {
            const onlineDuration = await getTendaOnlineDuration(loginResult.apiClient, host);
            if (onlineDuration) {
                data.onlineDuration = onlineDuration;
            }
        }

        return {
            success: true,
            data
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
        const httpAgent = new http.Agent({ keepAlive: false });
        const response = await axios.get(`http://${host}/admin/login.asp`, {
            timeout: 5000,
            httpAgent,
            validateStatus: (status) => status < 500,
            headers: {
                'User-Agent': DEFAULT_USER_AGENT,
                Connection: 'close'
            }
        });

        return response.status === 200;
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
