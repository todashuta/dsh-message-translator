/**
 * 本文全体の翻訳フロー: コードブロックの退避 → 分割 → 逐次翻訳 → 復元。
 *
 * なぜ断片を並列に翻訳しないか:
 *   ローカルの Ollama は 1 プロセスが VRAM を共有しており、複数リクエストを
 *   同時に投げるとモデルの再ロードやメモリ不足で失敗しやすい。ターン終了後の
 *   バックグラウンド処理なので、逐次でも待ち時間は表面化しにくい。
 */

import { protectCodeBlocks, restoreCodeBlocks, splitText, translationSystemPrompt } from './protocol.js'

/**
 * 翻訳器を組み立てる。
 *
 * @param {object} options
 * @param {(request: { system: string, user: string, signal?: AbortSignal }) => Promise<string>} options.chat
 *   - 1 断片を翻訳する関数。テストではモック、本番では Ollama 呼び出し。
 * @param {number} options.maxTextChars - 1 リクエストの最大文字数。
 * @param {string} options.targetLanguage - 翻訳先の言語名。
 * @param {string} options.sourceLanguage - 原文の言語名。`auto` なら自動判定。
 * @returns {(text: string, signal?: AbortSignal) => Promise<string>} 本文を翻訳する関数。
 */
export function createTranslate({ chat, maxTextChars, targetLanguage, sourceLanguage }) {
  const system = translationSystemPrompt(targetLanguage, sourceLanguage)
  return async function translate(text, signal) {
    const protectedText = protectCodeBlocks(text)
    const fragments = splitText(protectedText.text, maxTextChars)
    const translated = []
    for (const fragment of fragments) {
      signal?.throwIfAborted()
      if (fragment.trim() === '') {
        translated.push(fragment)
        continue
      }
      translated.push(await chat({ system, user: fragment, signal }))
    }
    return restoreCodeBlocks(translated.join(''), protectedText.blocks)
  }
}
