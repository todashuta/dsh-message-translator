/**
 * 翻訳リクエストの組み立てと、Markdown のコードブロックを翻訳から守る処理。
 *
 * なぜコードブロックを退避するか:
 *   「コードは翻訳するな」と system prompt で指示しても、小さめのモデルは
 *   識別子やコメントを訳して壊すことがある。原文からコードブロックだけを
 *   取り出してプレースホルダに置き換え、翻訳後に元へ戻せば、コードの
 *   完全性はモデルの指示追従性に依存しなくなる。
 *
 * なぜインラインコード `...` を退避しないか:
 *   インラインコードは文中に埋め込まれ、前後の語順ごと翻訳される必要が
 *   ある。取り出すと文の構造が壊れるため、こちらは system prompt の指示に
 *   任せ、退避するのは行単位で独立しているフェンス付きコードブロックだけに
 *   している。
 */

/** コードブロックの開始フェンス行。行頭の空白と 3 個以上の ` または ~ を許す。 */
const OPEN_FENCE = /^(\s*)(`{3,}|~{3,})/

/** プレースホルダの形式。英数字だけの識別子にして、モデルが崩しにくくする。 */
const PLACEHOLDER = /\[\[CODE_BLOCK_(\d+)\]\]/g

/**
 * フェンス付きコードブロックをプレースホルダに置き換える。
 *
 * 走査は行単位にしている。正規表現でコードブロック全体を一括置換すると、
 * 閉じフェンスの有無やフェンス文字種の混在で壊れやすいため、開始行を見つけて
 * 同じ文字種・同じ長さ以上の閉じ行までを 1 ブロックとして扱う。
 *
 * @param {string} text - 翻訳対象の Markdown 本文。
 * @returns {{ text: string, blocks: string[] }} プレースホルダ化した本文と退避したコードブロック。
 */
export function protectCodeBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  const output = []
  let index = 0
  while (index < lines.length) {
    const open = OPEN_FENCE.exec(lines[index])
    if (open === null) {
      output.push(lines[index])
      index += 1
      continue
    }
    const fence = open[2]
    const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    const start = index
    index += 1
    while (index < lines.length && !close.test(lines[index])) index += 1
    // 閉じフェンスが無い場合は、末尾までを 1 ブロックとして扱う。途中で
    // 切ると本文の残りがフェンスの一部として翻訳され、プレースホルダの
    // 対応が崩れるため。
    if (index < lines.length) index += 1
    blocks.push(lines.slice(start, index).join('\n'))
    output.push(`[[CODE_BLOCK_${blocks.length - 1}]]`)
  }
  return { text: output.join('\n'), blocks }
}

/**
 * 翻訳結果のプレースホルダを元のコードブロックへ戻す。
 *
 * モデルがプレースホルダを落としたり崩したりした場合は、そのブロックを
 * 翻訳結果の末尾に原文のまま追加する。プレースホルダを消してしまうより、
 * 元のコードが本文の後ろに残るほうが情報の損失が小さい。
 *
 * @param {string} translated - モデルの翻訳結果。
 * @param {string[]} blocks - {@link protectCodeBlocks} が退避したコードブロック。
 * @returns {string} コードブロックを復元した翻訳結果。
 */
export function restoreCodeBlocks(translated, blocks) {
  const seen = new Set()
  const restored = translated.replace(PLACEHOLDER, (_match, rawIndex) => {
    const index = Number(rawIndex)
    const block = blocks[index]
    if (block === undefined) return _match
    seen.add(index)
    return block
  })
  const missing = blocks.filter((_block, index) => !seen.has(index))
  if (missing.length === 0) return restored
  return `${restored.trimEnd()}\n\n${missing.join('\n\n')}`
}

/** 文末とみなす文字。全角・半角の句読点を揃える。 */
const SENTENCE_ENDS = ['。', '．', '.', '!', '?', '！', '？']

/**
 * `limit` 以前で最後に現れる文末の直後を返す。
 * @param {string} text - 探索対象。
 * @param {number} limit - この位置より後では切らない。
 * @returns {number} 文末の直後の位置。見つからなければ 0。
 */
function lastSentenceCut(text, limit) {
  let best = 0
  for (const end of SENTENCE_ENDS) {
    const index = text.lastIndexOf(end, limit - 1)
    if (index + 1 > best) best = index + 1
  }
  return best
}

/**
 * 長い本文をモデルの入力上限に収まる断片へ分割する。
 *
 * 段落境界（空行）→ 文末（。 . ! ? など）→ 空白 → 文字数の順に切る。
 * 文の途中で切ると訳文が不自然になるため、できるだけ意味の切れ目を選ぶ。
 * サロゲートペアの途中では切らない。
 *
 * @param {string} text - 分割対象の本文。
 * @param {number} maxChars - 1 断片あたりの最大 UTF-16 コード単位。
 * @returns {string[]} 順番に連結すると元の本文へ戻る断片。
 */
export function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text]
  const half = maxChars / 2
  const parts = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = maxChars
    const paragraph = rest.lastIndexOf('\n\n', maxChars)
    if (paragraph >= half) {
      cut = paragraph + 2
    } else {
      const sentence = lastSentenceCut(rest, maxChars)
      if (sentence >= half) {
        cut = sentence
      } else {
        const space = rest.lastIndexOf(' ', maxChars)
        if (space >= half) cut = space + 1
      }
    }
    if (/[\uD800-\uDBFF]/.test(rest.charAt(cut - 1))) cut -= 1
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') parts.push(rest)
  return parts
}

/**
 * 翻訳用の system prompt を組み立てる。
 *
 * 「翻訳だけを返す」ことを繰り返し指示するのは、小さいモデルが解説や
 * 前置きを付け加えるのを抑えるため。コードブロックの指示は、退避しきれない
 * インラインコードへの保険として残している。
 *
 * @param {string} targetLanguage - 翻訳先の言語名（例: Japanese）。
 * @param {string} sourceLanguage - 原文の言語名。`auto` なら自動判定。
 * @returns {string} system prompt。
 */
export function translationSystemPrompt(targetLanguage, sourceLanguage) {
  const source = sourceLanguage === 'auto'
    ? 'Detect the source language automatically.'
    : `The source language is ${sourceLanguage}.`
  return [
    `You are a translation engine. Translate the user's Markdown into ${targetLanguage}.`,
    source,
    'Return only the translation, with no explanations, notes, or surrounding quotes.',
    'Preserve the Markdown structure: headings, lists, tables, links, and inline code.',
    'Never translate the contents of code blocks or inline code; keep them exactly as written.',
    'Keep placeholders like [[CODE_BLOCK_0]] unchanged and in their original positions.',
  ].join(' ')
}

