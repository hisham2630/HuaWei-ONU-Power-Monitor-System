/**
 * Discover Tenda ONU reboot form fields and POST bodies.
 *
 * Usage:
 *   node scripts/discover-tenda-reboot.js <host> [user] [pass]
 *   node scripts/discover-tenda-reboot.js 192.168.1.1 admin password --execute
 *
 * Environment: TENDA_HOST, TENDA_USER, TENDA_PASS
 * Dry-run by default (no reboot POST). Pass --execute to send the reboot form.
 */

const { loginTenda, rebootTendaONU } = require('../lib/tendaMonitor');

const args = process.argv.slice(2).filter((arg) => arg !== '--execute');
const execute = process.argv.includes('--execute');

const host = args[0] || process.env.TENDA_HOST;
const user = args[1] || process.env.TENDA_USER || 'admin';
const pass = args[2] || process.env.TENDA_PASS || '';

if (!host) {
  console.error('Usage: node scripts/discover-tenda-reboot.js <host> [user] [pass] [--execute]');
  console.error('Or set TENDA_HOST (and optionally TENDA_USER, TENDA_PASS).');
  process.exit(1);
}

function buildBoaFormBody(fields) {
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
      if (index < inputVal.length) checksum += (inputVal.charCodeAt(index) << 24);
      if (index + 1 < inputVal.length) checksum += (inputVal.charCodeAt(index + 1) << 16);
      if (index + 2 < inputVal.length) checksum += (inputVal.charCodeAt(index + 2) << 8);
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

function printPostVariants() {
  const variants = [
    { label: 'empty (browser default)', fields: {} },
    { label: 'commit and reboot', fields: { save: 'Commit and Reboot', 'submit-url': '/reboot.asp' } },
    { label: 'simple reboot', fields: { reboot: 'Reboot', 'submit-url': '/reboot.asp' } }
  ];

  console.log('\nComputed POST bodies for /boaform/admin/formReboot:\n');
  for (const variant of variants) {
    const flag = computePostSecurityFlag(variant.fields);
    const body = `${buildBoaFormBody(variant.fields)}postSecurityFlag=${flag}`;
    console.log(`[${variant.label}]`);
    console.log(`  ${body}`);
    console.log('');
  }
}

async function main() {
  console.log(`Tenda reboot discovery for ${host} (execute=${execute})`);

  const login = await loginTenda(host, user, pass);
  if (!login.success) {
    console.error('Login failed:', login.error);
    process.exit(1);
  }

  console.log('Login OK');

  const rebootPage = await login.client.get('/admin/reboot.asp', { step: 'fetch reboot page' });
  console.log(`Reboot page HTTP ${rebootPage.status}, ${rebootPage.body.length} bytes`);

  const formLines = rebootPage.body
    .split('\n')
    .filter((line) => /form|action|submit|reboot|reset|boaform|postSecurityFlag/i.test(line))
    .map((line) => line.trim());

  console.log('\nReboot page form-related lines:');
  formLines.forEach((line) => console.log(`  ${line}`));

  printPostVariants();

  if (!execute) {
    console.log('DRY RUN - skipping reboot POST. Pass --execute to reboot the device.');
    return;
  }

  console.log('Executing rebootTendaONU...');
  const result = await rebootTendaONU(host, user, pass);
  console.log('Result:', result);
  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
