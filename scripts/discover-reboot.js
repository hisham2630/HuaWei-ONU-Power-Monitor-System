const axios = require('axios');

const host = process.env.ONU_HOST || '192.168.111.1';
const user = process.env.ONU_USER || 'telecomadmin';
const pass = process.env.ONU_PASS || 'admintelecom';

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function parseCookies(h) {
  const c = {};
  if (!h) return c;
  (Array.isArray(h) ? h : [h]).forEach((x) => {
    const p = x.split(';')[0].split('=');
    if (p.length === 2) c[p[0]] = p[1];
  });
  return c;
}

function extractToken(html) {
  const m = String(html).match(/function GetRandCnt\(\)\s*\{\s*return\s*'([^']+)'/i);
  return m ? m[1] : '';
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function login() {
  const api = axios.create({
    baseURL: `http://${host}`,
    timeout: 15000,
    validateStatus: (s) => s < 500
  });

  let cookies = {};
  const r1 = await api.get('/');
  if (r1.headers['set-cookie']) cookies = parseCookies(r1.headers['set-cookie']);

  const token = extractToken(r1.data);
  const loginData = new URLSearchParams({ UserName: user, PassWord: b64(pass) });
  if (token) loginData.append('x.X_HW_Token', token);

  const r2 = await api.post('/login.cgi', loginData.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: 'Cookie=body:Language:english:id=-1',
      Referer: `http://${host}/`
    }
  });

  if (r2.headers['set-cookie']) {
    const sc = Array.isArray(r2.headers['set-cookie'])
      ? r2.headers['set-cookie']
      : [r2.headers['set-cookie']];
    for (const c of sc) {
      if (c.startsWith('Cookie=')) {
        cookies.Cookie = c.split(';')[0].replace('Cookie=', '');
      }
    }
  }

  return { api, cookies, cookieHdr: cookieHeader(cookies) };
}

async function main() {
  const { api, cookies, cookieHdr } = await login();
  console.log('sid:', (cookies.Cookie || '').includes('sid'));

  const idx = await api.get('/index.asp', { headers: { Cookie: cookieHdr } });
  const ssmp = [...new Set(String(idx.data).match(/html\/ssmp[^"'\s]+/gi) || [])];
  console.log('ssmp paths in index:', ssmp);

  const paths = [
    '/html/ssmp/reset/reset.asp',
    '/html/ssmp/cfgfile/cfgfile.asp',
    '/html/ssmp/cfgfile/cfgupload.asp',
    '/html/ssmp/cfgmanage/cfgmanage.asp',
    '/html/ssmp/cfgbackup/cfgbackup.asp',
    '/html/ssmp/downloadcfg/downloadcfg.asp',
    '/html/ssmp/ontrestore/ontrestore.asp',
    '/html/ssmp/devmanage/ontrestore.asp',
    '/html/ssmp/accoutcfg/ontmngt.asp'
  ];

  const cfg = await api.get('/html/ssmp/cfgfile/cfgfile.asp', {
    headers: { Cookie: cookieHdr, Referer: `http://${host}/index.asp` }
  });
  const cfgHtml = String(cfg.data);
  const tokenMatch = cfgHtml.match(/function GetRandCnt\(\)\s*\{\s*return\s*'([^']+)'/i);
  const hwTokenMatch = cfgHtml.match(/name="x\.X_HW_Token"[^>]*value="([^"]*)"/i);
  const ontTokenMatch =
    cfgHtml.match(/id=['"]onttoken['"][^>]*value=['"]([^'"]*)['"]/i) ||
    cfgHtml.match(/getValue\('onttoken'\)/);
  console.log('\ncfgfile token GetRandCnt:', tokenMatch ? tokenMatch[1].slice(0, 20) + '...' : 'none');
  console.log('cfgfile hidden x.X_HW_Token:', hwTokenMatch ? hwTokenMatch[1].slice(0, 20) + '...' : 'none');
  console.log('cfgfile onttoken:', ontTokenMatch);
  const ontLines = cfgHtml.split('\n').filter((l) => /onttoken|ontToken/i.test(l));
  ontLines.forEach((l) => console.log(' ', l.trim().slice(0, 160)));
  const inputs = [...cfgHtml.matchAll(/<input[^>]+>/gi)].map((m) => m[0]);
  console.log('input count', inputs.length);
  inputs.forEach((i) => console.log(' ', i.slice(0, 120)));

  const tok = await api.post('/asp/GetRandCount.asp', '', {
    headers: { Cookie: cookieHdr, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const hwToken = String(tok.data).trim();
  console.log('GetRandCount token:', hwToken);

  const rebootUrl =
    '/html/ssmp/cfgfile/set.cgi?x=InternetGatewayDevice.X_HW_DEBUG.SSP.DBSave&y=InternetGatewayDevice.X_HW_DEBUG.SMP.DM.ResetBoard&RequestFile=html/ssmp/cfgfile/cfgfile.asp';
  console.log('\nDRY RUN - would POST to', rebootUrl, 'with token', hwToken.slice(0, 20));
  console.log('(Skipping actual reboot POST)');
  const saveReboot = cfgHtml.match(/function SaveandReboot\(\)[\s\S]{0,400}/);
  if (saveReboot) console.log('SaveandReboot:\n', saveReboot[0]);

  for (const p of paths) {
    try {
      const r = await api.get(p, {
        headers: { Cookie: cookieHdr, Referer: `http://${host}/index.asp` }
      });
      const html = String(r.data);
      const interesting = /restart|Restart|reboot|Reboot|Save and|set\.cgi|ResetBoard|cfgfile/i.test(
        html
      );
      console.log(`\n${p} status=${r.status} len=${html.length} interesting=${interesting}`);
      if (interesting) {
        const lines = html.split('\n').filter((l) => /restart|set\.cgi|ResetBoard|Save|cfgfile/i.test(l));
        lines.slice(0, 15).forEach((l) => console.log(' ', l.trim().slice(0, 200)));
      }
    } catch (e) {
      console.log(`${p} ERR ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
