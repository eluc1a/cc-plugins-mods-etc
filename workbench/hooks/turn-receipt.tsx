import type { On } from 'claude-code'

type Seg = [text: string, style: 'dim' | 'plain' | 'warn']

// Module state: it dies on reload, and prompt.submit resets it, so a reload costs one receipt.
let files = new Set<string>()
let commits = 0
let pushes = 0
let uncommitted = 0
let asks = false
// The receipt of each finished turn, keyed by its duration: TurnDuration rows redraw on a scroll or
// a resize, and durationMs is the one value the row and turn.complete share.
const receipts = new Map<number, Seg[][]>()

const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

async function receiptUncommitted($: any): Promise<number> {
  try {
    const { stdout } = await $.process.run(['git', 'status', '--porcelain'])
    return stdout.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

// One group per entry, zero groups left out.
function segments(): Seg[][] {
  const groups: Seg[][] = []
  if (files.size) groups.push([['edited ', 'dim'], [plural(files.size, 'file'), 'plain']])
  if (commits) {
    const group: Seg[] = [[plural(commits, 'commit'), 'plain']]
    if (commits > pushes) group.push([', ', 'dim'], ['not pushed', 'warn'])
    groups.push(group)
  }
  if (uncommitted) groups.push([[String(uncommitted), 'plain'], [' uncommitted', 'dim']])
  if (asks) groups.push([['asks you ', 'warn'], ['1 question', 'plain']])
  return groups
}

export function turnReceipt(on: On) {
  on('prompt.submit', (_$, e, next) => {
    files = new Set()
    commits = pushes = uncommitted = 0
    asks = false
    return next(e)
  })

  on('tool.call', async (_$, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined || ran.isError === true) return ran
    const input = e as any
    if (EDITS.has(e.tool)) files.add(input.file_path ?? input.notebook_path)
    else if (e.tool === 'Bash') {
      if (/\bgit\s+commit\b/.test(input.command)) commits += 1
      if (/\bgit\s+push\b/.test(input.command)) pushes += 1
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      uncommitted = await receiptUncommitted($)
      asks = e.answer.trim().split(/\n\s*\n/).at(-1)?.trimEnd().endsWith('?') ?? false
      receipts.set(e.durationMs, segments())
      // The row can draw before this hook runs: draw it again with the receipt.
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const groups = receipts.get(e.props.durationMs) ?? []
    if (e.surface !== 'terminal' || groups.length === 0) return next(e)

    const own = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const draw = ([text, style]: Seg) =>
      Text({ children: [text], ...(style === 'dim' ? { dimColor: true } : style === 'warn' ? { color: 'warning' } : {}) })

    return Box({ children: [own, ...groups.flatMap(group => [draw([' · ', 'dim']), ...group.map(draw)])] })
  })
}
