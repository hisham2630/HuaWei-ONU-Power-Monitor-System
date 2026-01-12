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
 * Get WAN Online Duration (Blue UI only)
 * Fetches the IPv4 connection uptime from WAN Information page
 * The data is stored in /html/bbsp/common/wan_list.asp which is dynamically loaded
 * and uses WanPPP or WanIP constructors with Uptime at specific positions
 */
async function getWanOnlineDuration(apiClient, sessionCookies, host) {
  const headers = {
    'Cookie': Object.entries(sessionCookies).map(([k, v]) => `${k}=${v}`).join('; '),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': `http://${host}/html/bbsp/waninfo/waninfo.asp`
  };

  try {
    // First try to fetch wan_list.asp which contains the raw WAN data
    const wanListResponse = await apiClient.get('/html/bbsp/common/wan_list.asp', {
      headers: headers
    });

    let html = wanListResponse.data;

    // If wan_list.asp fails, fall back to the main waninfo page
    if (wanListResponse.status !== 200 || !html || html.length < 50) {
      const wanInfoResponse = await apiClient.get('/html/bbsp/waninfo/waninfo.asp', {
        headers: headers
      });

      if (wanInfoResponse.status !== 200) {
        console.warn('Failed to access WAN information page');
        return null;
      }

      html = wanInfoResponse.data;
    }

    if (html.includes('Waiting...') || html.length < 100) {
      console.warn('Session expired or not authenticated for WAN info');
      return null;
    }

    // Helper function to format uptime from seconds
    const formatUptime = (uptimeSeconds) => {
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      // Format as "XXD hh:mm:ss" for better readability
      const formatted = `${days.toString().padStart(2, '0')}D ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

      return {
        uptimeSeconds: uptimeSeconds,
        formatted: formatted,
        days: days,
        hours: hours,
        minutes: minutes,
        seconds: seconds
      };
    };

    // Try to extract from WanPPP constructor (PPPoE connections)
    // Uptime is at position 38 (0-indexed) in WanPPP constructor (44 total params)
    const wanPPPMatch = html.match(/new\s+WanPPP\s*\(([^;]+)\);/g);
    if (wanPPPMatch && wanPPPMatch.length > 0) {
      for (const wanEntry of wanPPPMatch) {
        // Extract all parameters (both quoted and numeric)
        const allParams = wanEntry.match(/new\s+WanPPP\s*\(([\s\S]+?)\);/);
        if (allParams && allParams[1]) {
          // Split by comma, handling quoted strings
          const params = [];
          let current = '';
          let inQuote = false;
          for (const char of allParams[1]) {
            if (char === '"' && (current.length === 0 || current[current.length - 1] !== '\\')) {
              inQuote = !inQuote;
              current += char;
            } else if (char === ',' && !inQuote) {
              params.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          if (current.trim()) {
            params.push(current.trim());
          }

          // Uptime is at position 38 for WanPPP
          if (params.length >= 39) {
            let uptimeStr = params[38];
            // Remove quotes if present
            uptimeStr = uptimeStr.replace(/"/g, '').trim();
            const uptimeSeconds = parseInt(uptimeStr);

            if (!isNaN(uptimeSeconds) && uptimeSeconds > 0) {
              return formatUptime(uptimeSeconds);
            }
          }
        }
      }
    }

    // Try to extract from WanIP constructor (IPoE/DHCP/Static connections)
    // Uptime is at position 41 (0-indexed) in WanIP constructor (48 total params)
    const wanIPMatch = html.match(/new\s+WanIP\s*\(([^;]+)\);/g);
    if (wanIPMatch && wanIPMatch.length > 0) {
      for (const wanEntry of wanIPMatch) {
        const allParams = wanEntry.match(/new\s+WanIP\s*\(([\s\S]+?)\);/);
        if (allParams && allParams[1]) {
          // Split by comma, handling quoted strings
          const params = [];
          let current = '';
          let inQuote = false;
          for (const char of allParams[1]) {
            if (char === '"' && (current.length === 0 || current[current.length - 1] !== '\\')) {
              inQuote = !inQuote;
              current += char;
            } else if (char === ',' && !inQuote) {
              params.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          if (current.trim()) {
            params.push(current.trim());
          }

          // Uptime is at position 41 for WanIP
          if (params.length >= 42) {
            let uptimeStr = params[41];
            // Remove quotes if present
            uptimeStr = uptimeStr.replace(/"/g, '').trim();
            const uptimeSeconds = parseInt(uptimeStr);

            if (!isNaN(uptimeSeconds) && uptimeSeconds > 0) {
              return formatUptime(uptimeSeconds);
            }
          }
        }
      }
    }

    // Fallback: Try to extract from visible HTML (V4UpTime element content)
    const v4UptimeMatch = html.match(/id=["']?V4UpTime["']?[^>]*>([^<]+)</);
    if (v4UptimeMatch && v4UptimeMatch[1]) {
      const uptimeFormatted = v4UptimeMatch[1].trim();
      // Parse dd:hh:mm:ss format
      const timeParts = uptimeFormatted.split(':');
      if (timeParts.length === 4) {
        const days = parseInt(timeParts[0]);
        const hours = parseInt(timeParts[1]);
        const minutes = parseInt(timeParts[2]);
        const seconds = parseInt(timeParts[3]);
        const totalSeconds = (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;

        return formatUptime(totalSeconds);
      }
    }

    console.warn('Could not extract WAN uptime from page');
    return null;

  } catch (error) {
    console.warn('Error fetching WAN online duration:', error.message);
    return null;
  }
}


/**
 * Extract Ethernet port speeds
 */
async function getEthernetPortSpeeds(apiClient, sessionCookies, host) {
  const headers = {
    'Cookie': Object.entries(sessionCookies).map(([k, v]) => `${k}=${v}`).join('; '),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': `http://${host}/index.asp`
  };

  // Navigate to the Eth Port Information page
  const response = await apiClient.get('/html/amp/ethinfo/ethinfo.asp', {
    headers: headers
  });

  if (response.status !== 200) {
    throw new Error('Failed to access Ethernet port information page');
  }

  const html = response.data;

  if (html.includes('Waiting...') || html.length < 100) {
    throw new Error('Session expired or not authenticated');
  }

  const portSpeeds = {};

  // Look for geInfos array specifically
  const geInfosIndex = html.indexOf('var geInfos');
  if (geInfosIndex !== -1) {
    const geInfosSnippet = html.substring(geInfosIndex, Math.min(geInfosIndex + 500, html.length));
  }

  // Check if this is Red UI (table-based) or Blue UI (JavaScript array-based)
  // Look for Red UI specific indicators
  const isRedUI = html.includes('Eth Port Information') && html.includes('var curLanguage');
  // Even for Red UI devices, we might need to parse geInfos array for port speeds
  // Check if geInfos array exists
  const hasGeInfos = html.includes('var geInfos');

  if (isRedUI && !hasGeInfos) {
    // True Red UI format - parse from HTML table
    // Pattern for ports with speed: row "1 Full-duplex 1000 Mbit/s Up 1294931125 1578515437 3696995311 3142134458"
    const speedPattern = /row\s+"(\d+)\s+[^\s]+\s+(\d+)\s*Mbit\/s\s+[^\s]+\s+\d+\s+\d+\s+\d+\s+\d+"/g;
    let speedMatch;
    while ((speedMatch = speedPattern.exec(html)) !== null) {
      const portNumber = speedMatch[1];
      const speedValue = parseInt(speedMatch[2]);
      portSpeeds[`eth${portNumber}-speed`] = speedValue;
    }

    // Pattern for ports without speed (--) - explicitly set to 0 to indicate disconnected
    const noSpeedPattern = /row\s+"(\d+)\s+[^\s]+\s+--\s+[^\s]+\s+\d+\s+\d+\s+\d+\s+\d+"/g;
    let noSpeedMatch;
    while ((noSpeedMatch = noSpeedPattern.exec(html)) !== null) {
      const portNumber = noSpeedMatch[1];
      portSpeeds[`eth${portNumber}-speed`] = 0; // 0 indicates disconnected port
    }

    // If no ports were found, try a more flexible pattern
    if (Object.keys(portSpeeds).length === 0) {
      // Try to find all ports first
      const portPattern = /row\s+"(\d+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/g;
      let portMatch;
      while ((portMatch = portPattern.exec(html)) !== null) {
        const portNumber = portMatch[1];
        const speedText = portMatch[3];

        // Only set the port speed if it hasn't already been set
        if (portSpeeds[`eth${portNumber}-speed`] === undefined) {
          if (speedText === '--') {
            portSpeeds[`eth${portNumber}-speed`] = 0; // 0 indicates disconnected port
          } else {
            const speedValue = parseInt(speedText);
            if (!isNaN(speedValue)) {
              portSpeeds[`eth${portNumber}-speed`] = speedValue;
            }
          }
        }
      }
    }

    // Try an even more general approach if we still haven't found ports correctly
    if (Object.keys(portSpeeds).length < 2) {
      // Look for any pattern that might indicate a disconnected port
      const generalPattern = /row\s+"(\d+)\s+[^\s]+\s+([^\s]+)\s+[^\s]+/g;
      let generalMatch;
      while ((generalMatch = generalPattern.exec(html)) !== null) {
        const portNumber = generalMatch[1];
        const speedIndicator = generalMatch[2];

        // If we haven't set this port yet and the speed indicator is --, mark as disconnected
        if (portSpeeds[`eth${portNumber}-speed`] === undefined && speedIndicator === '--') {
          portSpeeds[`eth${portNumber}-speed`] = 0;
        }
      }
    }
  } else {
    // Use Blue UI parsing approach (including for Red UI devices that use geInfos)
    if (hasGeInfos) {
      // Extract the geInfos array
      const geInfosMatch = html.match(/var\s+geInfos\s*=\s*new\s+Array\s*\(.*?\);/s);
      if (geInfosMatch && geInfosMatch[0]) {
        // Extract GEInfo objects from the array
        const geInfoObjects = geInfosMatch[0].match(/new\s+GEInfo\s*\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g);

        if (geInfoObjects) {
          // Process each GEInfo object
          for (let i = 0; i < geInfoObjects.length; i++) {
            // Extract all parameters from the GEInfo constructor
            // Based on actual Blue UI data, the GEInfo constructor parameters are:
            // GEInfo(domain, Mode, Speed, Status)
            // 1st: Identifier string (domain)
            // 2nd: Mode - Duplex mode (0 = Half-duplex, 1 = Full-duplex)
            // 3rd: Speed - Speed code (0 = 10Mbps, 1 = 100Mbps, 2 = 1000Mbps, 3 = 10000Mbps)
            // 4th: Status - Link status (0 = Down, 1 = Up)
            const paramsMatch = geInfoObjects[i].match(/new\s+GEInfo\s*\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/);
            if (paramsMatch) {
              const portMode = paramsMatch[1];   // Second parameter (Duplex mode)
              const speedCode = paramsMatch[2];  // Third parameter (Speed code)
              const portStatus = paramsMatch[3]; // Fourth parameter (Link status)
              const portNumber = i + 1;

              // Check if port is down - Status "0" means disconnected/down, "1" means Up
              console.log(`DEBUG: Checking port ${portNumber} - portMode="${portMode}", speedCode="${speedCode}", portStatus="${portStatus}"`);
              if (portStatus === '0' || portStatus === 'Down' || portStatus === '') {
                console.log(`DEBUG: Port ${portNumber} marked as disconnected (status: "${portStatus}")`);
                portSpeeds[`eth${portNumber}-speed`] = 0; // 0 indicates disconnected port
              } else {
                console.log(`DEBUG: Port ${portNumber} is UP, processing speed code "${speedCode}"`);
                // Convert speed code to Mbps value
                // Speed codes: 0=10Mbps, 1=100Mbps, 2=1000Mbps, 3=10000Mbps
                let speedValue;
                switch (speedCode) {
                  case '3':
                    speedValue = 10000;
                    break;
                  case '2':
                    speedValue = 1000;
                    break;
                  case '1':
                    speedValue = 100;
                    break;
                  case '0':
                    speedValue = 10;
                    break;
                  default:
                    console.log(`DEBUG: Unknown speed code "${speedCode}" for port ${portNumber}`);
                    speedValue = 0; // 0 indicates disconnected port
                }

                console.log(`DEBUG: Port ${portNumber} speed set to ${speedValue} Mbps`);
                portSpeeds[`eth${portNumber}-speed`] = speedValue;
              }
            }
          }
        }
      }
    } else {
      // Fallback to original Blue UI parsing
      // Blue UI format - parse from JavaScript arrays
      // Looking for patterns like: var geInfos = new Array(new GEInfo("...","1","2","1"),new GEInfo("...","0","0","0"),null);
      // Where parameter 2 is status/link (0 = disconnected, 1 = connected) and parameter 3 is speed code (0 = 10Mbps, 1 = 100Mbps, 2 = 1000Mbps)

      // Extract the geInfos array
      const geInfosMatch = html.match(/var\s+geInfos\s*=\s*new\s+Array\s*\(.*?\);/s);
      if (geInfosMatch && geInfosMatch[0]) {
        // Extract GEInfo objects from the array
        const geInfoObjects = geInfosMatch[0].match(/new\s+GEInfo\s*\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g);

        if (geInfoObjects && geInfoObjects.length >= 2) {
          // Process port 1
          const port1Match = geInfoObjects[0].match(/new\s+GEInfo\s*\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/);
          if (port1Match) {
            const port1Status = port1Match[1]; // Second parameter (Status/Link)
            const port1SpeedCode = port1Match[2];  // Third parameter (Speed code)

            if (port1Status === '0') {
              portSpeeds['eth1-speed'] = 0; // Disconnected
            } else {
              // Convert speed code to Mbps value
              let speedValue;
              switch (port1SpeedCode) {
                case '3':
                  speedValue = 10000;
                  break;
                case '2':
                  speedValue = 1000;
                  break;
                case '1':
                  speedValue = 100;
                  break;
                case '0':
                  speedValue = 10;
                  break;
                default:
                  speedValue = 0; // Disconnected
              }
              portSpeeds['eth1-speed'] = speedValue;
            }
          }

          // Process port 2
          const port2Match = geInfoObjects[1].match(/new\s+GEInfo\s*\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/);
          if (port2Match) {
            const port2Status = port2Match[1]; // Second parameter (Status/Link)
            const port2SpeedCode = port2Match[2];  // Third parameter (Speed code)

            if (port2Status === '0') {
              portSpeeds['eth2-speed'] = 0; // Disconnected
            } else {
              // Convert speed code to Mbps value
              let speedValue;
              switch (port2SpeedCode) {
                case '3':
                  speedValue = 10000;
                  break;
                case '2':
                  speedValue = 1000;
                  break;
                case '1':
                  speedValue = 100;
                  break;
                case '0':
                  speedValue = 10;
                  break;
                default:
                  speedValue = 0; // Disconnected
              }
              portSpeeds['eth2-speed'] = speedValue;
            }
          }
        }
      }
    }
  }

  return portSpeeds;
}

/**
 * Monitor ONU device - Main entry point
 * @param {Object} deviceConfig - Device configuration object
 * @param {boolean} includePortSpeeds - Whether to fetch Ethernet port speeds
 * @param {boolean} includeOnlineDuration - Whether to fetch WAN online duration (Blue UI only)
 */
async function monitorONU(deviceConfig, includePortSpeeds = false, includeOnlineDuration = false) {
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

    // Get Ethernet port speeds if requested
    if (includePortSpeeds) {
      try {
        const portSpeeds = await getEthernetPortSpeeds(loginResult.apiClient, loginResult.cookies, host);
        data.portSpeeds = portSpeeds;
      } catch (error) {
        // Don't fail the entire operation if port speeds can't be fetched
        console.warn('Failed to fetch port speeds:', error.message);
      }
    }

    // Get WAN online duration if requested (Blue UI only)
    if (includeOnlineDuration) {
      try {
        const onlineDuration = await getWanOnlineDuration(loginResult.apiClient, loginResult.cookies, host);
        if (onlineDuration) {
          data.onlineDuration = onlineDuration;
        }
      } catch (error) {
        // Don't fail the entire operation if online duration can't be fetched
        console.warn('Failed to fetch online duration:', error.message);
      }
    }

    return {
      success: true,
      data: data,
      apiClient: loginResult.apiClient,
      sessionCookies: loginResult.cookies
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
  checkConnectivity,
  getEthernetPortSpeeds,
  getWanOnlineDuration
};
