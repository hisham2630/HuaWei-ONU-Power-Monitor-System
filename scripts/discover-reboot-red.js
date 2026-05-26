const axios = require('axios');

const host = process.env.ONU_HOST || '192.168.100.1';
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

async function login() {
  const api = axios.create({
    baseURL: `http://${host}`,
    timeout: 15000,
    validateStatus: (s) => s < 500
  });

  let cookies = {};
  const r1 = await api.get('/');
  if (r1.headers['set-cookie']) cookies = parseCookies(r1.headers['set-cookie']);

  let csrfToken = extractToken(r1.data);
  if (!csrfToken) {
    const tok = await api.post('/asp/GetRandCount.asp', '', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    csrfToken = String(tok.data).trim();
  }

  const loginData = new URLSearchParams({ UserName: user, PassWord: b64(pass) });
  if (csrfToken) loginData.append('x.X_HW_Token', csrfToken);

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

  const cookieHdr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return { api, cookies, cookieHdr, hasSid: (cookies.Cookie || '').includes('sid') };
}

async function main() {
  const { api, cookieHdr, hasSid } = await login();
  console.log('sid:', hasSid);

  const paths = [
    '/html/ssmp/cfgfile/cfgfile.asp',
    '/html/ssmp/cfgmanage/cfgmanage.asp',
    '/html/ssmp/cfgbackup/cfgbackup.asp',
    '/html/ssmp/cfgguide/guideindex.asp',
    '/html/ssmp/accoutcfg/ontmngt.asp',
    '/html/ssmp/reset/reset.asp',
    '/html/ssmp/diagnose/diagnose.asp'
  ];

  const headers = {
    Cookie: cookieHdr,
    Referer: `http://${host}/index.asp`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  for (const p of paths) {
    try {
      const r = await api.get(p, { headers });
      const html = String(r.data);
      const interesting = /restart|Restart|reboot|SaveandReboot|Save and|set\.cgi|ResetBoard|cfgfile/i.test(
        html
      );
      console.log(`\n${p} status=${r.status} len=${html.length} interesting=${interesting}`);
      if (interesting) {
        html
          .split('\n')
          .filter((l) => /SaveandReboot|set\.cgi|ResetBoard|onttoken|hwonttoken/i.test(l))
          .slice(0, 12)
          .forEach((l) => console.log(' ', l.trim().slice(0, 200)));
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
