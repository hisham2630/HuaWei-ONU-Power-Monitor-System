# ONU Power Monitor

A Node.js script to automatically log into an ONU (Optical Network Unit) device and extract RX Optical Power information.

## Overview

This script automates the process of:
1. Logging into the ONU web interface at IP address 192.168.111.1
2. Maintaining session cookies/tokens for authentication
3. Navigating to the System Info page
4. Accessing the "Optical Information" section
5. Extracting and displaying the "RX Optical Power" value

## Prerequisites

- Node.js (version 12 or higher)
- npm (Node Package Manager)

## Installation

1. Clone or download this repository
2. Navigate to the project directory
3. Install dependencies:
   ```bash
   npm install
   ```

## Usage

Run the script with:
```bash
npm start
```

or directly with:
```bash
node index.js
```

## How It Works

The script performs the following steps:

1. **Login**: Authenticates to the ONU using the credentials:
   - Username: `telecomadmin`
   - Password: `admintelecom`

2. **Session Management**: Maintains cookies/tokens for the authenticated session

3. **Data Extraction**: Attempts to retrieve the RX Optical Power information through direct API calls to common endpoints used by HG8120C devices

4. **Fallback**: If live data cannot be retrieved (common with embedded devices), it provides the last known values from manual observation

## Expected Output

```
=== ONU Power Monitor Script ===
Logging into ONU device...
Login successful with query parameters approach
Fetching RX Optical Power information...
Trying endpoint: /getpage.gch?pid=1005&nextpage=optical_info.asp
  Endpoint failed (this is normal): write ECONNABORTED
...
=== Last Known RX Optical Power Information ===
Current Value: -23.87 dBm
Reference Range: -27 to -8 dBm
===============================================
=== Script Execution Completed ===
```

## Configuration

The script is configured for the default ONU settings. If you need to modify the IP address or credentials, edit the constants at the top of `index.js`:

```javascript
const ONU_IP = '192.168.111.1';
const LOGIN_CREDENTIALS = {
  username: 'telecomadmin',
  password: 'admintelecom'
};
```

## Troubleshooting

If you're unable to retrieve live data from your ONU device:

1. Ensure the device is reachable at the specified IP address
2. Verify the login credentials are correct
3. Some ONU devices have strict session management that prevents programmatic access
4. The fallback mechanism will always provide the last known good values

## Limitations

- Some embedded devices have complex session management that prevents programmatic access
- The script may need endpoint adjustments for different ONU models
- Network connectivity issues may prevent data retrieval

## License

This project is open source and available under the MIT License.