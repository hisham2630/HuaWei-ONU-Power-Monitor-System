# Multiple Instance Setup Guide

This guide explains how to run multiple instances of the ONU Power Monitor on the same server without session conflicts.

## Problem
When running multiple instances (e.g., one at port 3000 and another at 3500), logging into one instance would invalidate the session in the other instance because they were sharing:
- The same session database file
- The same session cookie name

## Solution
Each instance must have its own:
1. **Session database file** - to store sessions separately
2. **Session cookie name** - to prevent cookie overwrites
3. **Port** - to run on different ports (obviously)
4. **Application database** - to store different devices (already separate if in different directories)

## Configuration Steps

### Instance 1 (Port 3000) - HuaWei-ONU-Power-Monitor-System

1. Navigate to the first instance:
   ```bash
   cd /opt/HuaWei-ONU-Power-Monitor-System
   ```

2. Create/edit `.env` file:
   ```env
   PORT=3000
   SESSION_SECRET=your-unique-secret-key-instance1
   SESSION_COOKIE_NAME=onu_monitor_3000
   SESSION_DB_NAME=sessions_3000.db
   ENCRYPTION_KEY=your-encryption-key-instance1
   ```

### Instance 2 (Port 3500) - Mikrotik-Monitor-System

1. Navigate to the second instance:
   ```bash
   cd /opt/Mikrotik-Monitor-System
   ```

2. Create/edit `.env` file:
   ```env
   PORT=3500
   SESSION_SECRET=your-unique-secret-key-instance2
   SESSION_COOKIE_NAME=mikrotik_monitor_3500
   SESSION_DB_NAME=sessions_3500.db
   ENCRYPTION_KEY=your-encryption-key-instance2
   ```

## Important Notes

### Session Cookie Names
- **Must be different** for each instance
- Recommended format: `<instance_name>_<port>`
- Examples: `onu_monitor_3000`, `mikrotik_monitor_3500`

### Session Database Names
- **Must be different** for each instance
- Recommended format: `sessions_<port>.db`
- Examples: `sessions_3000.db`, `sessions_3500.db`
- All session databases will be stored in the `./data` directory

### Session Secrets
- **Should be different** for each instance (best practice)
- Generate strong random strings for production

### Encryption Keys
- **Should be different** for each instance (best practice)
- Used to encrypt passwords in the database

## Verifying the Setup

After configuring both instances:

1. **Restart both servers** to apply the new configuration

2. **Check the data directories**:
   ```bash
   ls -la /opt/HuaWei-ONU-Power-Monitor-System/data/
   # Should see: sessions_3000.db, onu_monitor.db
   
   ls -la /opt/Mikrotik-Monitor-System/data/
   # Should see: sessions_3500.db, onu_monitor.db
   ```

3. **Test session isolation**:
   - Open browser, navigate to `http://your-server:3000`
   - Log in to the first instance
   - Open a new tab, navigate to `http://your-server:3500`
   - Log in to the second instance
   - Both sessions should remain active independently

4. **Check browser cookies** (Developer Tools → Application → Cookies):
   - You should see two separate session cookies:
     - `onu_monitor_3000` for port 3000
     - `mikrotik_monitor_3500` for port 3500

## Generating Secure Keys

For production environments, generate strong random keys:

```bash
# Generate random session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate random encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Troubleshooting

### Sessions still conflicting?
- Verify `.env` files exist in both directories
- Check that environment variables are being loaded (restart servers)
- Clear browser cookies and try again
- Verify different session database files are being created

### Can't log in?
- Check if `.env` file exists
- Verify `SESSION_SECRET` is set correctly
- Check server logs for errors

### How to check current configuration?
Add this to your server startup and check the console output:
```bash
# Check which port and session config is being used
grep "Server running at" server.js
```

## Running with PM2 or Systemd

### PM2
If using PM2, ensure each instance uses its own `.env` file:
```bash
cd /opt/HuaWei-ONU-Power-Monitor-System
pm2 start server.js --name "onu-monitor-3000"

cd /opt/Mikrotik-Monitor-System
pm2 start server.js --name "mikrotik-monitor-3500"
```

### Systemd
Create separate service files for each instance with different working directories.
