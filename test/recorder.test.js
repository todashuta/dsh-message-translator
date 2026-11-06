/**
 * セッションイベントから翻訳記録を作る部分の仕様。
 *
 * 「どの回答が、いつ翻訳され、どんな record として残るか」を、モックの
 * translate / appendRecord で確かめる。実際の Ollama やストレージは使わない。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRecorder } from '../lib/recorder.js'

const session = (id = 's1') => ({ id })

const assistantMessage = (turn, step, text, seq) => ({
  type: 'assistant/message',
  seq,
  time: 0,
  data: { turn, step, message: { content: [{ type: 'text', text }] } },
})

const turnEnd = (turn, kind = 'completed') => ({
  type: 'turn/end',
  seq: 999,
  time: 0,
  data: { turn, reason: { kind } },
})

const turnStart = () => ({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })

function recorderFor({ translate, maxConcurrent } = {}) {
  const records = []
  const warnings = []
  const flushes = []
  const recorder = createRecorder({
    appendRecord: (target, type, data) => {
      records.push({ session: target.id, type, data })
      return records.length
    },
    flush: async (target) => { flushes.push(target.id); return true },
    translate: translate ?? (async (text) => `[ja] ${text}`),
    logger: { warn: (message) => warnings.push(message) },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    recipe: {
      model: 'qwen3:8b',
      targetLanguage: 'Japanese',
      sourceLanguage: 'auto',
      recipe: 'ollama-chat-v1:qwen3:8b:Japanese:auto',
    },
    lifetime: new AbortController().signal,
  })
  return { recorder, records, warnings, flushes }
}

test('完了したターンの最終回答が翻訳され、plugin record として記録される', async () => {
  const { recorder, records, flushes } = recorderFor()
  const target = session()

  recorder.onEvent(target, assistantMessage(1, 1, 'Hello', 10))
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records.length, 1)
  assert.equal(records[0].session, 's1')
  assert.equal(records[0].type, 'plugin:message-translator/translation')
  assert.deepEqual(records[0].data, {
    turn: 1,
    step: 1,
    messageSeq: 10,
    text: '[ja] Hello',
    model: 'qwen3:8b',
    targetLanguage: 'Japanese',
    sourceLanguage: 'auto',
    recipe: 'ollama-chat-v1:qwen3:8b:Japanese:auto',
    createdAt: '2026-01-01T00:00:00.000Z',
  })
  assert.deepEqual(flushes, ['s1'])
})

test('途中の assistant メッセージではなく、ターンの最後の本文だけを翻訳する', async () => {
  const { recorder, records } = recorderFor()
  const target = session()

  recorder.onEvent(target, assistantMessage(1, 1, 'First step', 10))
  recorder.onEvent(target, assistantMessage(1, 2, 'Final answer', 12))
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records.length, 1)
  assert.equal(records[0].data.text, '[ja] Final answer')
  assert.equal(records[0].data.messageSeq, 12)
})

test('reasoning ブロックは翻訳対象に含めない', async () => {
  const { recorder, records } = recorderFor()
  const target = session()

  recorder.onEvent(target, {
    type: 'assistant/message',
    seq: 10,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: 'thinking...' },
          { type: 'text', text: 'Answer' },
        ],
      },
    },
  })
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records[0].data.text, '[ja] Answer')
})

test('中断・失敗したターンは翻訳せず、記録も残さない', async () => {
  for (const kind of ['aborted', 'error', 'blocked']) {
    const { recorder, records } = recorderFor()
    const target = session()

    recorder.onEvent(target, assistantMessage(1, 1, 'Partial', 10))
    recorder.onEvent(target, turnEnd(1, kind))
    await recorder.dispose()

    assert.equal(records.length, 0, `${kind} のターンで記録された`)
  }
})

test('直前のターンの回答が別のターンの終了に混ざらない', async () => {
  const { recorder, records } = recorderFor()
  const target = session()

  recorder.onEvent(target, assistantMessage(2, 1, 'Other turn', 10))
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records.length, 0)
})

test('ターン開始時に前のターンの未翻訳本文を破棄する', async () => {
  const { recorder, records } = recorderFor()
  const target = session()

  recorder.onEvent(target, assistantMessage(1, 1, 'Old', 10))
  recorder.onEvent(target, turnStart())
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records.length, 0)
})

test('翻訳に失敗した場合は record を追記せず、警告だけ残す', async () => {
  const { recorder, records, warnings } = recorderFor({
    translate: async () => { throw new Error('Ollama が落ちています') },
  })
  const target = session()

  recorder.onEvent(target, assistantMessage(1, 1, 'Hello', 10))
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /turn 1/)
  assert.match(warnings[0], /Ollama が落ちています/)
})

test('空の回答は翻訳せず、記録もしない', async () => {
  const { recorder, records } = recorderFor()
  const target = session()

  recorder.onEvent(target, assistantMessage(1, 1, '   ', 10))
  recorder.onEvent(target, turnEnd(1))
  await recorder.dispose()

  assert.equal(records.length, 0)
})

test('セッションが閉じたら実行中の翻訳をキャンセルし、警告を出さない', async () => {
  const { recorder, records, warnings } = recorderFor({
    translate: (text, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const target = session()

  recorder.onEvent(target, assistantMessage(1, 1, 'Hello', 10))
  recorder.onEvent(target, turnEnd(1))
  recorder.disposeSession(target)
  await recorder.dispose()

  assert.equal(records.length, 0)
  assert.equal(warnings.length, 0)
})

test('複数セッションの翻訳は互いに混ざらない', async () => {
  const { recorder, records } = recorderFor()
  const first = session('a')
  const second = session('b')

  recorder.onEvent(first, assistantMessage(1, 1, 'A', 1))
  recorder.onEvent(second, assistantMessage(1, 1, 'B', 2))
  recorder.onEvent(first, turnEnd(1))
  recorder.onEvent(second, turnEnd(1))
  await recorder.dispose()

  assert.deepEqual(records.map((record) => [record.session, record.data.text]), [
    ['a', '[ja] A'],
    ['b', '[ja] B'],
  ])
})
