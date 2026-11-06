/**
 * セッションイベントから「そのターンの最終回答」を取り出し、翻訳結果を
 * plugin record として同じセッションログへ追記する係。
 *
 * なぜ翻訳結果を JSONL ファイルではなく Session の plugin record に書くか:
 *   後から Web GUI 側で翻訳を表示するとき、クライアントが読めるのは
 *   セッションのイベントログだけ。ホストのローカルファイルを読むには
 *   別途 Remote を生やす必要があるが、plugin record なら既存の
 *   セッション購読にそのまま乗る。UI を後から足す前提に合っている。
 *
 * なぜ turn/end で 1 回だけ翻訳するか:
 *   assistant/message はステップごとに流れてくる。途中のツール呼び出し用の
 *   説明文まで翻訳すると、ユーザーが読む最終回答以外のノイズが増える。
 *   ターンの最後に残った本文だけを対象にしている。
 */

/**
 * assistant メッセージの content から text ブロックだけを連結する。
 * reasoning や画像は翻訳対象にしない。
 *
 * @param {Array<{ type: string, text?: string }>} content
 * @returns {string}
 */
export function assistantText(content) {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/**
 * レコーダーを組み立てる。
 *
 * @param {object} options
 * @param {(session: object, type: string, data: object) => number} options.appendRecord
 *   - plugin record 追記関数（本番は appendPluginRecord）。
 * @param {(session: object) => Promise<boolean>} options.flush - セッションの永続化。
 * @param {(text: string, signal: AbortSignal) => Promise<string>} options.translate - 翻訳関数。
 * @param {{ warn: (message: string) => void }} options.logger - 失敗を報告する先。
 * @param {() => Date} options.now - 記録時刻の供給元（テストで固定する）。
 * @param {object} options.recipe - 翻訳結果を再現する設定の識別情報。
 * @param {AbortSignal} options.lifetime - プラグイン破棄時に翻訳を止める信号。
 * @returns {{ onEvent: (session: object, event: object) => void, disposeSession: (session: object) => void, dispose: () => Promise<void> }}
 */
export function createRecorder({ appendRecord, flush, translate, logger, now, recipe, lifetime }) {
  /** @type {Map<string, { turn: number, step: number, seq: number, text: string }>} */
  const pending = new Map()
  /** @type {Map<string, AbortController>} */
  const controllers = new Map()
  /** @type {Set<Promise<void>>} */
  const jobs = new Set()

  function controllerFor(session) {
    let controller = controllers.get(session.id)
    if (controller === undefined) {
      controller = new AbortController()
      controllers.set(session.id, controller)
    }
    return controller
  }

  function run(session, target) {
    const controller = controllerFor(session)
    const signal = AbortSignal.any([controller.signal, lifetime])
    const job = (async () => {
      try {
        const text = await translate(target.text, signal)
        if (signal.aborted) return
        appendRecord(session, 'plugin:message-translator/translation', {
          turn: target.turn,
          step: target.step,
          messageSeq: target.seq,
          text,
          ...recipe,
          createdAt: now().toISOString(),
        })
        await flush(session)
      } catch (error) {
        // キャンセルは失敗ではない。セッション終了やプラグイン破棄で
        // 途中になった翻訳を警告として出すとログが埋まるため、静かに捨てる。
        if (signal.aborted) return
        const reason = error instanceof Error ? error.message : String(error)
        logger.warn(`dsh-message-translator: session ${session.id} turn ${target.turn} の翻訳に失敗しました: ${reason}`)
      }
    })()
    jobs.add(job)
    void job.finally(() => { jobs.delete(job) })
  }

  return {
    onEvent(session, event) {
      switch (event.type) {
        case 'turn/start':
          pending.delete(session.id)
          return
        case 'assistant/message': {
          const text = assistantText(event.data.message.content)
          if (text.trim() !== '') {
            pending.set(session.id, {
              turn: event.data.turn,
              step: event.data.step,
              seq: event.seq,
              text,
            })
          }
          return
        }
        case 'turn/end': {
          const target = pending.get(session.id)
          pending.delete(session.id)
          // 失敗・中断したターンの本文まで翻訳すると、エラーメッセージや
          // 途中で切れた文が訳されて紛らわしい。完了したターンだけを対象にする。
          if (event.data.reason.kind !== 'completed') return
          if (target === undefined || target.turn !== event.data.turn) return
          run(session, target)
          return
        }
        default:
          return
      }
    },

    /** セッションが閉じた後は追記も flush もできないので、実行中の翻訳を止める。 */
    disposeSession(session) {
      controllers.get(session.id)?.abort()
      controllers.delete(session.id)
      pending.delete(session.id)
    },

    /** プラグイン破棄時に実行中の翻訳の終了を待つ。 */
    async dispose() {
      await Promise.allSettled(jobs)
    },
  }
}
