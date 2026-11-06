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

/**
 * 長い本文をモデルの入力上限に収まる断片へ分割する。
 *
 * 段落境界（空行）を優先し、それが見つからない場合だけ空白、最後は文字数で
 * 切る。文の途中で切るより段落の切れ目で切るほうが、断片ごとの翻訳品質が
 * 落ちにくい。サロゲートペアの途中では切らない。
 *
 * @param {string} text - 分割対象の本文。
 * @param {number} maxChars - 1 断片あたりの最大 UTF-16 コード単位。
 * @returns {string[]} 順番に連結すると元の本文へ戻る断片。
 */
export function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text]
  const parts = []
  let rest = text
  while (rest.length > maxChars) {
    let cut = maxChars
    const paragraph = rest.lastIndexOf('\n\n', maxChars)
    if (paragraph >= maxChars / 2) {
      cut = paragraph + 2
    } else {
      const space = rest.lastIndexOf(' ', maxChars)
      if (space >= maxChars / 2) cut = space + 1
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
