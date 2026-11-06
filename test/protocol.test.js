/**
 * 翻訳前後のテキスト加工に関する仕様。
 *
 * このファイルのテスト名は「どんな本文を、どう守り、どう戻すか」という
 * 振る舞いを表す。実装の関数名ではなく、利用者から見た結果を書いている。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  protectCodeBlocks,
  restoreCodeBlocks,
  splitText,
  translationSystemPrompt,
} from '../lib/protocol.js'

test('フェンス付きコードブロックは翻訳対象から取り除かれ、翻訳後に元の位置へ戻る', () => {
  const source = [
    '設定を変えます。',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    'これで完了です。',
  ].join('\n')

  const protectedText = protectCodeBlocks(source)
  assert.deepEqual(protectedText.blocks, ['```ts\nconst answer = 42\n```'])
  assert.match(protectedText.text, /\[\[CODE_BLOCK_0\]\]/)
  assert.doesNotMatch(protectedText.text, /const answer/)

  const restored = restoreCodeBlocks(
    protectedText.text.replace('設定を変えます。', 'Change the setting.').replace('これで完了です。', 'That is all.'),
    protectedText.blocks,
  )
  assert.equal(restored, 'Change the setting.\n\n```ts\nconst answer = 42\n```\n\nThat is all.')
})

test('コードブロックが本文中に複数あっても、それぞれ元の位置へ戻る', () => {
  const source = 'A\n```js\none()\n```\nB\n```sh\ntwo\n```\nC'
  const { text, blocks } = protectCodeBlocks(source)
  assert.equal(blocks.length, 2)
  assert.equal(restoreCodeBlocks(text, blocks), source)
})

test('閉じフェンスが無いコードブロックも末尾まで保護される', () => {
  const source = '前書き\n```js\nconst x = 1'
  const { text, blocks } = protectCodeBlocks(source)
  assert.equal(blocks.length, 1)
  assert.equal(restoreCodeBlocks(text, blocks), source)
})

test('モデルがプレースホルダを落とした場合は、コードブロックを末尾へ原文のまま追加する', () => {
  const { blocks } = protectCodeBlocks('本文\n```js\nconst x = 1\n```')
  const restored = restoreCodeBlocks('Translated body.', blocks)
  assert.match(restored, /^Translated body\./)
  assert.match(restored, /```js\nconst x = 1\n```$/)
})

test('長い本文は最大文字数を超えない断片へ分割され、連結すると元に戻る', () => {
  const paragraph = 'あ'.repeat(80)
  const source = [paragraph, paragraph, paragraph, paragraph].join('\n\n')
  const parts = splitText(source, 200)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.length <= 200))
  assert.equal(parts.join(''), source)
})

test('分割位置がサロゲートペアの途中になる場合は 1 文字手前で切る', () => {
  const source = '😀'.repeat(200)
  const parts = splitText(source, 101)
  assert.equal(parts.join(''), source)
  assert.ok(parts.every((part) => !/^[\uDC00-\uDFFF]/.test(part)))
  assert.ok(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part)))
})

test('system prompt は翻訳先の言語と、コードを変更しない指示を含む', () => {
  const prompt = translationSystemPrompt('Japanese', 'auto')
  assert.match(prompt, /Japanese/)
  assert.match(prompt, /code blocks/)
  assert.match(prompt, /\[\[CODE_BLOCK_0\]\]/)
})

test('原文の言語が指定されたときは、自動判定ではなくその言語名を伝える', () => {
  const prompt = translationSystemPrompt('Japanese', 'English')
  assert.match(prompt, /source language is English/)
  assert.doesNotMatch(prompt, /Detect the source language/)
})
