/**
 * 网关单测：鉴权、入站加固、OpenAI 兼容路由、上游失败映射、流式转发。
 *
 * 用真实的 http 服务与真实的 fetch，只把「凭据源 + 上游」替换成桩件 —— 这样
 * 被测的是网关自身的路由与守卫，而不是被 mock 掉的它们。
 *
 * Host 头必须用原始 http 客户端发送：Node 的 fetch 不允许覆盖 Host。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { cleanupTmpDir, makeTmpDir } from './helpers/tmp.js'
import {
  createGatewayServer, ensureGateway, HEALTH_MARKER, inspectPort, portBusy,
  readGatewayState, stopGateway, stopInProcessGateway, writeGatewayState,
} from '../src/gateway.js'
import { ErrorKind } from '../src/upstream.js'
import { PLUGIN_VERSION } from '../src/version.js'

const TOKEN = 'wb-test-token-0123456789'

/** 构造一个可控的凭据源桩件。 */
function stubSources(overrides = {}) {
  return {
    active: async () => ({
      variant: { id: 'workbuddy', displayName: 'WorkBuddy' },
      credential: { uid: 'u-1', domain: 'copilot.tencent.com', expiresAtMs: Date.now() + 3600_000 },
    }),
    catalogFor: async () => ({
      models: [
        { id: 'deepseek-v4.1-flash', contextWindow: 1000000, maxTokens: 128000, reasoningEffort: 'high', supportsVision: true },
        { id: 'glm-5.3', contextWindow: 1000000, maxTokens: 64000, reasoningEffort: 'high', supportsVision: true },
      ],
      source: 'live',
      error: undefined,
    }),
    summaries: async () => [{ variant: 'workbuddy', displayName: 'WorkBuddy', signedIn: true }],
    client: {
      chatStream: async () => {
        const body = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        return { ok: true, response: new Response(body, { status: 200 }) }
      },
    },
    ...overrides,
  }
}

let server
let port

before(async () => {
  server = createGatewayServer({ sources: stubSources(), token: TOKEN, version: '9.9.9' })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => { await new Promise(resolve => server.close(resolve)) })

/** 原始 http 请求，允许自定义 Host。 */
function raw({ method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const auth = { Authorization: `Bearer ${TOKEN}`, Host: `127.0.0.1:${port}` }

test('缺少令牌被拒', async () => {
  const response = await raw({ path: '/v1/models', headers: { Host: `127.0.0.1:${port}` } })
  assert.equal(response.status, 401)
  assert.equal(JSON.parse(response.text).error.type, 'unauthorized')
})

test('错误令牌被拒，长度相同也不放过', async () => {
  const response = await raw({ path: '/v1/models', headers: { Authorization: `Bearer ${'x'.repeat(TOKEN.length)}`, Host: `127.0.0.1:${port}` } })
  assert.equal(response.status, 401)
})

test('非回环 Host 被拒（DNS rebinding 防护）', async () => {
  const response = await raw({ path: '/healthz', headers: { ...auth, Host: 'evil.example.com' } })
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.text).error.type, 'host_not_allowed')
})

test('非回环 Origin 被拒', async () => {
  const response = await raw({ path: '/healthz', headers: { ...auth, Origin: 'https://evil.example.com' } })
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.text).error.type, 'origin_not_allowed')
})

test('回环 Origin 放行', async () => {
  const response = await raw({ path: '/healthz', headers: { ...auth, Origin: `http://127.0.0.1:${port}` } })
  assert.equal(response.status, 200)
})

test('healthz 带标记与账号信息', async () => {
  const response = await raw({ path: '/healthz', headers: auth })
  const body = JSON.parse(response.text)
  assert.equal(body.marker, HEALTH_MARKER)
  assert.equal(body.version, '9.9.9')
  assert.equal(body.signedIn, true)
  assert.equal(body.variant, 'workbuddy')
  assert.equal(body.models, 2)
})

test('/v1/models 返回 OpenAI 形态列表', async () => {
  const response = await raw({ path: '/v1/models', headers: auth })
  const body = JSON.parse(response.text)
  assert.equal(body.object, 'list')
  assert.deepEqual(body.data.map(m => m.id), ['deepseek-v4.1-flash', 'glm-5.3'])
  assert.equal(body.data[0].object, 'model')
})

test('/_gw/models 返回完整模型配置（供接入写配置）', async () => {
  const response = await raw({ path: '/_gw/models', headers: auth })
  const body = JSON.parse(response.text)
  assert.equal(body.variant, 'workbuddy')
  assert.equal(body.source, 'live')
  assert.equal(body.models[0].contextWindow, 1000000)
  assert.equal(body.account.uid, 'u-1')
})

