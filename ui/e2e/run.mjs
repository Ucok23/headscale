// End-to-end test of the admin UI in a real browser against a real headscale.
//
// RUN IT AGAINST A DISPOSABLE SERVER. It creates users, nodes and keys, and
// overwrites the stored policy (restored on exit as far as possible).
//
//   HEADSCALE_URL=http://127.0.0.1:8080 HEADSCALE_KEY=hskey-api-… npm run e2e
//
// Needs: a headscale built with the UI (policy.mode: database), Chromium
// (CHROMIUM=/path, default /usr/bin/chromium) and tailscale + tailscaled on
// PATH (the test runs real clients in userspace-networking mode, no root).
import puppeteer from 'puppeteer-core'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.env.HEADSCALE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.HEADSCALE_KEY
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium'
const SHOTS = process.env.E2E_SCREENSHOTS // directory; screenshots are skipped when unset
if (!KEY) { console.error('set HEADSCALE_KEY to an admin API key'); process.exit(2) }

const results = []
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000, step = 250) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await sleep(step) } }

const api = async (p, method = 'GET', body, token = KEY) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const nodes = async () => (await api('/api/v1/node')).json.nodes ?? []
const nodeNamed = async (n) => (await nodes()).find((x) => x.givenName === n)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-e2e-'))
const clients = {} // name -> { proc, sock }
const startClient = async (name) => {
  const dir = path.join(work, name); fs.mkdirSync(dir)
  const sock = path.join(dir, 'sock')
  const proc = spawn('tailscaled', ['--tun=userspace-networking', `--socket=${sock}`, `--statedir=${dir}`, '--port=0'], { stdio: 'ignore' })
  clients[name] = { proc, sock }
  await until(() => fs.existsSync(sock), 8000)
  return sock
}
const ts = (name, ...args) => execFileSync('tailscale', [`--socket=${clients[name].sock}`, ...args], { encoding: 'utf8' })

let previousPolicy = null
const created = { users: [], keys: [] }

const POLICY = (owner) => `{
  "tagOwners": {
    // who may tag servers
    "tag:e2e": ["${owner}@"],
  },
  "grants": [
    // everyone can reach everything
    {"src": ["*"], "dst": ["*"], "ip": ["*"]},
  ],
}`

async function setup() {
  const pre = await api('/api/v1/policy')
  previousPolicy = pre.status === 200 ? pre.json.policy : null
  const u = await api('/api/v1/user', 'POST', { name: 'e2e-owner' })
  if (u.status !== 200) throw new Error('cannot create e2e-owner: ' + JSON.stringify(u.json))
  created.users.push('e2e-owner')
  const set = await api('/api/v1/policy', 'PUT', { policy: POLICY('e2e-owner') })
  if (set.status !== 200) throw new Error('cannot set policy (policy.mode must be database): ' + JSON.stringify(set.json))
  const k = await api('/api/v1/preauthkey', 'POST', { user: u.json.user.id, reusable: false, expiration: new Date(Date.now() + 3600e3).toISOString() })
  await startClient('a')
  ts('a', 'up', '--login-server', BASE, '--authkey', k.json.preAuthKey.key, '--hostname', 'e2e-a')
  ts('a', 'set', '--advertise-routes=10.99.0.0/24')
  return u.json.user
}

async function cleanup() {
  for (const c of Object.values(clients)) { try { c.proc.kill() } catch { /* already gone */ } }
  for (const n of await nodes().catch(() => [])) if (n.givenName.startsWith('e2e-')) await api(`/api/v1/node/${n.id}`, 'DELETE')
  for (const name of created.users) { const u = (await api('/api/v1/user')).json.users?.find((x) => x.name === name); if (u) await api(`/api/v1/user/${u.id}`, 'DELETE') }
  const restore = previousPolicy ?? '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}'
  await api('/api/v1/policy', 'PUT', { policy: restore })
  fs.rmSync(work, { recursive: true, force: true })
}

