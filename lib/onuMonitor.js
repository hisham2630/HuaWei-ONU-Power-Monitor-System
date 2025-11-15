const axios = require('axios');

/**
 * ONU Monitoring Module
 * Handles authentication and data extraction from Huawei ONU devices
 */

/**
 * Base64 encode function
 */
function base64encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * Parse cookies from Set-Cookie headers
 */
function parseCookies(setCookieHeaders) {
  const cookies = {};
  if (!setCookieHeaders) return cookies;
  
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  headers.forEach(cookie => {
    const parts = cookie.split(';')[0].split('=');
    if (parts.length === 2) {
      cookies[parts[0]] = parts[1];
    }
  });
  return cookies;
}

/**
 * Extract CSRF token from HTML
 */
function extractToken(html) {
  const match = html.match(/function GetRandCnt\(\)\s*{\s*return\s*'([^']+)'/i);
  return match ? match[1] : '';
}

/**
 * Decode hex-encoded strings (Blue UI)
 */
function decodeHexString(str) {
  return str.replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

/**
 * Detect UI type based on data format
 */
function detectUIType(value) {
  return value.includes('\\x') ? 'blue' : 'red';
}

/**
 * Extract opticInfo from JavaScript
 */
function extractOpticInfo(html) {
  const pattern = /var\s+opticInfos\s*=\s*new\s+Array\(new\s+stOpticInfo\(([^)]+)\)/i;
  const match = html.match(pattern);
  
  if (!match) return null;
  
  const params = match[1];
  const valuePattern = /"([^"]*)"/g;
  const values = [];
  let valueMatch;
  
  while ((valueMatch = valuePattern.exec(params)) !== null) {
    values.push(valueMatch[1]);
  }
  
  if (values.length < 5) return null;
  
  const txRaw = values[1];
  const rxRaw = values[2];
  const voltageRaw = values[3];
  const temperatureRaw = values[4];
  const uiType = detectUIType(rxRaw);
  
  const txPower = uiType === 'blue' ? decodeHexString(txRaw).trim() : txRaw.trim();
  const rxPower = uiType === 'blue' ? decodeHexString(rxRaw).trim() : rxRaw.trim();
  const voltage = uiType === 'blue' ? decodeHexString(voltageRaw).trim() : voltageRaw.trim();
  const temperature = uiType === 'blue' ? decodeHexString(temperatureRaw).trim() : temperatureRaw.trim();
  
  return {
    txPower: txPower,
    rxPower: rxPower,
    voltage: voltage,
    temperature: temperature,
    uiType: uiType
  };
}

/**
 * Extract reference range
 */
function extractReferenceRange(html) {
  const ponModeMatch = html.match(/var\s+ontPonMode\s*=\s*'([^']+)'/i);
  const ponMode = ponModeMatch ? ponModeMatch[1] : 'gpon';
  
  if (ponMode.toLowerCase().includes('gpon')) {
    return '-27 to -8 dBm';
  } else if (ponMode.toLowerCase().includes('epon')) {
    return '-24 to -7 dBm';
  }
  
  return '-27 to -8 dBm';
}

/**
 * Extract temperature reference range
 */
function extractTemperatureRange(html) {
  // Standard range for both GPON and EPON is -10 to +85 ℃
  return '-10 to +85 ℃';
}

/**
 * Login to ONU device
 */
async function login(host, username, password) {
  const apiClient = axios.create({
    baseURL: `http://${host}`,
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500
  });

  let sessionCookies = {};
  
  // Get login page
  const loginPageResponse = await apiClient.get('/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  if (loginPageResponse.headers['set-cookie']) {
    sessionCookies = parseCookies(loginPageResponse.headers['set-cookie']);
  }
  
  // Extract CSRF token
  let csrfToken = extractToken(loginPageResponse.data);
  
  // Try AJAX endpoint if not found (Red UI)
  if (!csrfToken) {
    try {
      const tokenResponse = await apiClient.post('/asp/GetRandCount.asp', '', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      if (tokenResponse.data) {
        csrfToken = tokenResponse.data.toString().trim();
      }
    } catch (e) {
      // Ignore AJAX error
    }
  }
  
  const preCookie = 'Cookie=body:Language:english:id=-1';
  const loginData = new URLSearchParams();
  loginData.append('UserName', username);
  loginData.append('PassWord', base64encode(password));
  if (csrfToken) {
    loginData.append('x.X_HW_Token', csrfToken);
  }
  
  const loginHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': preCookie,
    'Referer': `http://${host}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };
  
  const loginResponse = await apiClient.post('/login.cgi', loginData.toString(), {
    headers: loginHeaders
  });
  
  if (loginResponse.headers['set-cookie']) {
    const setCookies = loginResponse.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookies) ? setCookies : [setCookies];
    
    for (const cookie of cookieHeader) {
      if (cookie.startsWith('Cookie=')) {
        const cookieValue = cookie.split(';')[0];
        sessionCookies['Cookie'] = cookieValue.replace('Cookie=', '');
        
        if (sessionCookies['Cookie'].includes('sid=')) {
          return { success: true, cookies: sessionCookies, apiClient: apiClient };
        }
      }
    }
  }
  
  return { success: true, cookies: sessionCookies, apiClient: apiClient };
}

/**
 * Get RX Optical Power and Temperature
 */
async function getRxOpticalPower(apiClient, sessionCookies, host) {
  const headers = {
    'Cookie': Object.entries(sessionCookies).map(([k, v]) => `${k}=${v}`).join('; '),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': `http://${host}/index.asp`
  };
  
  const response = await apiClient.get('/html/amp/opticinfo/opticinfo.asp', { 
    headers: headers
  });
  
  if (response.status !== 200) {
    throw new Error('Failed to access optical information page');
  }
  
  const html = response.data;
  
  if (html.includes('Waiting...') || html.length < 100) {
    throw new Error('Session expired or not authenticated');
  }
  
  const opticInfo = extractOpticInfo(html);
  
  if (!opticInfo) {
    throw new Error('Failed to extract optical information');
  }
  
  const referenceRange = extractReferenceRange(html);
  const tempRange = extractTemperatureRange(html);
  
  return {
    currentValue: `${opticInfo.rxPower} dBm`,
    referenceValue: referenceRange,
    txPower: `${opticInfo.txPower} dBm`,
    temperature: `${opticInfo.temperature} ℃`,
    temperatureRange: tempRange,
    voltage: `${opticInfo.voltage} mV`,
    uiType: opticInfo.uiType
  };
}

/**
 * Monitor ONU device - Main entry point
 */
async function monitorONU(deviceConfig) {
  try {
    const { host, username, password } = deviceConfig;
    
    // Login
    const loginResult = await login(host, username, password);
    
    if (!loginResult.success) {
      return {
        success: false,
        error: 'Login failed'
      };
    }
    
    // Get optical power data
    const data = await getRxOpticalPower(loginResult.apiClient, loginResult.cookies, host);
    
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
 * Check ONU connectivity
 */
async function checkConnectivity(host) {
  try {
    const response = await axios.get(`http://${host}/`, {
      timeout: 5000,
      validateStatus: (status) => status < 500
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

module.exports = {
  monitorONU,
  checkConnectivity
};
