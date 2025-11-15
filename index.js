const axios = require('axios');

// ONU device configuration - support both types
const ONU_CONFIGS = {
  blue: {
    host: '192.168.111.1',
    name: 'HG8120C',
    color: 'Blue UI'
  },
  red: {
    host: 'oxygen-iq.net:50099',
    name: 'EG8120L',
    color: 'Red UI'
  }
};

// Default to blue UI, but can be changed via command line
const selectedONU = process.argv[2] === 'red' ? 'red' : process.argv[2] === 'blue' ? 'blue' : 
  (process.argv[2] === 'help' || process.argv[2] === '--help' || process.argv[2] === '-h') ? null : 'blue';

if (selectedONU === null) {
  console.log('\n=== ONU Power Monitor - Usage ===');
  console.log('\nMonitor RX Optical Power from Huawei ONU devices\n');
  console.log('Usage:');
  console.log('  node index.js [onu-type]\n');
  console.log('ONU Types:');
  console.log('  blue    - HG8120C at 192.168.111.1 (Blue UI) [default]');
  console.log('  red     - EG8120L at oxygen-iq.net:50099 (Red UI)');
  console.log('  help    - Show this help message\n');
  console.log('Examples:');
  console.log('  node index.js          # Monitor Blue UI ONU (default)');
  console.log('  node index.js blue     # Monitor Blue UI ONU');
  console.log('  node index.js red      # Monitor Red UI ONU\n');
  process.exit(0);
}

const currentConfig = ONU_CONFIGS[selectedONU];
const ONU_IP = currentConfig.host;

const LOGIN_CREDENTIALS = {
  username: 'telecomadmin',
  password: 'admintelecom'
};

console.log(`\n=== Configuring for ${currentConfig.color} ONU (${currentConfig.name}) ===`);
console.log(`Target: ${ONU_IP}\n`);

// Create an axios instance with default settings
const apiClient = axios.create({
  baseURL: `http://${ONU_IP}`,
  timeout: 10000,
  maxRedirects: 5,
  validateStatus: (status) => status < 500
});

// Store cookies for session management
let sessionCookies = {};

/**
 * Base64 encode function matching browser implementation
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
 * Format cookies for request header
 */
function formatCookies(cookies) {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
}

/**
 * Extract random CSRF token from login page HTML
 */
function extractToken(html) {
  const match = html.match(/function GetRandCnt\(\)\s*{\s*return\s*'([^']+)'/i);
  return match ? match[1] : '';
}

/**
 * Decode hex-encoded strings from JavaScript (e.g., \x2d23\x2e87 -> -23.87)
 * Used by Blue UI ONU (HG8120C)
 */
function decodeHexString(str) {
  return str.replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

/**
 * Detect ONU UI type based on data format
 * Blue UI: hex-encoded (\x2d23\x2e87)
 * Red UI: plain decimal (-23.28)
 */
function detectUIType(value) {
  return value.includes('\\x') ? 'blue' : 'red';
}

/**
 * Extract opticInfo object from JavaScript code
 * Supports both Blue UI (hex-encoded) and Red UI (plain decimal)
 */
function extractOpticInfo(html) {
  // Look for the opticInfos array initialization
  const pattern = /var\s+opticInfos\s*=\s*new\s+Array\(new\s+stOpticInfo\(([^)]+)\)/i;
  const match = html.match(pattern);
  
  if (!match) return null;
  
  // Parse the parameters - they're comma-separated and quoted
  const params = match[1];
  
  // Extract all values including TX, RX, voltage, temperature
  // Format: "domain","txPower","rxPower","voltage","temperature",...
  const valuePattern = /"([^"]*)"/g;
  const values = [];
  let valueMatch;
  
  while ((valueMatch = valuePattern.exec(params)) !== null) {
    values.push(valueMatch[1]);
  }
  
  if (values.length < 5) return null;
  
  // Detect UI type and decode accordingly
  const txRaw = values[1];
  const rxRaw = values[2];
  const voltageRaw = values[3];
  const temperatureRaw = values[4];
  
  const uiType = detectUIType(rxRaw);
  console.log(`Detected ${uiType === 'blue' ? 'Blue' : 'Red'} UI data format`);
  
  // Decode hex-encoded values for Blue UI, or use directly for Red UI
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
 * Extract reference range based on PON mode
 */