const browser = await puppeteer.launch({ executablePath: CHROMIUM, headless: 'new', args: ['--no-sandbox', '--window-size=1400,950'] })
await browser.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write'])
const page = await browser.newPage()
await page.setViewport({ width: 1400, height: 950 })
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.evaluateOnNewDocument((k) => localStorage.setItem('headscale.apikey', k), KEY)

const go = async (hash) => { await page.goto(`${BASE}/admin/#/${hash}`, { waitUntil: 'networkidle0' }); await page.reload({ waitUntil: 'networkidle0' }) }
const shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${n}.png`) })
const wait = (sel, t = 8000) => page.waitForSelector(sel, { timeout: t })
const click = (sel) => page.click(sel)
const fill = async (sel, text) => { await page.focus(sel); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.type(sel, text) }
const text = (sel) => page.$eval(sel, (e) => e.innerText)
const rowClick = (rowText, btn) => page.evaluate((r, b) => [...document.querySelectorAll('tbody tr')].find((x) => x.innerText.includes(r)).querySelector(b).click(), rowText, btn)
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

try {
  const owner = await setup()
  await until(async () => (await nodeNamed('e2e-a'))?.online, 15000)

  // --- machines list, copy
  await go('machines'); await wait('table.machines tbody tr')
  await shot('machines')
  ok('machines list shows the joined client', (await text('table.machines')).includes('e2e-a'))
  await page.hover('table.machines tbody tr .copyable')
  await click('table.machines tbody tr .copybtn'); await sleep(300)
  ok('copy button puts the IP on the clipboard', /^100\.64\.|^fd7a:/.test(await page.evaluate(() => navigator.clipboard.readText())))

  // --- add device with an auth key; a real client joins with it
  await click('button::-p-text(Add device)'); await wait('.modal')
  await page.select('.modal select', owner.id)
  await click('.modal button::-p-text(Generate key)'); await wait('.modal .once')
  const authKey = await page.$$eval('.modal .cmd .cv', (e) => e[0].innerText)
  await shot('add-device')
  ok('auth key is shown with login commands', authKey.startsWith('hskey-auth-') && (await text('.modal')).includes('tailscale up --login-server'))
  await page.keyboard.press('Escape')
  await startClient('b')
  ts('b', 'up', '--login-server', BASE, '--authkey', authKey, '--hostname', 'e2e-b')
  const b = await until(() => nodeNamed('e2e-b'), 10000)
  ok('a client joins with the key made in the UI', !!b)

  // --- add device by approving an interactive login
  await startClient('c')
  const up = spawn('tailscale', [`--socket=${clients.c.sock}`, 'up', '--login-server', BASE, '--hostname', 'e2e-c'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  up.stdout.on('data', (d) => (out += d)); up.stderr.on('data', (d) => (out += d))
  const reg = await until(() => out.match(/register\/([\w:-]+)/), 12000)
  ok('the client prints a registration URL', !!reg)
  await go('machines'); await wait('table.machines')
  await click('button::-p-text(Add device)'); await wait('.modal')
  await click('.modal .tabs button::-p-text(Approve a login)'); await wait('.modal input')
  await fill('.modal input', reg[0])
  await page.select('.modal select', 'e2e-owner')
  await click('.modal button::-p-text(Register device)')
  ok('approving the login registers the device', !!(await until(() => nodeNamed('e2e-c'), 10000)))
  up.kill()

  // --- machine detail + actions
  await go(`machines/${b.id}`); await wait('.dhead')
  await shot('machine-detail')
  const detail = await text('.app.detail')
  ok('detail shows OS, client version and MagicDNS name', /linux/i.test(detail) && /\d+\.\d+\.\d+/.test(detail) && /e2e-b\.\S+/.test(detail))
  await click('button::-p-text(Rename)'); await wait('.modal input'); await fill('.modal input', 'e2e-b2'); await click('.modal button[type=submit]')
  ok('rename works', !!(await until(() => nodeNamed('e2e-b2'), 5000)))

  await page.reload({ waitUntil: 'networkidle0' }); await wait('.dhead')
  await click('button::-p-text(Edit tags)'); await wait('.modal input')
  await page.type('.modal .chipinput input', 'tag:e2e'); await page.keyboard.press('Enter'); await click('.modal button[type=submit]')
  ok('tags can be set', !!(await until(async () => (await nodeNamed('e2e-b2'))?.tags.includes('tag:e2e'), 5000)))
  await page.reload({ waitUntil: 'networkidle0' }); await wait('.dhead')
  await click('button::-p-text(Edit tags)'); await wait('.modal input')
  await page.type('.modal .chipinput input', 'tag:undefined'); await page.keyboard.press('Enter'); await click('.modal button[type=submit]')
  ok('an undefined tag shows the server reason and keeps the dialog open', !!(await until(() => page.$('.modal .banner.err'), 4000)) && /tag:undefined|not exist|defined|polic/i.test(await text('.modal .banner.err')), (await page.$eval('.modal .banner.err', (e) => e.innerText).catch(() => '')).slice(0, 100))
  await page.keyboard.press('Escape')

  await page.reload({ waitUntil: 'networkidle0' }); await wait('.dhead')
  await click('button::-p-text(Key expiry)'); await wait('.modal'); await click('.modal input[type=radio]:nth-of-type(1)'); await click('.modal button[type=submit]')
  ok('key expiry can be disabled', !!(await until(async () => !(await nodeNamed('e2e-b2'))?.expiry, 5000)))

  const a = await nodeNamed('e2e-a')
  await until(async () => (await nodeNamed('e2e-a')).availableRoutes.length, 8000)
  await go(`machines/${a.id}`); await wait('.dhead')
  await click('button::-p-text(Approve)')
  ok('a route can be approved', !!(await until(async () => (await nodeNamed('e2e-a')).approvedRoutes.includes('10.99.0.0/24'), 5000)))
  await shot('routes')
  await wait('button::-p-text(Withdraw)')
  await click('button::-p-text(Withdraw)')
  ok('a route can be withdrawn', !!(await until(async () => !(await nodeNamed('e2e-a')).approvedRoutes.length, 5000)))

  await go(`machines/${b.id}`); await wait('.dhead')
  await click('button::-p-text(Delete)'); await wait('.modal input')
  ok('delete stays disabled until the name is typed', await page.$eval('.modal button.danger', (x) => x.disabled))
  await page.type('.modal input', 'e2e-b2'); await sleep(200); await click('.modal button.danger')
  ok('machine is deleted', !!(await until(async () => !(await nodeNamed('e2e-b2')), 5000)))
  ok('the UI returns to the list after a delete', await until(() => page.url().endsWith('#/machines'), 3000))

  // --- users
  await go('users'); await wait('table.machines')
  await click('button::-p-text(Add user)'); await wait('.modal input'); await fill('.modal input', 'e2e-temp'); await click('.modal button[type=submit]')
  created.users.push('e2e-temp')
  ok('a user can be created', !!(await until(async () => (await api('/api/v1/user')).json.users.some((u) => u.name === 'e2e-temp'), 5000)))
  await page.reload({ waitUntil: 'networkidle0' }); await wait('table.machines')
  await rowClick('e2e-temp', 'button'); await wait('.modal input'); await fill('.modal input', 'e2e-temp2'); await click('.modal button[type=submit]')
  created.users.push('e2e-temp2')
  ok('a user can be renamed', !!(await until(async () => (await api('/api/v1/user')).json.users.some((u) => u.name === 'e2e-temp2'), 5000)))
  await page.reload({ waitUntil: 'networkidle0' }); await wait('table.machines')
  await rowClick('e2e-temp2', 'button.danger-text'); await wait('.modal input'); await page.type('.modal input', 'e2e-temp2'); await sleep(200); await click('.modal button.danger')
  ok('a user can be deleted', !!(await until(async () => !(await api('/api/v1/user')).json.users.some((u) => u.name === 'e2e-temp2'), 5000)))

  // a user that still owns machines cannot be deleted, and the dialog says why
  await page.reload({ waitUntil: 'networkidle0' }); await wait('table.machines')
  await rowClick('e2e-owner', 'button.danger-text'); await wait('.modal input'); await page.type('.modal input', 'e2e-owner'); await sleep(200); await click('.modal button.danger')
  const refused = await until(() => page.$('.modal .banner.err'), 5000)
  ok('deleting a user that owns machines is refused with a reason', !!refused && /must be deleted first/i.test(await text('.modal .banner.err')), refused ? (await text('.modal .banner.err')).slice(0, 90) : '')
  ok('the user is still there', (await api('/api/v1/user')).json.users.some((u) => u.name === 'e2e-owner'))
  await page.keyboard.press('Escape')

  // --- keys
  await go('keys'); await wait('button::-p-text(Generate auth key)')
  const before = (await api('/api/v1/preauthkey')).json.preAuthKeys.length
  await click('button::-p-text(Generate auth key)'); await wait('.modal'); await page.select('.modal select', owner.id)
  await click('.modal button::-p-text(Generate key)'); await wait('.modal .once'); await page.keyboard.press('Escape')
  ok('an auth key can be created', !!(await until(async () => (await api('/api/v1/preauthkey')).json.preAuthKeys.length === before + 1, 5000)))
  await sleep(500); await rowClick('e2e-owner', 'button.ghost'); await wait('.modal'); await click('.modal button.danger')
  ok('an auth key can be revoked', !!(await until(async () => (await api('/api/v1/preauthkey')).json.preAuthKeys.some((k) => new Date(k.expiration) < new Date()), 5000)))

  await click('.seg button::-p-text(API keys)'); await wait('table.machines')
  await click('button::-p-text(Create API key)'); await wait('.modal'); await click('.modal button[type=submit]'); await wait('.modal .once')
  const apiKey = await text('.modal .cv')
  ok('an API key is created and shown once', apiKey.startsWith('hskey-api-'))
  ok('the key table shows the key once, without a doubled prefix', !(await text('table.machines')).includes('hskey-api-hskey-api-'))
  await page.keyboard.press('Escape'); await sleep(400)
  const prefix = apiKey.split('-')[2]
  await rowClick(prefix, 'button.danger-text'); await wait('.modal input'); await page.type('.modal input', prefix); await sleep(200); await click('.modal button.danger')
  ok('an API key can be deleted', !!(await until(async () => !(await api('/api/v1/apikey')).json.apiKeys.some((k) => k.prefix.includes(prefix)), 5000)))
  await until(async () => !(await page.$('.modal')), 4000)

  // --- agent key: can report flows, and nothing else
  await click('.seg button::-p-text(Agent keys)'); await wait('button::-p-text(Create agent key)')
  await click('button::-p-text(Create agent key)'); await wait('.modal input'); await fill('.modal input', 'e2e agent'); await click('.modal button[type=submit]'); await wait('.modal .once')
  const secret = await page.$$eval('.modal .cmd .cv', (e) => e[0].innerText)
  await shot('agent-key')
  ok('an agent key is shown once', secret.startsWith('hskey-client-'))
  await page.keyboard.press('Escape')
  const tokRes = await fetch(BASE + '/api/v2/oauth/token', { method: 'POST', body: new URLSearchParams({ client_secret: secret }) })
  const token = (await tokRes.json()).access_token
  ok('the agent key can be exchanged for a token', !!token)
  const ips = (await nodeNamed('e2e-a')).ipAddresses
  const report = await api('/api/v2/tailnet/-/flows', 'POST', { reporter: ips[0], flows: [{ src: ips[0], dst: ips[0], proto: 6, dport: 22, bytes: 5000, packets: 5, conns: 1 }] }, token)
  ok('the token can report flows', report.status === 200)
  ok('the token cannot read the policy', (await api('/api/v2/tailnet/-/acl', 'GET', undefined, token)).status === 403)
  ok('the token cannot read machines', (await api('/api/v2/tailnet/-/devices', 'GET', undefined, token)).status === 403)
  await page.reload({ waitUntil: 'networkidle0' }); await click('.seg button::-p-text(Agent keys)'); await wait('table.machines')
  await rowClick('e2e agent', 'button.danger-text'); await wait('.modal input'); await page.type('.modal input', 'e2e agent'); await sleep(200); await click('.modal button.danger'); await sleep(1200)
  const after = await fetch(BASE + '/api/v2/oauth/token', { method: 'POST', body: new URLSearchParams({ client_secret: secret }) })
  ok('a deleted agent key stops working', after.status === 401)

  // --- policy editor + simulator
  await go('policy'); await wait('.visual')
  await shot('policy')
  ok('the visual editor shows the tag owners', await page.$$eval('.visual input', (els) => els.some((e) => e.value === 'tag:e2e')))
  const notes = await page.$$eval('textarea.note', (els) => els.map((e) => e.value))
  ok('comments above rules and tags are shown as notes', notes.includes('everyone can reach everything') && notes.includes('who may tag servers'), JSON.stringify(notes))
  await wait('.verdict')
  ok('the simulator gives a verdict', /ALLOWED|DENIED/.test(await text('.verdict')))
  await click('button::-p-text(Code)'); await wait('.editor > textarea')
  const code = await page.$eval('.editor > textarea', (t) => t.value)
  ok('the code tab keeps the comments', code.includes('// who may tag servers') && code.includes('// everyone can reach everything'))
  // editing in the visual tab must not drop them
  await click('button::-p-text(Visual)'); await wait('.visual')
  await page.evaluate(() => [...document.querySelectorAll('.visual .adddst button')][0]?.scrollIntoView())
  await fill('textarea.note', 'edited note'); await page.keyboard.press('Tab'); await sleep(400)
  await click('button::-p-text(Code)'); await wait('.editor > textarea')
  const code2 = await page.$eval('.editor > textarea', (t) => t.value)
  ok('editing a note in the visual tab keeps the other comments', code2.includes('// edited note') && (code2.includes('// who may tag servers') || code2.includes('// everyone can reach everything')))

  // --- network, activity, settings
  await go('network'); await wait('svg.netsvg'); await sleep(800)
  await click('button::-p-text(Traffic)'); await sleep(1500); await shot('network-traffic')
  ok('the traffic map renders', (await page.$$('svg.netsvg g.node')).length >= 2)
  await go('activity'); await wait('table.machines tbody tr'); await shot('activity')
  const evs = (await api('/api/v1/events?limit=200')).json.events.map((e) => e.type)
  ok('admin actions were logged', ['node.renamed', 'node.tags', 'node.deleted', 'node.routes', 'user.created', 'user.deleted', 'node.registered'].every((t) => evs.includes(t)))
  await go('settings'); await wait('.grid2'); await shot('settings')
  ok('settings shows DNS', (await text('.app')).includes('MagicDNS'))
} catch (e) {
  console.log('SCRIPT ERROR:', e.stack ?? e.message); results.push(['script', false])
  await shot('error').catch(() => {})
} finally {
  const real = errors.filter((e) => !/favicon|status of (400|401|403|404|409|422|500)/.test(e))
  ok('no unexpected console errors', real.length === 0, real.slice(0, 3).join(' | '))
  await browser.close()
  await cleanup().catch((e) => console.log('cleanup problem:', e.message))
}
const failed = results.filter(([, p]) => !p)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
