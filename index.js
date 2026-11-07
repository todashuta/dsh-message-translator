/**
 * dsh-message-translator — 回答をローカルの Ollama で翻訳し、セッションへ記録する
 * DSH プラグイン（ホスト側）。
 *
 * 対応するモデルは 2 系統:
 *   - `chat`: system + user のチャット形式を渡す汎用モデル（qwen3 など）。
 *   - `plamo`: PLaMo 3 Translate の PFML3 プロンプトを組み立てて
 *     `/api/generate` へ `raw: true` で渡す。翻訳専用モデル向け。
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
import { chatWithOllama, generateWithOllama } from './lib/ollama.js'
import {
  languageCode, PFML3_STOP, pfml3Prompt, translationSystemPrompt,
} from './lib/protocol.js'
import { createRecorder } from './lib/recorder.js'
import { createTranslate } from './lib/translation.js'

/** Cordis プラグイン名。cordis.patch.yml の id と揃える。 */
export const name = 'dsh-message-translator'

/** セッションの flush に `sessions` を使う。 */
export const inject = ['sessions']

/**
 * 設定フォームに出るフィールド。
 *
 * 既定は汎用のチャット形式。PLaMo 3 Translate を使う場合は
 * `provider: plamo` と `model: plamo-3-translate:0.8b` を指定する。
 */
export const Config = z.object({
  /** 翻訳リクエストの形式。`chat` は汎用、`plamo` は PFML3。 */
  provider: z.union(['chat', 'plamo']).default('chat'),
  /** Ollama の基底 URL。 */
  endpoint: z.string().default('http://127.0.0.1:11434'),
  /** 翻訳に使う Ollama のモデル名。 */
  model: z.string().default('qwen3:8b'),
  /**
   * 翻訳先。`chat` では言語名（Japanese）、`plamo` では言語コード（ja）を
   * 推奨。よく使う言語名は `plamo` 側でコードへ変換する。
   */
  targetLanguage: z.string().default('Japanese'),
  /** 原文の言語名。`auto` なら Ollama に自動判定させる。`plamo` では未使用。 */
  sourceLanguage: z.string().default('auto'),
  /** 日本語の文体。`plamo` で `targetLanguage` が ja のときだけ効く。 */
  form: z.union(['auto', 'plain', 'polite']).default('auto'),
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
 * 汎用モデル向けの翻訳器。system + user を `/api/chat` へ送る。
 *
 * @param {z.infer<typeof Config>} config
 * @returns {(text: string, signal?: AbortSignal) => Promise<string>}
 */
function createChatTranslate(config) {
  return createTranslate({
    chat: (request) => chatWithOllama({
      endpoint: config.endpoint,
      model: config.model,
      system: request.system,
      user: request.user,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
      signal: request.signal,
    }),
    buildRequest: (text) => ({
      system: translationSystemPrompt(config.targetLanguage, config.sourceLanguage),
      user: text,
    }),
    maxTextChars: config.maxTextChars,
  })
}

/**
 * PLaMo 3 Translate 向けの翻訳器。PFML3 を `/api/generate` へ直接送る。
 *
 * @param {z.infer<typeof Config>} config
 * @returns {(text: string, signal?: AbortSignal) => Promise<string>}
 */
function createPlamoTranslate(config) {
  const target = languageCode(config.targetLanguage)
  return createTranslate({
    chat: (request) => generateWithOllama({
      endpoint: config.endpoint,
      model: config.model,
      prompt: request.prompt,
      temperature: config.temperature,
      stop: PFML3_STOP,
      timeoutMs: config.timeoutMs,
      signal: request.signal,
    }),
    buildRequest: (text) => ({
      prompt: pfml3Prompt(text, target, config.form),
    }),
    maxTextChars: config.maxTextChars,
  })
}

/**
 * プラグインをマウントする。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  if (!config.enabled) return

  const lifetime = new AbortController()
  const plamo = config.provider === 'plamo'
  const translate = plamo ? createPlamoTranslate(config) : createChatTranslate(config)
  const recordedLanguage = plamo ? languageCode(config.targetLanguage) : config.targetLanguage

  const recorder = createRecorder({
    appendRecord: appendPluginRecord,
    flush: (session) => ctx.sessions.flush(session),
    translate,
    logger: ctx.logger,
    now: () => new Date(),
    recipe: {
      provider: config.provider,
      model: config.model,
      targetLanguage: recordedLanguage,
      sourceLanguage: config.sourceLanguage,
      ...plamo ? { form: config.form } : {},
      // 設定が変わると同じ原文でも別の訳になる。UI 側が再翻訳の要否を
      // 判断できるよう、翻訳結果を決める設定を 1 つの文字列に畳んでおく。
      recipe: plamo
        ? `plamo-pfml3-v1:${config.model}:${recordedLanguage}:${config.form}`
        : `ollama-chat-v1:${config.model}:${config.targetLanguage}:${config.sourceLanguage}`,
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
