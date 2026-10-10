/**
 * 请求体归一化 / 错误分类 / 目录解析单测。
 *
 * 这些是「上游怪癖」的唯一收敛点，也是回归成本最低的地方：每一条断言都对应
 * 一个实测过的线上约束（强制流式、拒绝 developer、tool_choice 只收字符串）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ErrorKind, classifyUpstreamError, extractDisplayErrorMessage,
  prepareChatBody, prepareInternationalChatBody, statusForKind,
} from '../src/upstream.js'
import { fallbackModels, normalizeEffort, parseCatalog, toTianshuModel } from '../src/models.js'

test('请求体归一化：强制流式并剥掉 stream_options', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm', stream: false, stream_options: { include_usage: true }, messages: [],
  })))
  assert.equal(body.stream, true)
  assert.equal('stream_options' in body, false)
})

test('请求体归一化：developer 角色改写为 system（上游否则 400/11128）', () => {
  const body = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm',
    messages: [{ role: 'developer', content: 'sys' }, { role: 'user', content: 'hi' }],
  })))
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user'])
})

test('请求体归一化：tool_choice 压成字符串，none 时连 tools 一起摘掉', () => {
  const named = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm', tool_choice: { type: 'function', function: { name: 'read_file' } }, messages: [],
  })))
  assert.equal(named.tool_choice, 'read_file')

  const auto = JSON.parse(prepareChatBody(JSON.stringify({ model: 'm', tool_choice: { type: 'auto' }, messages: [] })))
  assert.equal(auto.tool_choice, 'auto')

  const none = JSON.parse(prepareChatBody(JSON.stringify({
    model: 'm', tool_choice: { type: 'none' }, tools: [{ type: 'function' }], messages: [],
  })))
  assert.equal('tool_choice' in none, false)
  assert.equal('tools' in none, false)

  const unknown = JSON.parse(prepareChatBody(JSON.stringify({ model: 'm', tool_choice: { type: 'weird' }, messages: [] })))
  assert.equal('tool_choice' in unknown, false)
})

test('非 JSON 请求体原样返回（上游会用 400 拒绝它）', () => {
  assert.equal(prepareChatBody('not json at all'), 'not json at all')
  assert.equal(prepareChatBody('[1,2,3]'), '[1,2,3]')
})

test('国际版：补系统提示并剔除被拒的 off 档', () => {
  const body = JSON.parse(prepareInternationalChatBody(JSON.stringify({
    model: 'm', reasoning_effort: 'off', messages: [{ role: 'user', content: 'hi' }],
  })))
  assert.equal('reasoning_effort' in body, false)
  assert.equal(body.messages[0].role, 'system')

  // 已有 system 时不重复插入
  const withSystem = JSON.parse(prepareInternationalChatBody(JSON.stringify({
    model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
  })))
  assert.equal(withSystem.messages.filter(m => m.role === 'system').length, 1)

  // 国内版不动 reasoning_effort
  const cn = JSON.parse(prepareChatBody(JSON.stringify({ model: 'm', reasoning_effort: 'off', messages: [] })))
  assert.equal(cn.reasoning_effort, 'off')
})

test('错误分类：状态码与业务标记', () => {
  assert.equal(classifyUpstreamError(402, ''), ErrorKind.HARD_CREDIT)
  assert.equal(classifyUpstreamError(401, 'whatever'), ErrorKind.SESSION_DEAD)
  assert.equal(classifyUpstreamError(429, ''), ErrorKind.SOFT_RATE)
  assert.equal(classifyUpstreamError(404, ''), ErrorKind.NOT_FOUND)
  assert.equal(classifyUpstreamError(500, ''), ErrorKind.SERVER)
  assert.equal(classifyUpstreamError(400, ''), ErrorKind.CLIENT)
  // 死会话被答成 403 时靠标记抓到
  assert.equal(classifyUpstreamError(403, '{"msg":"Offline user session not found"}'), ErrorKind.SESSION_DEAD)
  // 中文欠费文案
  assert.equal(classifyUpstreamError(403, '{"msg":"积分不足"}'), ErrorKind.HARD_CREDIT)
})

test('失败分类映射到下游状态码', () => {
  assert.equal(statusForKind(ErrorKind.HARD_CREDIT), 402)
  assert.equal(statusForKind(ErrorKind.SESSION_DEAD), 401)
  assert.equal(statusForKind(ErrorKind.CLIENT), 400)
})

test('错误文案提取优先本地化 displayMsg', () => {
  const body = JSON.stringify({ msg: 'fallback', displayMsg: { zh: '安全审查未通过', en: 'blocked' } })
  assert.equal(extractDisplayErrorMessage(body), '安全审查未通过')
  assert.equal(extractDisplayErrorMessage(JSON.stringify({ msg: 'plain' })), 'plain')
  assert.equal(extractDisplayErrorMessage('not json'), undefined)
  assert.equal(extractDisplayErrorMessage('{}'), undefined)
})

test('effort 归一化：xhigh 映射到 max', () => {
  assert.equal(normalizeEffort('xhigh'), 'max')
  assert.equal(normalizeEffort('HIGH'), 'high')
  assert.equal(normalizeEffort('bogus'), undefined)
  assert.equal(normalizeEffort(undefined), undefined)
})

test('模型行映射：上下文/输出夹取、视觉、档位', () => {
  const model = toTianshuModel({
    id: 'x', maxInputTokens: 200000, maxOutputTokens: 500000,
    supportsImages: true, onlyReasoning: true,
    reasoning: { defaultEffort: 'xhigh', supportedEfforts: ['low', 'xhigh'] },
  })
  assert.equal(model.id, 'x')
  assert.equal(model.contextWindow, 200000)
  // 输出上限不得高于上下文窗口
  assert.equal(model.maxTokens, 200000)
  assert.equal(model.supportsVision, true)
  assert.equal(model.reasoningEffort, 'max')
  // 已废弃的 alias 绝不写进配置
  assert.equal('alias' in model, false)
})

test('目录解析：CLI 名册与模型行的交集', () => {
  const document = {
    code: 0,
    data: {
      agents: [{ name: 'cli', models: ['a', 'b', 'ghost'] }],
      models: [
        { id: 'default', maxInputTokens: 200000, maxOutputTokens: 24000 },
        { id: 'a', maxInputTokens: 1000000, maxOutputTokens: 128000, supportsImages: true },
        { id: 'b', maxInputTokens: 192000, maxOutputTokens: 64000 },
      ],
    },
  }
  const parsed = parseCatalog(document)
  // 'ghost' 只在名册里、没有模型行 → 跳过而不是猜；'default' 不在 CLI 名册 → 不列
  assert.deepEqual(parsed.models.map(m => m.id), ['a', 'b'])
  assert.equal(parsed.models[0].contextWindow, 1000000)
})

test('目录解析：裸文档形态与空文档', () => {
  const bare = parseCatalog({ agents: [{ name: 'cli', models: ['a'] }], models: [{ id: 'a', maxInputTokens: 1000, maxOutputTokens: 500 }] })
  assert.deepEqual(bare.models.map(m => m.id), ['a'])

  const empty = parseCatalog({ code: 0, data: {} })
  assert.deepEqual(empty.models, [])
  assert.notEqual(empty.reason, undefined)

  // 没有 agents 段时退回全量 models，至少不返回空名册
  const noAgents = parseCatalog({ models: [{ id: 'z', maxInputTokens: 1000, maxOutputTokens: 500 }] })
  assert.deepEqual(noAgents.models.map(m => m.id), ['z'])
})

test('兜底名册按变体区分且字段合法', () => {
  const cn = fallbackModels({ region: 'cn' })
  const ai = fallbackModels({ region: 'global' })
  assert.ok(cn.length > 0 && ai.length > 0)
  assert.notEqual(cn[0].id, ai[0].id)
  for (const model of cn) {
    assert.ok(model.contextWindow > 0)
    assert.ok(model.maxTokens <= model.contextWindow)
  }
})
