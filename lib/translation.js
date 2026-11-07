/**
 * 本文全体の翻訳フロー: コードブロックの退避 → 分割 → 逐次翻訳 → 復元。
 *
 * なぜ断片を並列に翻訳しないか:
 *   ローカルの Ollama は 1 プロセスが VRAM を共有しており、複数リクエストを
 *   同時に投げるとモデルの再ロードやメモリ不足で失敗しやすい。ターン終了後の
 *   バックグラウンド処理なので、逐次でも待ち時間は表面化しにくい。
 *
 * なぜリクエストの組み立てを外部へ渡すか:
 *   汎用モデルは system + user のチャット形式、PLaMo は PFML3 の 1 本の
 *   プロンプトと、モデルによって渡す形が違う。分割と復元の流れは同じなので、
 *   変わる部分だけを `buildRequest` として差し替える。
 */

import { protectCodeBlocks, restoreCodeBlocks, splitText } from './protocol.js'

/**
 * 翻訳器を組み立てる。
 *
 * @param {object} options
 * @param {(request: object, signal?: AbortSignal) => Promise<string>} options.chat
 *   - 1 断片を翻訳する関数。`buildRequest` の戻り値に `signal` が足されて渡る。
 * @param {(text: string) => object} options.buildRequest
 *   - 1 断片から Ollama へ渡すリクエスト本文を組み立てる関数。
 * @param {number} options.maxTextChars - 1 リクエストの最大文字数。
 * @returns {(text: string, signal?: AbortSignal) => Promise<string>} 本文を翻訳する関数。
 */
export function createTranslate({ chat, buildRequest, maxTextChars }) {
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
      translated.push(await chat({ ...buildRequest(fragment), signal }))
    }
    return restoreCodeBlocks(translated.join(''), protectedText.blocks)
  }
}
