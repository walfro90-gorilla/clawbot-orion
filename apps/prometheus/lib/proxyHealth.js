/**
 * Proxy health check — runs BEFORE any browser job to detect proxy issues fast.
 *
 * Catches:
 *   - 402 bandwidth_limit       → Webshare bandwidth exhausted
 *   - 407 proxy_auth_required   → credentials wrong/expired
 *   - 403 forbidden_by_proxy    → access denied by provider
 *   - timeout                   → proxy unreachable
 *   - connection_refused        → proxy port closed
 *   - unknown                   → other
 *
 * Without this, the scheduler would launch Playwright (heavy) and only realize
 * the proxy is broken AFTER ~30s of timeouts. Catching it via a quick HTTP HEAD
 * costs ~1-2s and gives us actionable error messages.
 */
import http  from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

const PROBE_URL    = 'http://api.ipify.org/?format=text'  // HTTP (not HTTPS) so proxy header errors are readable
const PROBE_TIMEOUT_MS = 8_000

export async function checkProxyHealth(proxyUrl) {
  if (!proxyUrl) return { ok: false, reason: 'no_proxy', detail: 'Account has no proxy_url configured' }

  let parsed
  try { parsed = new URL(proxyUrl) }
  catch { return { ok: false, reason: 'invalid_proxy_url', detail: proxyUrl } }

  const t0 = Date.now()
  const probeUrl = new URL(PROBE_URL)

  return await new Promise(resolve => {
    const auth = (parsed.username && parsed.password)
      ? `${parsed.username}:${parsed.password}`
      : null

    const req = http.request({
      host:    parsed.hostname,
      port:    parsed.port || 80,
      method:  'GET',
      path:    probeUrl.toString(),
      timeout: PROBE_TIMEOUT_MS,
      headers: {
        Host:                  probeUrl.host,
        'Proxy-Authorization': auth ? `Basic ${Buffer.from(auth).toString('base64')}` : undefined,
        'Proxy-Connection':    'Keep-Alive',
      },
    }, res => {
      let body = ''
      res.on('data', chunk => { if (body.length < 1024) body += chunk.toString('utf8') })
      res.on('end', () => {
        const latencyMs = Date.now() - t0
        const xErr    = res.headers['x-webshare-error']
        const xReason = res.headers['x-webshare-reason']

        if (res.statusCode === 200) {
          return resolve({ ok: true, reason: 'ok', detail: body.trim().slice(0, 80), latencyMs })
        }
        if (res.statusCode === 402) {
          return resolve({ ok: false, reason: 'bandwidth_limit', detail: xReason ?? body.trim().slice(0, 200), latencyMs })
        }
        if (res.statusCode === 407) {
          return resolve({ ok: false, reason: 'proxy_auth_required', detail: 'Wrong username or password', latencyMs })
        }
        if (res.statusCode === 403) {
          return resolve({ ok: false, reason: 'forbidden_by_proxy', detail: xReason ?? body.trim().slice(0, 200), latencyMs })
        }
        resolve({ ok: false, reason: `http_${res.statusCode}`, detail: body.trim().slice(0, 200), latencyMs })
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })

    req.on('error', err => {
      const msg = err.message || 'unknown'
      const latencyMs = Date.now() - t0
      let reason = 'error'
      if (/ECONNREFUSED/.test(msg))       reason = 'connection_refused'
      else if (/ETIMEDOUT|timeout/i.test(msg)) reason = 'timeout'
      else if (/ECONNRESET/.test(msg))    reason = 'connection_reset'
      else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) reason = 'dns_failure'
      resolve({ ok: false, reason, detail: msg.slice(0, 200), latencyMs })
    })

    req.end()
  })
}

/** Human-readable label for each reason, used in alerts and dashboard. */
export const PROXY_REASON_LABEL = {
  ok:                   '✓ Funcionando',
  no_proxy:             'Sin proxy configurado',
  invalid_proxy_url:    'URL del proxy con formato inválido',
  bandwidth_limit:      '🚫 Bandwidth agotado (Webshare 402) — renovar plan o esperar al reset mensual',
  proxy_auth_required:  '🔑 Credenciales del proxy inválidas (407) — usuario/contraseña incorrectos',
  forbidden_by_proxy:   '⛔ Proxy provider denegó acceso (403)',
  connection_refused:   '🔌 Proxy port cerrado — provider posiblemente caído',
  timeout:              '⏱  Proxy no responde (timeout)',
  connection_reset:     '⚡ Conexión cortada por el proxy',
  dns_failure:          '🌐 Hostname del proxy no resuelve',
}
