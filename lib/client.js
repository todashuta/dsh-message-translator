/**
 * dsh-message-translator — browser half.
 *
 * ホスト側は翻訳結果を `plugin:message-translator/translation` という
 * plugin record としてセッションへ追記する。このバンドルは、その record を
 * Step の Location data として公開し、回答そのもの（assistant-step）の
 * 表示を訳文へ差し替える。原文は折りたたみの中に残す。
 *
 * ビルドを挟まず、`window.__ModuleLoader__` に lazy-CJS の factory を登録する。
 * react と ui-primitives はシェルが持つコピーを使うので、バンドルには含めない。
 */
window.__ModuleLoader__.load({
	id: 'dsh-message-translator',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		// Baseline (shell-seeded) UI library. Markdown の描画はシェルの実装を
		// そのまま使う。訳文にコードブロックが含まれても、コピーボタンや
		// シンタックスハイライトが効く。
		const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement

		/** ホストが追記する plugin record の型。 */
		const RECORD = 'plugin:message-translator/translation'

		/** Step data に翻訳を載せるためのキー。 */
		const STEP_DATA_KEY = 'message-translation'

		/**
		 * MarkdownText が要求する chrome の文言。翻訳カードは `t` の名前空間を
		 * 持たないので、ここでは固定の日本語を渡す。コードブロックのコピー
		 * ボタンにだけ使われる。
		 */
		const MARKDOWN_LABELS = {
			code: {
				copyLabel: 'コピー',
				copiedLabel: 'コピーしました',
				toolbarLabels: {
					codeLabel: 'コード',
					wrapLabel: '折り返し',
					unwrapLabel: '折り返しを解除',
				},
			},
			footnotes: '脚注',
		}

		/** record の位置を、会話の Turn/Step 座標へ写す。 */
		function locationOf(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
		}

		/**
		 * 翻訳 record を、その Step の Location data として公開する定義。
		 *
		 * View は持たない。`assistant-step` の置き換え側が `useTurnData` で
		 * 同じ Step の翻訳を読み、回答の表示を差し替える。
		 */
		const definition = {
			kind: 'message-translation',
			match: (event) => (event.type === RECORD ? { id: String(event.seq), role: 'start' } : null),
			start: (_context, match) => ({
				text: match.event.data.text,
				messageId: match.event.data.messageId,
			}),
			update: (context) => context.state,
			buildLocationData: (context, scope) => {
				if (context.state === undefined) return null
				const location = locationOf(context)
				// Engine は Step と Turn の両方のフェーズで呼ぶ。scope と違う kind を
				// 返すと「published turn data through its step scope」で落ちる。
				if (scope === 'step') {
					if (location.kind !== 'step') return null
					return {
						kind: 'step',
						turn: location.turn.turn,
						step: location.step.step,
						key: STEP_DATA_KEY,
						value: context.state,
					}
				}
				if (location.kind !== 'step' && location.kind !== 'turn') return null
				// Chat の `useTurnData` は Turn の keyed data を読む。Step に公開すると
				// 届かないので、Turn 側へも載せて同じ回答の置き換えから参照する。
				return {
					kind: 'turn',
					turn: location.turn.turn,
					key: STEP_DATA_KEY,
					value: context.state,
				}
			},
		}

		/** Assistant ブロックから本文だけを連結する。 */
		function textBlocks(blocks) {
			return blocks.filter((block) => block.kind === 'text').map((block) => block.text).join('\n\n')
		}

		/** 折りたたみの summary に使う共通スタイル。 */
		const SUMMARY_STYLE = {
			cursor: 'pointer',
			fontSize: 12,
			color: 'var(--dsw-alias-label-secondary)',
			userSelect: 'none',
		}

		/**
		 * 回答そのものを描画する。翻訳がその Step に届いていれば訳文を本文にし、
		 * 原文は「原文」の折りたたみへ移す。翻訳がまだ無いターンやストリーミング中は
		 * 従来どおり原文を出す。
		 */
		function AssistantStepView({ node, groupPart, loadImage, renderSlot, useTurnData }) {
			const data = node.data
			const blocks = data.blocks
			const translation = useTurnData(STEP_DATA_KEY)
			const messageId = data.finalNode?.messageId
			const usableTranslation = translation !== undefined
				&& (messageId === undefined || translation.messageId === messageId)
				? translation
				: undefined
			const source = groupPart === 'reasoning'
				? blocks.filter((block) => block.kind === 'reasoning' && block.text.trim() !== '')
					.map((block) => block.text).join('\n\n')
				: textBlocks(blocks)
			const images = groupPart === 'reasoning'
				? []
				: blocks.filter((block) => block.kind === 'image')
			const streaming = data.status === 'running'
			const textInteractionSource = data.status === 'settled' && messageId !== undefined

			return h('div', null,
				usableTranslation !== undefined
					? h('div', null,
						h(MarkdownText, {
							text: usableTranslation.text,
							labels: MARKDOWN_LABELS,
							textInteractionSource,
						}),
						source.trim() !== ''
							? h('details', { style: { marginTop: 8 } },
								h('summary', { style: SUMMARY_STYLE }, '原文'),
								h(MarkdownText, { text: source, labels: MARKDOWN_LABELS, variant: 'compact' }),
							)
							: null,
					)
					: h(MarkdownText, {
						text: source,
						labels: MARKDOWN_LABELS,
						streaming,
						textInteractionSource,
					}),
				images.length > 0
					? renderSlot('conversation.chat.message.images', {
						images: images.map(({ attachment }) => ({ attachment })),
						loadImage,
						align: 'start',
					})
					: null,
			)
		}

		/**
		 * クライアントプラグインのマウント。
		 *
		 * `assistant-step` のキーを再利用して、shipped の回答レンダラを置き換える。
		 * 登録はこのプラグインの fiber に属するので、無効化や HMR で元に戻る。
		 *
		 * @param ctx - ブラウザ側の Cordis コンテキスト。
		 */
		function apply(ctx) {
			ctx.uiConversation.events.register(definition)
			ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
				name: 'conversation.chat.node',
				key: 'assistant-step',
				// shipped の assistant-step と同じ priority だと登録が競合する。
				// priority が小さいほど優先されるので、1 つ下げて影武者にする。
				priority: -1,
			}, AssistantStepView))
		}

		exports.apply = apply
		exports.inject = ['uiConversation', 'slots']
		return module.exports
	},
})
