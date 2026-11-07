/**
 * dsh-message-translator — browser half.
 *
 * ホスト側は翻訳結果を `plugin:message-translator/translation` という
 * plugin record としてセッションへ追記するだけで、表示はこのバンドルが担う。
 * record を `ConversationNodeDefinition` で会話ノードに変換し、回答の直後に
 * 「翻訳」カードとして描画する。
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

		/**
		 * ChatNodeKind として登録するキー。`conversation.chat.node` はこの
		 * キーでレンダラを引く。
		 */
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

		/**
		 * record の位置を、会話の Turn/Step 座標へ写す。record は turn/end の
		 * 直前に追記されるので、通常は turn と step が解決できる。
		 */
		function locationOf(context) {
			return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
		}

		/**
		 * plugin record を会話ノードにする定義。
		 *
		 * 1 record = 1 ノードなので、`id` は record の seq を使う。同じ record が
		 * 再読込されても同じキーになり、DOM が無駄に作り直されない。
		 */
		const definition = {
			kind: KIND,
			target: 'chat',
			match: (event) => (event.type === RECORD ? { id: String(event.seq), role: 'start' } : null),
			start: (_context, match) => ({
				text: match.event.data.text,
				model: match.event.data.model,
				provider: match.event.data.provider,
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
					groupTree: 'process',
					data: context.state,
				}
			},
		}

		/**
		 * 翻訳カード。既定では開いた状態で表示し、summary をクリックすると
		 * 折りたためる。原文はそのまま上に残るので、原文と訳文を見比べられる。
		 */
		function TranslationNodeView({ node }) {
			return h('details', {
				open: true,
				'data-message-translation': '',
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
		 * クライアントプラグインのマウント。
		 *
		 * `uiConversation.events` への登録と slot の登録は、どちらもこの
		 * プラグインの fiber に属する。無効化や HMR で自動的に外れる。
		 *
		 * @param ctx - ブラウザ側の Cordis コンテキスト。
		 */
		function apply(ctx) {
			ctx.uiConversation.events.register(definition)
			ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
				name: 'conversation.chat.node',
				key: KIND,
			}, TranslationNodeView))
		}

		exports.apply = apply
		exports.inject = ['uiConversation', 'slots']
		return module.exports
	},
})
