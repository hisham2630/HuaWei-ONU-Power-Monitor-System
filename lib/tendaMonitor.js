const http = require('http');

/**
 * Tenda ONU Monitoring Module
 * Handles authentication and data extraction from Tenda ONU devices
 *
 * Tenda HG1/xPON ONUs use Realtek/Boa firmware:
 * - Login page: /admin/login.asp
 * - Login POST: /boaform/admin/formLogin (with postSecurityFlag checksum)
 * - PON Status page: /status_pon.asp
 * - Device status page: /status.asp
 * - Server: Boa/0.93.15 — single-tasking, one connection at a time
 */

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_GAP_MS = 400;
const SESSION_COOLDOWN_MS = 1200;
const RETRY_ATTEMPTS = 5;

const hostLocks = new Map();

function normalizeHost(host) {
    let value = String(host || '').trim();
    value = value.replace(/^https?:\/\//i, '');
    value = value.split('/')[0];
    if (value.endsWith(':80')) {
        value = value.slice(0, -4);
    }
    return value;
}

function parseHost(host) {
    const normalized = normalizeHost(host);
    if (normalized.includes(':')) {
        const [hostname, portStr] = normalized.split(':');
        return { hostname, port: parseInt(portStr, 10) || 80 };
    }
    return { hostname: normalized, port: 80 };
}

function buildHostHeader(host) {
    const { hostname, port } = parseHost(host);
    return port === 80 ? hostname : `${hostname}:${port}`;
}

function logTenda(host, message) {
    console.warn(`[Tenda ${normalizeHost(host)}] ${message}`);
}

async function withHostLock(host, fn) {
    const lockKey = normalizeHost(host);
    const previous = hostLocks.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });

    hostLocks.set(lockKey, previous.then(() => gate));

    await previous;
    try {
        return await fn();
    } finally {
        await new Promise((resolve) => setTimeout(resolve, SESSION_COOLDOWN_MS));
        release();
    }
}

function isRetryableError(error) {
    const message = error && error.message ? error.message : '';
    if (message.includes('Parse Error') || message.includes('Expected HTTP/') || message.includes('Invalid HTTP response')) {
        return true;
    }

    const status = error && error.response && error.response.status;
    if (status >= 500 && status < 600) {
        return true;
    }

    const code = error && error.code;
    return code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED';
}

function createHttpError(status, body, step) {
    const error = new Error(step
        ? `Tenda ${step} failed (HTTP ${status})`
        : `Request failed with status code ${status}`);
    error.response = { status, data: body };
    return error;
}

async function requestWithRetry(requestFn, attempts = RETRY_ATTEMPTS, context = '') {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            lastError = error;
            const status = error && error.response && error.response.status;
            if (context && status) {
                logTenda(context, `retry ${attempt}/${attempts} after HTTP ${status}: ${error.message}`);
            }

            if (!isRetryableError(error) || attempt === attempts) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
        }
    }

    throw lastError;
}

function parseSetCookies(headers) {
    const cookies = {};
    const raw = headers['set-cookie'];
    if (!raw) {
        return cookies;
    }

    const values = Array.isArray(raw) ? raw : [raw];
    for (const cookie of values) {
        const pair = cookie.split(';')[0];
        const separator = pair.indexOf('=');
        if (separator > 0) {
            cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
        }
    }

    return cookies;
}

function boaHttpRequest(host, method, path, options = {}) {
    const { hostname, port } = parseHost(host);
    const {
        cookies = {},
        body = null,
        referer = `http://${buildHostHeader(host)}/`,
        contentType = null,
        timeout = 15000
    } = options;

    return new Promise((resolve, reject) => {
        const headers = {
            Host: buildHostHeader(host),
            'User-Agent': DEFAULT_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Connection: 'close'
        };

        const cookieHeader = Object.entries(cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');

        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }
        if (referer) {
            headers.Referer = referer;
        }
        if (body) {
            headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded';
            headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
        }

        const req = http.request({
            host: hostname,
            port,
            method,
            path,
            headers,
            timeout
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                    setCookies: parseSetCookies(res.headers)
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
        });
        req.on('error', reject);

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

class BoaClient {
    constructor(host) {
        this.host = normalizeHost(host);
        this.cookies = {};
        this.lastRequestAt = 0;
    }

    async waitGap() {
        const elapsed = Date.now() - this.lastRequestAt;
        if (elapsed < REQUEST_GAP_MS) {
            await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS - elapsed));
        }
        this.lastRequestAt = Date.now();
    }

    async request(method, path, options = {}) {
        await this.waitGap();

        const step = options.step || `${method} ${path}`;
        const response = await requestWithRetry(
            () => boaHttpRequest(this.host, method, path, {
                cookies: this.cookies,
                body: options.body || null,
                referer: options.referer,
                contentType: options.contentType,
                timeout: options.timeout
            }),
            RETRY_ATTEMPTS,
            this.host
        );

        Object.assign(this.cookies, response.setCookies);

        if (response.status >= 500) {
            logTenda(this.host, `${step} returned HTTP ${response.status}`);
            throw createHttpError(response.status, response.body, step);
        }

        return response;
    }

    async get(path, options = {}) {
        return this.request('GET', path, options);
    }

    async post(path, body, options = {}) {
        return this.request('POST', path, {
            ...options,
            body,
            contentType: 'application/x-www-form-urlencoded'
        });
    }
}

function encodeFormField(name, value) {
    const encodedName = name.replace(/\[/g, '%5B').replace(/\]/g, '%5D');
    const encodedValue = encodeURIComponent(String(value))
        .replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/~/g, '%7E')
        .replace(/%20/g, '+');

    return `${encodedName}=${encodedValue}&`;
}