function extractReferenceRange(html) {
  // Check PON mode
  const ponModeMatch = html.match(/var\s+ontPonMode\s*=\s*'([^']+)'/i);
  const ponMode = ponModeMatch ? ponModeMatch[1] : 'gpon';
  
  // For GPON, the default reference is -27 to -8 dBm (from amp_optic_rxrefg)
  // This matches what we observed: "-27 to -8 dBm"
  if (ponMode.toLowerCase().includes('gpon')) {
    return '-27 to -8 dBm';
  } else if (ponMode.toLowerCase().includes('epon')) {
    return '-24 to -7 dBm'; // Typical EPON range
  }
  
  return '-27 to -8 dBm'; // Default GPON range
}

/**
 * Extract temperature reference range
 */
function extractTemperatureRange(html) {
  // Standard operating temperature range for ONU devices
  return '-10 to +85 ℃';
}

/**
 * Performs login to the ONU web interface
 * Uses base64-encoded password as per device requirements
 * Supports both Blue UI (HG8120C) and Red UI (EG8120L)
 */
async function login() {
  try {
    console.log('Logging into ONU device...');
    
    // Step 1: Get the login page to extract CSRF token and initial cookies
    const loginPageResponse = await apiClient.get('/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log(`Login page status: ${loginPageResponse.status}`);
    
    // Parse and store initial cookies
    if (loginPageResponse.headers['set-cookie']) {
      sessionCookies = parseCookies(loginPageResponse.headers['set-cookie']);
      console.log('Initial cookies received');
    }
    
    // Extract CSRF token - try from HTML first (Blue UI)
    let csrfToken = extractToken(loginPageResponse.data);
    
    // If not found in HTML, try AJAX endpoint (Red UI)
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
          console.log('CSRF Token from AJAX:', csrfToken);
        }
      } catch (e) {
        console.log('AJAX token request failed:', e.message);
      }
    } else {
      console.log(`CSRF Token: ${csrfToken}`);
    }
    
    // Step 2: Set language cookie BEFORE login (as done by browser)
    // The browser sets: Cookie=body:Language:english:id=-1;path=/
    const preCookie = 'Cookie=body:Language:english:id=-1';
    
    // Step 3: Submit login with base64-encoded password
    const loginData = new URLSearchParams();
    loginData.append('UserName', LOGIN_CREDENTIALS.username);
    loginData.append('PassWord', base64encode(LOGIN_CREDENTIALS.password));
    if (csrfToken) {
      loginData.append('x.X_HW_Token', csrfToken);
    }
    
    const loginHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': preCookie,
      'Referer': `http://${ONU_IP}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    
    const loginResponse = await apiClient.post('/login.cgi', loginData.toString(), {
      headers: loginHeaders
    });
    
    console.log(`Login response status: ${loginResponse.status}`);
    
    // Parse the session cookie from response
    // Expected format: Cookie=sid=<hex>:Language:english:id=1
    if (loginResponse.headers['set-cookie']) {
      const setCookies = loginResponse.headers['set-cookie'];
      console.log('Set-Cookie headers:', JSON.stringify(setCookies));
      
      // Find the Cookie with session ID
      const cookieHeader = Array.isArray(setCookies) ? setCookies : [setCookies];
      for (const cookie of cookieHeader) {
        if (cookie.startsWith('Cookie=')) {
          // Extract just the cookie value before semicolon
          const cookieValue = cookie.split(';')[0];
          sessionCookies['Cookie'] = cookieValue.replace('Cookie=', '');
          console.log('Session cookie extracted:', sessionCookies['Cookie'].substring(0, 50) + '...');
          
          // Check if session ID is present
          if (sessionCookies['Cookie'].includes('sid=')) {
            console.log('Login successful - session ID received');
            return true;
          }
        }
      }
    }
    
    console.log('Login completed');
    return true;
  } catch (error) {
    console.error('Login failed:', error.message);
    return false;
  }
}

/**
 * Extract RX Optical Power and Temperature by fetching optical info page and parsing JavaScript
 */
async function getRxOpticalPower() {
  try {
    console.log('\nFetching RX Optical Power and Temperature information...');
    
    const headers = {
      'Cookie': formatCookies(sessionCookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `http://${ONU_IP}/index.asp`
    };
    
    // Access the optical information page
    // This is the iframe content URL we identified: /html/amp/opticinfo/opticinfo.asp
    console.log('Requesting optical information page...');
    const response = await apiClient.get('/html/amp/opticinfo/opticinfo.asp', { 
      headers: headers
    });
    
    console.log(`Optical info page status: ${response.status}`);
    
    if (response.status !== 200) {
      console.error('Failed to access optical information page');
      return null;
    }
    
    const html = response.data;
    
    // Check if we got redirected to login ("Waiting..." page)
    if (html.includes('Waiting...') || html.length < 100) {
      console.error('Session expired or not authenticated properly');
      console.error('Response preview:', html.substring(0, 200));
      return null;
    }
    
    // Extract opticInfo object from JavaScript
    const opticInfo = extractOpticInfo(html);
    
    if (!opticInfo) {
      console.error('Failed to extract opticInfo from page');
      console.error('Searching for opticInfos in response...');
      
      // Debug: show if opticInfos exists in the page
      if (html.includes('opticInfos')) {
        const snippet = html.substring(html.indexOf('opticInfos'), html.indexOf('opticInfos') + 500);
        console.error('Found opticInfos snippet:', snippet);
      } else {
        console.error('opticInfos not found in response');
      }
      
      return null;
    }
    
    // Extract reference ranges
    const referenceRange = extractReferenceRange(html);
    const tempRange = extractTemperatureRange(html);
    
    // Format output to match observed format
    const currentValue = `${opticInfo.rxPower} dBm`;
    const referenceValue = referenceRange;
    const temperature = `${opticInfo.temperature} ℃`;
    const temperatureRange = tempRange;
    
    console.log('\n=== ONU Optical Information ===');
    console.log(`Current RX Optical Power: ${currentValue}`);
    console.log(`Reference Range: ${referenceValue}`);
    console.log(`Working Temperature: ${temperature}`);
    console.log(`Temperature Range: ${temperatureRange}`);
    console.log('================================\n');
    
    return {
      currentValue: currentValue,
      referenceValue: referenceValue,
      temperature: temperature,
      temperatureRange: temperatureRange
    };
    
  } catch (error) {
    console.error('Failed to get optical information:', error.message);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response preview:', error.response.data?.substring(0, 200));
    }
    
    return null;
  }
}

/**
 * Main function to orchestrate the ONU monitoring process
 */
async function main() {
  console.log('=== ONU Power Monitor Script ===');
  console.log(`Device: ${currentConfig.name} (${currentConfig.color}) at ${ONU_IP}`);
  console.log('================================\n');
  
  // Attempt login
  const loggedIn = await login();
  
  if (!loggedIn) {
    console.error('\nUnable to login to ONU device. Exiting.');
    process.exit(1);
  }
  
  // Small delay to ensure session is established
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Get RX Optical Power information
  const rxPowerData = await getRxOpticalPower();
  
  if (rxPowerData === null) {
    console.error('\nFailed to retrieve RX Optical Power data.');
    console.error('Please check:');
    console.error('  1. Network connectivity to ' + ONU_IP);
    console.error('  2. Device is powered on and accessible');
    console.error('  3. Credentials are correct');
    process.exit(1);
  }
  
  console.log('\n=== Script Execution Completed Successfully ===');
  console.log(`ONU Type: ${currentConfig.color} (${currentConfig.name})`);
  console.log(`Target: ${ONU_IP}`);
}

// Execute the main function
main().catch(error => {
  console.error('\nScript execution failed:', error.message);
  process.exit(1);
});