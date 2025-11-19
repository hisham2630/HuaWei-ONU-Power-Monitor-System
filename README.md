# Huawei ONU Optical Power Monitor

A comprehensive Node.js application for monitoring Huawei ONU (Optical Network Unit) devices with both CLI and Web-based interfaces, featuring real-time monitoring and configurable notification alerts.

## Overview

This application provides two ways to monitor ONU devices:

### 1. Command-Line Interface (CLI)
- Automatically logs into the ONU web interface
- Maintains session cookies/tokens for authentication
- Navigates to the System Info page
- Accesses the "Optical Information" section
- Extracts and displays the "RX Optical Power" value
- Supports both Blue UI (HG8120C) and Red UI (EG8120L) ONU devices
- Extracts Ethernet port speeds for both ONU types

### 2. Web-Based User Interface (WebUI)
- Modern dashboard with real-time monitoring
- Multi-device management
- Configurable notification system with SMS/WhatsApp alerts
- Threshold-based alerting for RX power, temperature, and device status
- User authentication and management
- Ethernet port speed monitoring for both ONU types
- Enhanced device organization with groups

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

### WebUI Mode (Recommended)

Start the web server with:
```bash
npm start
```

or directly with:
```bash
node server.js
```

Then access the WebUI at `http://localhost:3000` with default credentials:
- Username: `admin`
- Password: `admin123` (change immediately after first login)

### CLI Mode

Run the CLI monitoring script with:
```bash
npm run monitor
```

or directly with:
```bash
node index.js
```

#### CLI Mode Options

The CLI supports two different ONU device types with distinct UI interfaces:

**Blue UI Mode (Default)**
- Device: HG8120C
- IP: 192.168.111.1
- Command: `node index.js` or `node index.js blue`
- Characteristics:
  - Uses HTML-embedded CSRF tokens
  - Hex-encoded data values (e.g., `\x2d23\x2e87`)
  - Local network access

**Red UI Mode**
- Device: EG8120L
- IP: oxygen-iq.net:50099
- Command: `node index.js red`
- Characteristics:
  - Uses AJAX endpoint for CSRF tokens (`/asp/GetRandCount.asp`)
  - Plain decimal data values (e.g., `-23.28`)
  - Remote access via domain name

**Help**
- Command: `node index.js help`, `node index.js --help`, or `node index.js -h`
- Shows usage instructions

## WebUI Features

### Device Management
- Add, edit, and remove multiple ONU devices
- Configure device-specific monitoring intervals
- Support for different ONU types (Blue UI HG8120C, Red UI EG8120L)
- Credential encryption for secure storage
- Ethernet port speed monitoring configuration
- Device grouping for better organization

### Real-Time Monitoring
- Continuous background monitoring of all configured devices
- Configurable monitoring intervals (default: 15 minutes)
- Retry logic with configurable attempts and delays
- Live status updates on the dashboard
- Ethernet port speed display for both ONU types
- Enhanced PRTG-like device card view with customizable sensor badges

### Notification System
- SMS/WhatsApp alert configuration via API templates
- Support for multiple recipient phone numbers
- Threshold-based alerts:
  - Low RX Power notifications with configurable dBm thresholds
  - High/Low temperature alerts with configurable °C thresholds
  - Device offline/online status notifications
  - Ethernet port speed monitoring with configurable thresholds
  - Port down notifications
- Real-time alert processing without server restart
- Group-aware notifications showing "GroupName - DeviceName" for better identification

### User Management
- Secure login with password hashing
- Password change functionality
- Session management

## Ethernet Port Monitoring

The WebUI now includes comprehensive Ethernet port monitoring capabilities:

### Configuration
- Per-port speed threshold configuration (10, 100, or 1000 Mbps)
- Individual port down notification settings
- Display preferences for selected ports

### Notifications
- Alerts when port speed drops below configured threshold
- Notifications when ports go down (speed = 0)
- Group-aware messaging for easier identification

## CLI Mode Features

The script performs the following steps:

1. **Login**: Authenticates to the ONU using the credentials:
   - Username: `telecomadmin`
   - Password: `admintelecom`

2. **Session Management**: Maintains cookies/tokens for the authenticated session

3. **Data Extraction**: Attempts to retrieve the RX Optical Power information through direct API calls to common endpoints used by HG8120C devices

4. **Fallback**: If live data cannot be retrieved (common with embedded devices), it provides the last known values from manual observation

### Blue UI vs Red UI Differences

| Feature | Blue UI (HG8120C) | Red UI (EG8120L) |
|---------|-------------------|------------------|
| CSRF Token Retrieval | Extracted from HTML | Retrieved via AJAX endpoint |
| Data Format | Hex-encoded (`\x2d23\x2e87`) | Plain decimal (`-23.28`) |
| Access Method | Local IP (192.168.111.1) | Remote domain (oxygen-iq.net:50099) |
| Authentication Flow | HTML-based token extraction | AJAX-based token retrieval |
| Port Speed Extraction | JavaScript array parsing | HTML table parsing |

## Expected Output

### WebUI
Access `http://localhost:3000` in your browser to see the dashboard with real-time device monitoring, alerts, and configuration options.

### CLI Mode
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