function buildBoaFormBody(fields) {
    let body = '';
    for (const [name, value] of Object.entries(fields)) {
        body += encodeFormField(name, value);
    }
    return body;
}

function computePostSecurityFlag(fields) {
    const inputVal = buildBoaFormBody(fields);

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

function parsePonStatusHtml(html) {
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
}

async function loginTendaInternal(host, username, password) {
    const normalizedHost = normalizeHost(host);
    const client = new BoaClient(normalizedHost);
    const refererRoot = `http://${buildHostHeader(normalizedHost)}/`;
    const refererLogin = `${refererRoot}admin/login.asp`;

    const loginPage = await client.get('/admin/login.asp', {
        referer: refererLogin,
        step: 'load login page'
    });

    if (loginPage.status !== 200) {
        return {
            success: false,
            error: `Failed to load login page (HTTP ${loginPage.status})`
        };
    }

    const timezoneMatch = loginPage.body.match(/name="timezone"[^>]*value="([^"]*)"/i);
    const dstMatch = loginPage.body.match(/name="dst_enabled"[^>]*value="([^"]*)"/i);

    const loginFields = {
        username,
        password,
        save: 'Login',
        'submit-url': '/admin/login.asp'
    };

    if (timezoneMatch) {
        loginFields.timezone = timezoneMatch[1];
    }
    if (dstMatch) {
        loginFields.dst_enabled = dstMatch[1];
    }

    const securityFlag = computePostSecurityFlag(loginFields);
    const loginBody = `${buildBoaFormBody(loginFields)}postSecurityFlag=${securityFlag}`;

    const loginResponse = await client.post('/boaform/admin/formLogin', loginBody, {
        referer: refererLogin,
        step: 'submit login form'
    });

    if (/authentication error/i.test(loginResponse.body)) {
        return {
            success: false,
            error: 'Authentication failed'
        };
    }

    const ponPage = await client.get('/status_pon.asp', {
        referer: refererRoot,
        step: 'read PON status'
    });

    if (ponPage.status !== 200) {
        return {
            success: false,
            error: `Failed to access PON status page (HTTP ${ponPage.status})`
        };
    }

    const hasPonData = /Rx\s*Power/i.test(ponPage.body)
        && !/N\/A\s*dBm/i.test(ponPage.body);

    if (!hasPonData) {
        return {
            success: false,
            error: 'Login succeeded but PON status is unavailable'
        };
    }

    return {
        success: true,
        client,
        ponHtml: ponPage.body
    };
}

async function loginTenda(host, username, password) {
    try {
        return await withHostLock(host, () => loginTendaInternal(host, username, password));
    } catch (error) {
        logTenda(host, `login failed: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

async function getTendaPonStatus(client, host, cachedHtml = null) {
    try {
        const html = cachedHtml || (await client.get('/status_pon.asp', {
            referer: `http://${buildHostHeader(host)}/`,
            step: 'fetch PON status'
        })).body;

        return parsePonStatusHtml(html);
    } catch (error) {
        throw new Error(`Failed to get PON status: ${error.message}`);
    }
}

