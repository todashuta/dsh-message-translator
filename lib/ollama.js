/**
 * ローカル Ollama の `/api/chat` を 1 回だけ呼ぶ最小クライアント。
 *
 * なぜ Ollama の公式 SDK を使わないか:
 *   `ollama` パッケージはストリーミングやモデル管理まで含む分だけ依存が
 *   重く、このプラグインが必要とするのは「1 リクエスト・1 応答」だけ。
 *   Node 組み込みの fetch で十分に足りるため、依存を増やさない。
 *
 * なぜ `stream: false` を明示するか:
 *   Ollama の既定はストリーミングで、そのまま response.json() を読むと
 *   改行区切りの JSON 断片になり失敗する。翻訳は部分結果を画面へ流す必要が
 *   ないので、一括応答に固定している。
 */

/** Ollama 呼び出しの失敗を、呼び出し側が分岐できるコード付きで表す。 */
export class OllamaError extends Error {
  /**
   * @param {'UNREACHABLE' | 'TIMEOUT' | 'ABORTED' | 'HTTP_ERROR' | 'INVALID_RESPONSE'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'OllamaError'
    this.code = code
  }
}

/** ネットワーク例外を 1 行の診断メッセージへ畳む。 */
function reasonOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 1 断片を Ollama で翻訳する。
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] - テストで差し替える fetch。
 * @param {string} options.endpoint - Ollama の基底 URL（例: http://127.0.0.1:11434）。
 * @param {string} options.model - モデル名（例: qwen3:8b）。
 * @param {string} options.system - system prompt。
 * @param {string} options.user - 翻訳対象の本文。
 * @param {number} options.temperature - サンプリング温度。
 * @param {number} options.timeoutMs - 1 リクエストの期限。
 * @param {AbortSignal} [options.signal] - 呼び出し元のキャンセル。
 * @returns {Promise<string>} 翻訳結果。
 */
export async function chatWithOllama({
  fetchImpl = fetch,
  endpoint,
  model,
  system,
  user,
  temperature,
  timeoutMs,
  signal,
}) {
  const url = new URL('/api/chat', endpoint)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        // 翻訳は推論を必要としない。thinking 対応モデルで余計な
        // トークンを使わないよう明示的に切る。未対応の Ollama は
        // 未知フィールドを無視する。
        think: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        options: { temperature },
      }),
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw new OllamaError('ABORTED', 'Ollama へのリクエストがキャンセルされました')
    }
    if (timeout.aborted) {
      throw new OllamaError('TIMEOUT', `Ollama が ${timeoutMs} ms 以内に応答しませんでした`)
    }
    throw new OllamaError('UNREACHABLE', `${url.href} に接続できません: ${reasonOf(error)}`)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = `: ${body.error}`
    } catch {
      // 本文が JSON でない失敗は、ステータスだけで報告する。
    }
    throw new OllamaError('HTTP_ERROR', `Ollama が HTTP ${response.status} を返しました${detail}`)
  }

  let body
  try {
    body = await response.json()
  } catch (error) {
    if (timeout.aborted) {
      throw new OllamaError('TIMEOUT', `Ollama の応答本文が ${timeoutMs} ms 以内に完了しませんでした`)
    }
    throw new OllamaError('INVALID_RESPONSE', `Ollama の応答を JSON として読めません: ${reasonOf(error)}`)
  }

  const content = body?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new OllamaError('INVALID_RESPONSE', 'Ollama の応答に翻訳本文が含まれていません')
  }
  return content.trim()
}