/**
 * PLaMo 3 Translate の対応言語のうち、よく使う言語名を言語コードへ対応付ける。
 *
 * PLaMo は PFML3 の `lang` 属性に言語コード（`ja`、`en`、`zh-hans` など）を
 * 期待する。DSH の設定では人間が読みやすい言語名を書きたいので、ここで
 * 吸収する。PLaMo が対応しない言語名は変換せず、そのままモデルへ渡す。
 */
const LANGUAGE_CODES = new Map([
  ['japanese', 'ja'],
  ['日本語', 'ja'],
  ['english', 'en'],
  ['英語', 'en'],
  ['chinese', 'zh-hans'],
  ['chinese (simplified)', 'zh-hans'],
  ['簡体中国語', 'zh-hans'],
  ['简体中文', 'zh-hans'],
  ['chinese (traditional)', 'zh-hant'],
  ['繁体中国語', 'zh-hant'],
  ['繁體中文', 'zh-hant'],
  ['korean', 'ko'],
  ['韓国語', 'ko'],
  ['german', 'de'],
  ['ドイツ語', 'de'],
  ['french', 'fr'],
  ['フランス語', 'fr'],
  ['spanish', 'es'],
  ['スペイン語', 'es'],
  ['italian', 'it'],
  ['イタリア語', 'it'],
  ['russian', 'ru'],
  ['ロシア語', 'ru'],
  ['arabic', 'ar'],
  ['アラビア語', 'ar'],
  ['hindi', 'hi'],
  ['ヒンディー語', 'hi'],
  ['thai', 'th'],
  ['タイ語', 'th'],
  ['vietnamese', 'vi'],
  ['ベトナム語', 'vi'],
  ['indonesian', 'id'],
  ['インドネシア語', 'id'],
  ['dutch', 'nl'],
  ['オランダ語', 'nl'],
  ['polish', 'pl'],
  ['ポーランド語', 'pl'],
])

/**
 * 言語名または言語コードを、PFML3 の `lang` に使えるコードへ正規化する。
 *
 * コードらしい値（`ja`、`zh-hans` など）はそのまま小文字で返す。将来の
 * 言語追加でプラグイン側を直さなくて済むようにするため。
 *
 * @param {string} value - 言語名（Japanese）または言語コード（ja）。
 * @returns {string} 正規化した言語コード。
 */
export function languageCode(value) {
  const trimmed = value.trim()
  if (/^[a-z]{2,3}(?:-[a-z0-9]+)?$/i.test(trimmed)) return trimmed.toLowerCase()
  return LANGUAGE_CODES.get(trimmed.toLowerCase()) ?? trimmed
}

/** PLaMo が訳文の後に出力して停止するトークン。 */
export const PFML3_STOP = ['<|plamo:tag|>', '<|plamo:bos|>']

/**
 * PLaMo 3 Translate の PFML3 プロンプトを組み立てる。
 *
 * BOS トークンは付けない。Ollama がモデルの BOS 設定に従って自動で付ける。
 * 手書きプロンプトに BOS を足すと二重になる。
 *
 * @param {string} text - 翻訳対象の本文。
 * @param {string} targetLanguage - 翻訳先の言語コード（例: ja）。
 * @param {'auto' | 'plain' | 'polite'} [form] - 日本語の文体。`auto` なら指定しない。
 * @returns {string} PFML3 プロンプト。
 */
export function pfml3Prompt(text, targetLanguage, form = 'auto') {
  const formPart = form === 'auto' ? '' : `<|plamo:key|>form<|plamo:val|>${form}`
  return [
    '<|plamo:tag|>dataset<|plamo:msg|>translation',
    '<|plamo:tag|>input<|plamo:msg|>',
    text,
    '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>',
    targetLanguage,
    formPart,
    '<|plamo:msg|>',
  ].join('')
}
