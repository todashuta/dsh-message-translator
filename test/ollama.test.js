/**
 * Ollama クライアントの仕様。
 *
 * ここでは実際の Ollama を起動せず、fetch の差し替えだけで
 * 「どんなリクエストを送り、どんな失敗をどう分類するか」を確かめる。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatWithOllama, OllamaError } from '../lib/ollama.js'

const base = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  system: 'system prompt',
  user: 'こんにちは',
  temperature: 0.2,
  timeoutMs: 5000,
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

test('Ollama の chat API へモデル名・非ストリーミング・メッセージを送り、本文を返す', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init: JSON.parse(init.body) })
    return jsonResponse({ message: { role: 'assistant', content: 'Hello' } })
  }

  const result = await chatWithOllama({ ...base, fetchImpl })

  assert.equal(result, 'Hello')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat')
  assert.equal(requests[0].init.model, 'qwen3:8b')
  assert.equal(requests[0].init.stream, false)
  assert.equal(requests[0].init.think, false)
  assert.deepEqual(requests[0].init.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'こんにちは' },
  ])
})

test('HTTP エラーはステータスと Ollama のエラーメッセージを含む', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'model "qwen3:8b" not found' }, 404)

  await assert.rejects(
    () => chatWithOllama({ ...base, fetchImpl }),
    (error) => {
      assert.ok(error instanceof OllamaError)
      assert.equal(error.code, 'HTTP_ERROR')
      assert.match(error.message, /HTTP 404/)
      assert.match(error.message, /not found/)
      return true
    },
  )
})

test('本文が空の応答は翻訳結果として受け付けない', async () => {
  const fetchImpl = async () => jsonResponse({ message: { role: 'assistant', content: '  ' } })

  await assert.rejects(
    () => chatWithOllama({ ...base, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'INVALID_RESPONSE')
      return true
    },
  )
})

test('Ollama が起動していない場合は接続先を示すエラーになる', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }

  await assert.rejects(
    () => chatWithOllama({ ...base, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'UNREACHABLE')
      assert.match(error.message, /127\.0\.0\.1:11434/)
      return true
    },
  )
})

test('期限を超えたリクエストは TIMEOUT として報告される', async () => {
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })

  await assert.rejects(
    () => chatWithOllama({ ...base, timeoutMs: 10, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      assert.match(error.message, /10 ms/)
      return true
    },
  )
})

test('呼び出し元がキャンセルした場合は ABORTED として区別できる', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetchImpl = async (_url, init) => {
    init.signal.throwIfAborted()
  }

  await assert.rejects(
    () => chatWithOllama({ ...base, signal: controller.signal, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'ABORTED')
      return true
    },
  )
})
