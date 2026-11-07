/**
 * ローカル Ollama の API を 1 回だけ呼ぶ最小クライアント。
 *
 * 2 つの呼び出し方がある:
 *   - `chatWithOllama`: `/api/chat`。汎用モデル向け。system/user の
 *     メッセージを渡し、Ollama のチャットテンプレートに任せる。
 *   - `generateWithOllama`: `/api/generate` + `raw: true`。PLaMo 3 Translate
 *     のように、チャットテンプレートではなく自分で組み立てたプロンプトを
 *     そのまま渡したいモデル向け。
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
 * Ollama へ JSON を POST し、応答の JSON を返す。
 *
 * 期限切れとキャンセルを分けて報告するのは、前者は設定（timeoutMs）の
 * 見直し、後者はセッション終了による正常な中断だから。呼び出し側で
 * 扱いを変えられるよう、OllamaError の code に分けて載せる。
 *
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl
 * @param {string} options.endpoint - 基底 URL。
 * @param {string} options.path - `/api/chat` または `/api/generate`。
 * @param {object} options.payload
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>} 応答の JSON。
 */
async function postOllama({ fetchImpl, endpoint, path, payload, timeoutMs, signal }) {
  const url = new URL(path, endpoint)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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

  try {
    return await response.json()
  } catch (error) {
    if (timeout.aborted) {
      throw new OllamaError('TIMEOUT', `Ollama の応答本文が ${timeoutMs} ms 以内に完了しませんでした`)
    }
    throw new OllamaError('INVALID_RESPONSE', `Ollama の応答を JSON として読めません: ${reasonOf(error)}`)
  }
}

/**
 * 汎用モデル向けに `/api/chat` を 1 回呼ぶ。
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] - テストで差し替える fetch。
 * @param {string} options.endpoint - Ollama の基底 URL。
 * @param {string} options.model - モデル名。
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
  const body = await postOllama({
    fetchImpl,
    endpoint,
    path: '/api/chat',
    timeoutMs,
    signal,
    payload: {
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
    },
  })

  const content = body?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new OllamaError('INVALID_RESPONSE', 'Ollama の応答に翻訳本文が含まれていません')
  }
  return content.trim()
}

/**
 * 組み立て済みプロンプトを `/api/generate` にそのまま渡す。
 *
 * `raw: true` は「Ollama のチャットテンプレートを適用せず、prompt を
 * そのままモデルへ渡す」指定。PLaMo のように PFML3 を自分で組み立てる
 * モデルでは、テンプレートの解釈揺れを避けられる。
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl] - テストで差し替える fetch。
 * @param {string} options.endpoint - Ollama の基底 URL。
 * @param {string} options.model - モデル名。
 * @param {string} options.prompt - PFML3 などの完成済みプロンプト。
 * @param {number} options.temperature - サンプリング温度。
 * @param {string[]} [options.stop] - 停止トークン。
 * @param {number} options.timeoutMs - 1 リクエストの期限。
 * @param {AbortSignal} [options.signal] - 呼び出し元のキャンセル。
 * @returns {Promise<string>} 翻訳結果。
 */
export async function generateWithOllama({
  fetchImpl = fetch,
  endpoint,
  model,
  prompt,
  temperature,
  stop,
  timeoutMs,
  signal,
}) {
  const body = await postOllama({
    fetchImpl,
    endpoint,
    path: '/api/generate',
    timeoutMs,
    signal,
    payload: {
      model,
      raw: true,
      stream: false,
      prompt,
      options: { temperature, ...stop === undefined ? {} : { stop } },
    },
  })

  const content = body?.response
  if (typeof content !== 'string' || content.trim() === '') {
    throw new OllamaError('INVALID_RESPONSE', 'Ollama の応答に翻訳本文が含まれていません')
  }
  return content.trim()
}
