/**
 * 翻訳フローの仕様。
 *
 * Ollama そのものはモックし、「どの部分が翻訳され、コードブロックが
 * どう戻るか」「長文がどう分かれるか」という見え方を確かめる。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTranslate } from '../lib/translation.js'

const base = {
  maxTextChars: 4000,
  targetLanguage: 'Japanese',
  sourceLanguage: 'auto',
}

test('本文が翻訳され、コードブロックは原文のまま復元される', async () => {
  const chat = async ({ user }) => user.replace('Use this code.', 'このコードを使います。')
  const translate = createTranslate({ ...base, chat })

  const result = await translate('Use this code.\n\n```js\nconst answer = 42\n```\n\nDone.')

  assert.equal(result, 'このコードを使います。\n\n```js\nconst answer = 42\n```\n\nDone.')
})

test('最大文字数を超える本文は複数回のリクエストに分けて翻訳される', async () => {
  const calls = []
  const chat = async ({ user }) => { calls.push(user); return user }
  const translate = createTranslate({ ...base, maxTextChars: 60, chat })
  const source = `${'あ'.repeat(50)}\n\n${'い'.repeat(50)}\n\n${'う'.repeat(50)}`

  const result = await translate(source)

  assert.equal(result, source)
  assert.ok(calls.length >= 2)
  assert.ok(calls.every((call) => call.length <= 60))
})

test('分割は段落の切れ目を優先し、断片の連結で元の本文に戻る', async () => {
  const calls = []
  const chat = async ({ user }) => { calls.push(user); return user }
  const translate = createTranslate({ ...base, maxTextChars: 40, chat })
  const source = `${'あ'.repeat(30)}\n\n${'い'.repeat(30)}`

  const result = await translate(source)

  assert.equal(result, source)
  assert.deepEqual(calls, ['あ'.repeat(30) + '\n\n', 'い'.repeat(30)])
})

test('キャンセル済みの信号では Ollama を呼ばずに中断する', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  const chat = async () => { called = true; return 'x' }
  const translate = createTranslate({ ...base, chat })

  await assert.rejects(() => translate('本文', controller.signal))
  assert.equal(called, false)
})

test('system prompt には翻訳先の言語が渡される', async () => {
  let system = ''
  const chat = async (request) => { system = request.system; return 'x' }
  const translate = createTranslate({ ...base, targetLanguage: 'French', chat })

  await translate('本文')

  assert.match(system, /French/)
})