function formatTendaUptime(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
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

function parseTendaDurationParts(days, hours, minutes, seconds) {
    const totalSeconds = ((parseInt(days, 10) || 0) * 86400)
        + ((parseInt(hours, 10) || 0) * 3600)
        + ((parseInt(minutes, 10) || 0) * 60)
        + (parseInt(seconds, 10) || 0);

    if (totalSeconds <= 0) {
        return null;
    }

    return formatTendaUptime(totalSeconds);
}

function parseTendaTimeSegment(segment) {
    const normalized = String(segment || '').trim();
    const withDays = normalized.match(/(?:(\d+)\s*days?,?\s*)?(\d{1,2}):(\d{2}):(\d{2})/i);
    if (withDays) {
        return parseTendaDurationParts(withDays[1], withDays[2], withDays[3], withDays[4]);
    }

    const minutesOnly = normalized.match(/^(\d+)\s*min(?:ute)?s?$/i);
    if (minutesOnly) {
        return parseTendaDurationParts(0, 0, minutesOnly[1], 0);
    }

    const hoursOnly = normalized.match(/^(\d+)\s*hr(?:s|ours?)?$/i);
    if (hoursOnly) {
        return parseTendaDurationParts(0, hoursOnly[1], 0, 0);
    }

    const daysAndClock = normalized.match(/^(\d+)\s*days?,\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/i);
    if (daysAndClock) {
        return parseTendaDurationParts(daysAndClock[1], daysAndClock[2], daysAndClock[3], daysAndClock[4] || 0);
    }

    return null;
}

function parseTendaOnlineDurationFromHtml(html) {
    const wanSectionMatch = html.match(/WAN(?:&nbsp;|\s)*Configuration[\s\S]*?<\/table>/i);
    const wanSection = wanSectionMatch ? wanSectionMatch[0] : html;

    // WAN Configuration status cell: "up 00:05:02 / 00:23:37" (second value is session uptime)
    const wanStatusMatch = wanSection.match(/<font size=2>\s*(up|down)\s*([\s\S]*?)<\/td>/i);
    if (wanStatusMatch) {
        const wanState = wanStatusMatch[1].toLowerCase();
        const wanStatusBody = wanStatusMatch[2].replace(/\s+/g, ' ').trim();

        if (wanState === 'down') {
            return null;
        }

        const wanUptimeParts = wanStatusBody.split('/').map((part) => part.trim());
        if (wanUptimeParts.length >= 2) {
            const parsedWanUptime = parseTendaTimeSegment(wanUptimeParts[1]);
            if (parsedWanUptime) {
                return parsedWanUptime;
            }
        }

        const parsedInlineWanUptime = parseTendaTimeSegment(wanStatusBody.replace(/^up\s+/i, ''));
        if (parsedInlineWanUptime) {
            return parsedInlineWanUptime;
        }
    }

    const uptimeMatch = html.match(/up\s+(\d+)days?,\s*(\d{1,2}):(\d{2}):(\d{2})/i);
    if (uptimeMatch) {
        return parseTendaDurationParts(uptimeMatch[1], uptimeMatch[2], uptimeMatch[3], uptimeMatch[4]);
    }

    const systemUptimeMatch = html.match(/Uptime\s*<\/th>\s*<td[^>]*>\s*([^<]+)</i);
    if (systemUptimeMatch) {
        return parseTendaTimeSegment(systemUptimeMatch[1]);
    }

    return null;
}

async function getTendaOnlineDuration(client, host) {
    try {
        const response = await client.get('/status.asp', {
            referer: `http://${buildHostHeader(host)}/`,
            step: 'fetch online duration'
        });

        if (response.status !== 200) {
            throw new Error('Failed to access status page');
        }

        return parseTendaOnlineDurationFromHtml(response.body);
    } catch (error) {
        console.warn('Error fetching Tenda online duration:', error.message);
        return null;
    }
}

async function monitorTendaONU(deviceConfig, includeOnlineDuration = false) {
    const { host, username, password } = deviceConfig;

    return withHostLock(host, async () => {
        try {
            const loginResult = await loginTendaInternal(host, username, password);

            if (!loginResult.success) {
                logTenda(host, `monitor failed: ${loginResult.error}`);
                return {
                    success: false,
                    error: loginResult.error || 'Login failed'
                };
            }

            const ponData = await getTendaPonStatus(loginResult.client, host, loginResult.ponHtml);

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
                const onlineDuration = await getTendaOnlineDuration(loginResult.client, host);
                if (onlineDuration) {
                    data.onlineDuration = onlineDuration;
                }
            }

            return {
                success: true,
                data
            };
        } catch (error) {
            logTenda(host, `monitor failed: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    });
}

async function checkTendaConnectivity(host) {
    return withHostLock(host, async () => {
        try {
            const response = await requestWithRetry(
                () => boaHttpRequest(host, 'GET', '/admin/login.asp', {
                    referer: `http://${buildHostHeader(host)}/`,
                    timeout: 5000
                }),
                3,
                normalizeHost(host)
            );

            return response.status === 200;
        } catch (error) {
            logTenda(host, `connectivity check failed: ${error.message}`);
            return false;
        }
    });
}

module.exports = {
    monitorTendaONU,
    checkTendaConnectivity,
    loginTenda,
    getTendaPonStatus,
    getTendaOnlineDuration,
    parseTendaOnlineDurationFromHtml
};
