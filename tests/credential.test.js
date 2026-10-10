/**
 * 凭据层单测：AAD 构造、加解密往返、文档归类、凭据归一化。
 *
 * 加密部分用测试内自建的封装函数做**真实往返**：封装用导出的 `buildAad`，
 * 解封用导出的 `openAuthField`。这样一旦 AAD 的字节序被改动，测试会立刻失败
 * —— 那是让所有真实 envelope 都解不开的那类改动。
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AuthFormat, buildAad, classifyDesktopDocument, deriveProtectorKey, openAuthField,
  parseAtRestPayload, parseWrappedField, parseWorkBuddyAuth, credentialIdentity,
  registryLookupEnabled, electronCachePath,
} from '../src/credential.js'

/** 用被测的 AAD 规则封装一个字段。 */
function seal(secret, plaintext, suite = 1) {
  const key = deriveProtectorKey(secret)
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({
      suite,
      keyId,
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    })).toString('base64'),
  }
}

const SECRET = Buffer.alloc(32, 7).toString('base64')

test('AAD 结构固定：改动字节序会让所有 envelope 解不开', () => {
  const aad = buildAad('0123456789abcdef', 1)
  assert.equal(aad.subarray(0, 7).toString('ascii'), 'WB-AAD\0')
  assert.equal(aad[7], 1)
  // 长度前缀 'WBEV1' = 5
  assert.equal(aad.readUInt32BE(8), 5)
  assert.equal(aad.subarray(12, 17).toString('utf8'), 'WBEV1')
  // 结尾三字节固定
  assert.deepEqual([...aad.subarray(-3)], [2, 0, 0])
})

test('加密字段往返：封装后可原样解开', () => {
  const key = deriveProtectorKey(SECRET)
  const wrapped = seal(SECRET, 'ya29.example-token')
  const parsed = parseWrappedField(wrapped)
  assert.notEqual(parsed, undefined)
  assert.equal(openAuthField(key, parsed.envelope), 'ya29.example-token')
})

test('未知 suite / 非标准 keyId 不被认领为加密', () => {
  assert.equal(parseWrappedField(seal(SECRET, 'x', 2)), undefined)
  const key = deriveProtectorKey(SECRET)
  assert.equal(parseWrappedField({ $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({
    suite: 1, keyId: 'NOTHEX', nonce: Buffer.alloc(12).toString('base64'),
    authTag: Buffer.alloc(16).toString('base64'), ciphertext: Buffer.from('x').toString('base64'),
  })).toString('base64') }), undefined)
  assert.ok(key.length === 32)
})

test('错误密钥解不开（认证标签校验生效）', () => {
  const wrapped = seal(SECRET, 'secret')
  const other = deriveProtectorKey(Buffer.alloc(32, 9).toString('base64'))
  assert.equal(openAuthField(other, parseWrappedField(wrapped).envelope), undefined)
})

test('文档归类：明文 / 加密 / 无法识别', () => {
  const plain = JSON.stringify({ auth: { accessToken: 'abc', expiresAt: 1793928083086 }, account: { uid: 'u1' } })
  assert.equal(classifyDesktopDocument(plain).format, AuthFormat.PLAINTEXT)

  const encrypted = JSON.stringify({
    auth: { accessToken: seal(SECRET, 'abc'), refreshToken: seal(SECRET, 'ref') },
    account: { uid: 'u1' },
  })
  const classified = classifyDesktopDocument(encrypted)
  assert.equal(classified.format, AuthFormat.ENCRYPTED)
  assert.equal(classified.fields.length, 2)

  assert.equal(classifyDesktopDocument('not json').format, AuthFormat.UNRECOGNIZED)
  assert.equal(classifyDesktopDocument('{"auth":{"other":1}}').format, AuthFormat.UNRECOGNIZED)
  // 扁平面板形态
  assert.equal(classifyDesktopDocument(JSON.stringify({ accessToken: 'abc' })).format, AuthFormat.PLAINTEXT)
})

test('凭据归一化：嵌套与扁平两种形态都认', () => {
  const nested = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: 'tok', refreshToken: 'ref', expiresAt: 1793928083086, domain: 'copilot.tencent.com' },
    account: { uid: 'u-1', enterpriseId: 'e-9', nickname: 'n' },
  }))
  assert.equal(nested.accessToken, 'tok')
  assert.equal(nested.uid, 'u-1')
  assert.equal(nested.enterpriseId, 'e-9')
  assert.equal(nested.expiresAtMs, 1793928083086)

  const flat = parseWorkBuddyAuth(JSON.stringify({ accessToken: 'tok2', expiresAt: 1793928 }))
  assert.equal(flat.accessToken, 'tok2')
  // 秒级时间戳会自动放大到毫秒
  assert.equal(flat.expiresAtMs, 1793928000)
  assert.equal(flat.uid, '')

  assert.equal(parseWorkBuddyAuth('{"auth":{}}'), undefined)
  assert.equal(parseWorkBuddyAuth('{'), undefined)
})

test('静态密钥 payload 校验：长度、canonical base64、非全零', () => {
  const good = Buffer.alloc(32, 3).toString('base64')
  assert.notEqual(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: good })), undefined)
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 2, atRestSecretKey: good })), undefined)
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(16, 3).toString('base64') })), undefined)
  assert.equal(parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 0).toString('base64') })), undefined)
  assert.equal(parseAtRestPayload('nope'), undefined)
})

test('凭据身份键在账号切换时会变化', () => {
  assert.equal(credentialIdentity({ uid: 'a', enterpriseId: 'x' }), 'a:x')
  assert.equal(credentialIdentity({ uid: 'a' }), 'a:')
  assert.notEqual(credentialIdentity({ uid: 'a' }), credentialIdentity({ uid: 'b' }))
})

test('注册表发现策略默认关闭，只在显式置位时打开', () => {
  // 默认关：reg.exe 是安全策略最常拉黑的可执行文件，默认去 spawn 它会在
  // 宿主日志里留下「程序被策略阻止」告警，而那条路径本来就不可能成功。
  assert.equal(registryLookupEnabled({}), false)
  assert.equal(registryLookupEnabled({ WORKBUDDY_ELECTRON_REGISTRY: '0' }), false)
  assert.equal(registryLookupEnabled({ WORKBUDDY_ELECTRON_REGISTRY: 'true' }), false)
  assert.equal(registryLookupEnabled({ WORKBUDDY_ELECTRON_REGISTRY: '1' }), true)
})

test('Electron 路径缓存落在插件状态目录下，且随 RIVET_HOME 迁移', () => {
  const previous = process.env.RIVET_HOME
  try {
    process.env.RIVET_HOME = join(tmpdir(), `wb-cache-${randomBytes(4).toString('hex')}`)
    const path = electronCachePath()
    assert.equal(path, join(process.env.RIVET_HOME, 'workbuddy', 'electron-path.json'))
  } finally {
    if (previous === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = previous
  }
})