test('chat：非 JSON Content-Type 被拒', async () => {
  const response = await raw({
    method: 'POST', path: '/v1/chat/completions',
    headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}',
  })
  assert.equal(response.status, 415)
})

test('chat：成功时转发 SSE 并保留 [DONE]', async () => {
  const response = await raw({
    method: 'POST', path: '/v1/chat/completions',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /text\/event-stream/)
  assert.match(response.text, /"content":"hi"/)
  assert.match(response.text, /\[DONE\]/)
})

test('chat：上游失败按分类映射状态码，且会话失效保留状态说明', async () => {
  const cases = [
    [{ ok: false, status: 402, kind: ErrorKind.HARD_CREDIT, message: '积分不足' }, 402],
    [{ ok: false, status: 401, kind: ErrorKind.SESSION_DEAD, message: '登录失效' }, 401],
    [{ ok: false, status: 429, kind: ErrorKind.SOFT_RATE, message: '限流' }, 429],
    [{ ok: false, status: 500, kind: ErrorKind.SERVER, message: '上游 5xx' }, 502],
    [{ ok: false, status: 400, kind: ErrorKind.CLIENT, message: '非法请求' }, 400],
  ]
  for (const [upstreamResult, expected] of cases) {
    const local = createGatewayServer({
      sources: stubSources({ client: { chatStream: async () => upstreamResult } }),
      token: TOKEN,
      version: '9.9.9',
    })
    await new Promise(resolve => local.listen(0, '127.0.0.1', resolve))
    const localPort = local.address().port
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: localPort, path: '/v1/chat/completions', method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Host: `127.0.0.1:${localPort}` },
      }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', c => { text += c })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.write(JSON.stringify({ model: 'm', messages: [] }))
      req.end()
    })
    assert.equal(response.status, expected, `kind=${upstreamResult.kind}`)
    assert.equal(response.body.error.code, upstreamResult.kind)
    // 401/403 的非会话失效错误不得把裸数字塞进文案（会被读成「API Key 无效」）
    if (upstreamResult.status === 401 || upstreamResult.status === 403) {
      assert.equal(response.body.error.message.includes(`http ${upstreamResult.status}`), upstreamResult.kind === ErrorKind.SESSION_DEAD)
    }
    await new Promise(resolve => local.close(resolve))
  }
})

test('chat：未登录时返回 401 not_signed_in', async () => {
  const local = createGatewayServer({
    sources: stubSources({ active: async () => ({ error: new Error('未找到认证文件') }) }),
    token: TOKEN,
    version: '9.9.9',
  })
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve))
  const localPort = local.address().port
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: localPort, path: '/v1/chat/completions', method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Host: `127.0.0.1:${localPort}` },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', c => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.write('{}')
    req.end()
  })
  assert.equal(response.status, 401)
  assert.equal(response.body.error.code, 'not_signed_in')
  await new Promise(resolve => local.close(resolve))
})

test('未知路由返回 404', async () => {
  const response = await raw({ path: '/v1/embeddings', headers: auth })
  assert.equal(response.status, 404)
})

/* ------------------------------------------------------------------ *
 * 归属判定：匿名指纹、端口占用探测、与残留实例的分道
 * ------------------------------------------------------------------ */

test('匿名 healthz 只回指纹：不含账号、模型数与 pid', async () => {
  const response = await raw({ path: '/healthz', headers: { Host: `127.0.0.1:${port}` } })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.marker, HEALTH_MARKER)
  assert.equal(body.version, '9.9.9')
  assert.equal(body.anonymous, true)
  // 指纹的全部内容就是这三个字段 —— 多一个都算泄露。
  assert.deepEqual(Object.keys(body).sort(), ['anonymous', 'marker', 'ok', 'version'])
  for (const leaked of ['pid', 'uid', 'models', 'variant', 'signedIn', 'variants']) {
    assert.equal(leaked in body, false, `匿名响应不应包含 ${leaked}`)
  }
})

test('带令牌的 healthz 才给出 pid（终止进程只依据可信来源）', async () => {
  const body = JSON.parse((await raw({ path: '/healthz', headers: auth })).text)
  assert.equal(body.pid, process.pid)
})

test('匿名放行只限 healthz：其余路由仍需令牌', async () => {
  for (const path of ['/v1/models', '/_gw/models']) {
    const response = await raw({ path, headers: { Host: `127.0.0.1:${port}` } })
    assert.equal(response.status, 401, path)
  }
})

