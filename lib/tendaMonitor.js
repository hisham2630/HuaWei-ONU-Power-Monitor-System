const net = require('net');
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
 * - Server: Boa/0.93.15 — single-tasking, HTTP/1.0, one connection at a time
 */

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REQUEST_GAP_MS = 300;
const RETRY_ATTEMPTS = 5;

const hostLocks = new Map();

function parseHost(host) {
    if (host.includes(':')) {
        const [hostname, portStr] = host.split(':');
        return { hostname, port: parseInt(portStr, 10) || 80 };
    }
    return { hostname: host, port: 80 };
}

async function withHostLock(host, fn) {
    const previous = hostLocks.get(host) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });

    hostLocks.set(host, previous.then(() => gate));

    await previous;
    try {
        return await fn();
    } finally {
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

async function requestWithRetry(requestFn, attempts = RETRY_ATTEMPTS) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await requestFn();
        } catch (error) {
            lastError = error;
            if (!isRetryableError(error) || attempt === attempts) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        }
    }

    throw lastError;
}

function parseHttpResponse(buffer) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
        throw new Error('Invalid HTTP response');
    }

    const headerSection = buffer.slice(0, headerEnd).toString('latin1');
    const body = buffer.slice(headerEnd + 4).toString('utf8');
    const lines = headerSection.split('\r\n');
    const statusMatch = lines[0].match(/HTTP\/\d(?:\.\d)?\s+(\d+)/i);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    const headers = {};
    const setCookies = {};

    for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(':');
        if (colon <= 0) {
            continue;
        }

        const name = lines[i].slice(0, colon).trim().toLowerCase();
        const value = lines[i].slice(colon + 1).trim();
        headers[name] = value;

        if (name === 'set-cookie') {
            const pair = value.split(';')[0];
            const separator = pair.indexOf('=');
            if (separator > 0) {
                setCookies[pair.slice(0, separator)] = pair.slice(separator + 1);
            }
        }
    }

    return { status, headers, body, setCookies };
}

function boaRawRequest(host, method, path, options = {}) {
    const { hostname, port } = parseHost(host);
    const {
        cookies = {},
        body = null,
        referer = `http://${host}/`,
        contentType = null,
        timeout = 15000
    } = options;

    return new Promise((resolve, reject) => {
        const bodyBuffer = body ? Buffer.from(body, 'utf8') : null;
        const headerLines = [
            `${method} ${path} HTTP/1.0`,
            `Host: ${host.includes(':') ? host : hostname}`,
            `User-Agent: ${DEFAULT_USER_AGENT}`,
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Connection: close'
        ];

        const cookieHeader = Object.entries(cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');

        if (cookieHeader) {
            headerLines.push(`Cookie: ${cookieHeader}`);
        }
        if (referer) {
            headerLines.push(`Referer: ${referer}`);
        }
        if (bodyBuffer) {
            headerLines.push(`Content-Type: ${contentType || 'application/x-www-form-urlencoded'}`);
            headerLines.push(`Content-Length: ${bodyBuffer.length}`);
        }

        const requestBuffer = Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`, 'latin1');
        const chunks = [];
        let settled = false;

        const socket = net.createConnection({ host: hostname, port }, () => {
            socket.write(requestBuffer);
            if (bodyBuffer) {
                socket.write(bodyBuffer);
            }
        });

        const finish = (error, result) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        };

        socket.setTimeout(timeout);
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('timeout', () => finish(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })));
        socket.on('error', (error) => finish(error));
        socket.on('end', () => {
            try {
                finish(null, parseHttpResponse(Buffer.concat(chunks)));
            } catch (error) {
                finish(error);
            }
        });
        socket.on('close', () => {
            if (!settled && chunks.length > 0) {
                try {
                    finish(null, parseHttpResponse(Buffer.concat(chunks)));
                } catch (error) {
                    finish(error);
                }
            } else if (!settled) {
                finish(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
            }
        });
    });
}

class BoaClient {
    constructor(host) {
        this.host = host;
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

        const response = await requestWithRetry(() => boaRawRequest(this.host, method, path, {
            cookies: this.cookies,
            body: options.body || null,
            referer: options.referer,
            contentType: options.contentType,
            timeout: options.timeout
        }));

        Object.assign(this.cookies, response.setCookies);

        if (response.status >= 500) {
            const error = new Error(`Request failed with status code ${response.status}`);
            error.response = { status: response.status, data: response.body };
            throw error;
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
    const client = new BoaClient(host);

    const loginPage = await client.get('/admin/login.asp', {
        referer: `http://${host}/admin/login.asp`
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
        timezone: timezoneMatch ? timezoneMatch[1] : '',
        dst_enabled: dstMatch ? dstMatch[1] : '',
        save: 'Login',
        'submit-url': '/admin/login.asp'
    };

    const loginBody = querystring.stringify({
        ...loginFields,
        postSecurityFlag: computePostSecurityFlag(loginFields)
    });

    const loginResponse = await client.post('/boaform/admin/formLogin', loginBody, {
        referer: `http://${host}/admin/login.asp`
    });

    if (/authentication error/i.test(loginResponse.body)) {
        return {
            success: false,
            error: 'Authentication failed'
        };
    }

    const ponPage = await client.get('/status_pon.asp', {
        referer: `http://${host}/`
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
        return {
            success: false,
            error: error.message
        };
    }
}

async function getTendaPonStatus(client, host, cachedHtml = null) {
    try {
        const html = cachedHtml || (await client.get('/status_pon.asp', {
            referer: `http://${host}/`
        })).body;

        return parsePonStatusHtml(html);
    } catch (error) {
        throw new Error(`Failed to get PON status: ${error.message}`);
    }
}

async function getTendaOnlineDuration(client, host) {
    try {
        const response = await client.get('/status.asp', {
            referer: `http://${host}/`
        });

        if (response.status !== 200) {
            throw new Error('Failed to access status page');
        }

        const html = response.body;
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

async function monitorTendaONU(deviceConfig, includeOnlineDuration = false) {
    const { host, username, password } = deviceConfig;

    return withHostLock(host, async () => {
        try {
            const loginResult = await loginTendaInternal(host, username, password);

            if (!loginResult.success) {
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
            const response = await requestWithRetry(() => boaRawRequest(host, 'GET', '/admin/login.asp', {
                referer: `http://${host}/`,
                timeout: 5000
            }));

            return response.status === 200;
        } catch (error) {
            return false;
        }
    });
}

module.exports = {
    monitorTendaONU,
    checkTendaConnectivity,
    loginTenda,
    getTendaPonStatus,
    getTendaOnlineDuration
};
