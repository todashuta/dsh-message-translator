/**
 * dsh-message-translator — browser half.
 *
 * ホスト側は翻訳結果を `plugin:message-translator/translation` という
 * plugin record としてセッションへ追記するだけで、表示はこのバンドルが担う。
 * record を `ConversationNodeDefinition` で会話ノードに変換し、回答の直後に
 * 「翻訳」カードとして描画する。あわせて回答のアクション行に切り替えボタンを
 * 追加し、原文を隠して訳文だけを見られるようにする。
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
		// そのまま使う。翻訳本文にコードブロックが含まれても、コピーボタンや
		// シンタックスハイライトが効く。
		const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement

		/** ChatNodeKind として登録するキー。 */
		const KIND = 'message-translation'

		/** ホストが追記する plugin record の型。 */
		const RECORD = 'plugin:message-translator/translation'

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
		 * plugin record を会話ノードにする定義。
		 *
		 * 1 record = 1 ノードなので、`id` は record の seq を使う。`messageId` は
		 * アクション行の切替ボタンが、対象の回答と翻訳カードを対応付けるのに使う。
		 */
		const definition = {
			kind: KIND,
			target: 'chat',
			match: (event) => (event.type === RECORD ? { id: String(event.seq), role: 'start' } : null),
			start: (_context, match) => ({
				text: match.event.data.text,
				model: match.event.data.model,
				provider: match.event.data.provider,
				messageId: match.event.data.messageId,
			}),
			update: (context) => context.state,
			// publication は文字列ではなく、match を受けて公開タイミングを返す関数。
			// 文字列を渡すと assembler が `definition.publication is not a function`
			// で落ち、以降のイベント処理が止まって会話の表示が欠ける。
			publication: () => 'immediate',
			buildViewNode: (context) => {
				if (context.state === undefined) return null
				return {
					key: context.key,
					kind: KIND,
					id: context.id,
					target: 'chat',
					anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
					location: locationOf(context),
					visibility: 'visible',
					// Chat の flow に載せるには groupTree の明示が必要。省略すると
					// 未知の kind としてグループ化から漏れ、ノードが描画されない。
					groupTree: 'process',
					data: context.state,
				}
			},
		}

		/**
		 * 翻訳カード。既定では開いた状態で表示し、summary をクリックすると
		 * 折りたためる。`data-message-translation-id` は切替ボタンが対象の
		 * カードを探すために使う。
		 */
		function TranslationNodeView({ node }) {
			return h('details', {
				open: true,
				'data-message-translation': '',
				'data-message-translation-id': node.data.messageId,
				style: {
					margin: '8px 0',
					padding: '10px 12px',
					border: '0.5px solid var(--dsw-alias-border-l4)',
					borderRadius: 'var(--dsw-radius-md)',
					background: 'var(--dsw-alias-bg-layer-3)',
				},
			},
				h('summary', {
					style: {
						cursor: 'pointer',
						fontSize: 12,
						color: 'var(--dsw-alias-label-secondary)',
						userSelect: 'none',
					},
				},
					h('span', { style: { fontWeight: 600, marginRight: 6 } }, '翻訳'),
					h('span', null, node.data.model ?? ''),
				),
				h(MarkdownText, {
					text: node.data.text,
					labels: MARKDOWN_LABELS,
					variant: 'compact',
				}),
			)
		}

		/**
		 * 回答のアクション行に置く切り替えボタン。
		 *
		 * 押すと、その回答の `assistant-step` 行を `display: none` で隠し、
		 * 翻訳カードだけを見せる。もう一度押すと原文へ戻る。原文を DOM から
		 * 消さずに隠すだけなのは、翻訳カードの折りたたみ状態やスクロール位置を
		 * 保ったまま切り替えられるようにするため。
		 */
		function TranslationToggle({ messageId, useChat }) {
			const snapshot = useChat((value) => value)
			const translation = React.useMemo(() => {
				for (const key of snapshot.order) {
					const node = snapshot.nodes.get(key)
					if (node !== undefined && node.kind === KIND && node.data.messageId === messageId) return node
				}
				return undefined
			}, [snapshot, messageId])
			const [showingTranslation, setShowingTranslation] = React.useState(false)

			// 翻訳がまだ無いターンでは、アクション行に何も足さない。
			if (translation === undefined) return null

			const toggle = () => {
				const next = !showingTranslation
				setShowingTranslation(next)
				for (const key of snapshot.order) {
					const node = snapshot.nodes.get(key)
					if (node === undefined || node.kind !== 'assistant-step') continue
					if (node.data.finalNode?.messageId !== messageId) continue
					const element = document.querySelector(`[data-chat-node-key="${CSS.escape(key)}"]`)
					if (element instanceof HTMLElement) element.style.display = next ? 'none' : ''
				}
			}

			return h('button', {
				type: 'button',
				onClick: toggle,
				'aria-pressed': showingTranslation,
				title: showingTranslation ? '原文を表示' : '翻訳を表示',
				style: {
					border: 'none',
					background: 'none',
					padding: '4px 8px',
					font: 'inherit',
					fontSize: 12,
					color: 'var(--dsw-alias-label-secondary)',
					cursor: 'pointer',
				},
			}, showingTranslation ? '原文' : '翻訳')
		}

		/**
		 * クライアントプラグインのマウント。
		 *
		 * 登録はこのプラグインの fiber に属するので、無効化や HMR で自動的に外れる。
		 *
		 * @param ctx - ブラウザ側の Cordis コンテキスト。
		 */
		function apply(ctx) {
			ctx.uiConversation.events.register(definition)
			ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
				name: 'conversation.chat.node',
				key: KIND,
			}, TranslationNodeView))
			ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
				name: 'conversation.chat.assistant-actions',
				id: 'message-translator',
				order: 100,
				label: '翻訳',
			}, TranslationToggle))
		}

		exports.apply = apply
		exports.inject = ['uiConversation', 'slots']
		return module.exports
	},
})
