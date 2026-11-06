/**
 * dsh-message-translator — 回答をローカルの Ollama で翻訳し、セッションへ記録する
 * DSH プラグイン（ホスト側）。
 *
 * 設計の要点:
 *   - 翻訳はターン完了後にバックグラウンドで走らせ、本体のターンを遅らせない。
 *   - 結果は `plugin:message-translator/translation` として同じセッションログへ
 *     追記する。後から Web GUI 側で「翻訳に切り替える」UI を足すとき、この
 *     レコードを読むだけで済む。
 *   - Ollama が落ちていても本体の会話は壊さない。失敗は warn に留める。
 *
 * なぜ `@deepseek-ai/dsh-session` を import するか:
 *   plugin record の追記は Session の内部コミット経路を通す必要があり、
 *   生の append では `ignorable` フラグや型文法の検証を再現できない。
 *   peerDependency として DSH 本体のコピーを使う。
 */

import z from '@deepseek-ai/schemastery'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { chatWithOllama } from './lib/ollama.js'
import { createRecorder } from './lib/recorder.js'
import { createTranslate } from './lib/translation.js'

/** Cordis プラグイン名。cordis.patch.yml の id と揃える。 */
export const name = 'dsh-message-translator'

/** セッションの flush に `sessions` を使う。 */
export const inject = ['sessions']

/**
 * 設定フォームに出るフィールド。
 *
 * 既定のモデルは Ollama でよく使われる qwen3 の中位サイズにしている。
 * 実際に導入しているモデルは `/api/tags` で確認できるので、合わなければ
 * プロファイルの patch で上書きする。
 */
export const Config = z.object({
  /** Ollama の基底 URL。 */
  endpoint: z.string().default('http://127.0.0.1:11434'),
  /** 翻訳に使う Ollama のモデル名。 */
  model: z.string().default('qwen3:8b'),
  /** 翻訳先の言語名。 */
  targetLanguage: z.string().default('Japanese'),
  /** 原文の言語名。`auto` なら Ollama に自動判定させる。 */
  sourceLanguage: z.string().default('auto'),
  /** 1 リクエストあたりの最大文字数。超えた本文は段落単位で分割する。 */
  maxTextChars: z.natural().min(200).default(4_000),
  /** Ollama 1 リクエストの期限（ミリ秒）。 */
  timeoutMs: z.natural().min(1_000).max(600_000).default(120_000),
  /** サンプリング温度。翻訳は揺らぎを抑えたいので低め。 */
  temperature: z.number().min(0).max(2).default(0.2),
  /** false にすると翻訳せずプラグインを休止する。 */
  enabled: z.boolean().default(true),
})

/**
 * プラグインをマウントする。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  if (!config.enabled) return

  const lifetime = new AbortController()

  const translate = createTranslate({
    chat: ({ system, user, signal }) => chatWithOllama({
      endpoint: config.endpoint,
      model: config.model,
      system,
      user,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      signal,
    }),
    maxTextChars: config.maxTextChars,
    targetLanguage: config.targetLanguage,
    sourceLanguage: config.sourceLanguage,
  })

  const recorder = createRecorder({
    appendRecord: appendPluginRecord,
    flush: (session) => ctx.sessions.flush(session),
    translate,
    logger: ctx.logger,
    now: () => new Date(),
    recipe: {
      model: config.model,
      targetLanguage: config.targetLanguage,
      sourceLanguage: config.sourceLanguage,
      // 設定が変わると同じ原文でも別の訳になる。UI 側が再翻訳の要否を
      // 判断できるよう、翻訳結果を決める設定を 1 つの文字列に畳んでおく。
      recipe: `ollama-chat-v1:${config.model}:${config.targetLanguage}:${config.sourceLanguage}`,
    },
    lifetime: lifetime.signal,
  })

  ctx.on('session/event', (session, event) => recorder.onEvent(session, event))
  ctx.on('session/disposed', (session) => recorder.disposeSession(session))

  ctx.effect(() => async () => {
    lifetime.abort()
    await recorder.dispose()
  }, 'dsh-message-translator: drain translations')
}