test('匿名 healthz 仍然受 Host / Origin 守卫约束', async () => {
  const badHost = await raw({ path: '/healthz', headers: { Host: 'evil.example.com' } })
  assert.equal(badHost.status, 403)
  const badOrigin = await raw({ path: '/healthz', headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example.com' } })
  assert.equal(badOrigin.status, 403)
})

test('portBusy：有人监听为真，没人监听为假', async () => {
  assert.equal(await portBusy(port), true)
  const idle = createGatewayServer({ sources: stubSources(), token: TOKEN })
  await new Promise(resolve => idle.listen(0, '127.0.0.1', resolve))
  const idlePort = idle.address().port
  await new Promise(resolve => idle.close(resolve))
  assert.equal(await portBusy(idlePort), false)
})

test('inspectPort：空闲 / 同门不同令牌 / 别人的服务，三种要分得开', async () => {
  const idle = createGatewayServer({ sources: stubSources(), token: TOKEN, version: '9.9.9' })
  await new Promise(resolve => idle.listen(0, '127.0.0.1', resolve))
  const probePort = idle.address().port

  // 同一端口上是我们自己的服务，但用的是另一个令牌世代。
  const stray = await inspectPort(probePort, 'wb-a-different-token-generation-x')
  assert.equal(stray.kind, 'stale')
  assert.equal(stray.health.version, '9.9.9')

  // 令牌对得上就是可复用的自己人。
  assert.equal((await inspectPort(probePort, TOKEN)).kind, 'ours')

  await new Promise(resolve => idle.close(resolve))
  assert.equal((await inspectPort(probePort, TOKEN)).kind, 'free')

  // 非本插件的监听者：没有指纹，但端口确实有人 → foreign。
  const foreign = http.createServer((_req, res) => res.end('hi'))
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve))
  const foreignPort = foreign.address().port
  assert.equal((await inspectPort(foreignPort, TOKEN)).kind, 'foreign')
  await new Promise(resolve => foreign.close(resolve))
})

test('ensureGateway 拒绝与令牌不一致的同门实例共用端口（这正是「有时 401」的根因）', async () => {
  const home = makeTmpDir('wb-gateway-test-')
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home

  // 占住一个端口：本插件的服务，但令牌已被换掉（状态文件丢过、或换过世代）。
  const squatter = createGatewayServer({ sources: stubSources(), token: TOKEN, version: '9.9.9' })
  await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve))
  const squattedPort = squatter.address().port

  try {
    const result = await ensureGateway({
      port: squattedPort,
      token: 'wb-other-generation-token-000001',
      version: PLUGIN_VERSION,
      startTimeoutMs: 10_000,
    })
    assert.notEqual(result.port, squattedPort, '不得与身份不明的监听者共用端口')
    assert.equal(
      result.encounters.some(entry => entry.port === squattedPort && entry.kind === 'stale'),
      true,
      '应把该端口如实记录为「同门但令牌不一致」',
    )
    // 新端口上是干净的自己人。
    assert.equal((await inspectPort(result.port, result.token)).kind, 'ours')
  } finally {
    // 收尾必须在 finally 里：`ensureGateway` 在派生不可用时回退为**进程内**
    // 监听，此时 socket 由本进程持有。断言一旦失败而这里没执行，事件循环就
    // 永远不空，整个测试进程挂到超时（实测 90s），报错信息也全被吞掉。
    await stopGateway()
    await stopInProcessGateway()
    await new Promise(resolve => squatter.close(resolve))
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    cleanupTmpDir(home)
  }
})

/**
 * 兜底收尾：即便某个用例中途抛错，也不给测试进程留下监听或守护进程。
 *
 * 这里刻意再杀一次状态文件里的 pid —— `stopGateway` 会先 `clearGatewayState()`，
 * 若它本身失败（例如 pid 已被回收给别的进程），状态文件就是最后一条线索。
 */
after(async () => {
  await stopInProcessGateway()
  await stopGateway()
})

test('没有进程内实例时，stopInProcessGateway 如实报告而不是假装成功', async () => {
  const result = await stopInProcessGateway()
  assert.equal(result.stopped, false)
  assert.match(result.reason, /没有/u)
})

test('状态文件指向本进程时，stopGateway 走进程内路径并清掉状态（不会挂住事件循环）', async () => {
  const home = makeTmpDir('wb-gateway-test-')
  const previousHome = process.env.RIVET_HOME
  process.env.RIVET_HOME = home
  try {
    writeGatewayState({ version: 1, port: 59999, token: TOKEN, pid: process.pid, mode: 'in-process', startedAt: Date.now() })
    const result = await stopGateway()
    assert.equal(result.mode, 'in-process')
    assert.equal(result.port, 59999)
    // 状态文件必须被清掉，否则下次接入会以为「有个 59999 上的实例」。
    assert.equal(readGatewayState(), undefined)
  } finally {
    if (previousHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previousHome
    cleanupTmpDir(home)
  }
})
