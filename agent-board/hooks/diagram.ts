// The box diagram of the agent tree: main on top, each agent's children in a row under it, joined by lines.
// No engine here, so the tests lay it out directly. A line toward a working agent pulses away from its
// parent, one cell a frame, so the motion runs toward the subagents; motion off, the live path holds lit.

export type Node = { label: string; glyph: string; color: string; isLive: boolean; kids: Node[] }
export type Run = { text: string; color: string }

const BOX_MAX = 16
const BOX_MIN = 8
const GAP = 1
// A level: the three rows of a box, the stub under it and the bus to its children.
const LEVEL = 5
// One lit cell in every PULSE cells of a live line.
const PULSE = 4
// A line cell's arms as bits: up 8, down 4, left 2, right 1.
const JOIN: Record<number, string> = { 12: '│', 3: '─', 5: '┌', 6: '┐', 9: '└', 10: '┘', 7: '┬', 11: '┴', 13: '├', 14: '┤', 15: '┼' }
const HEAVY: Record<string, string> = { '─': '━', '│': '┃' }

// A line cell keeps its distance from the parent and whether a working agent lies beyond it.
type Cell = { ch: string; color: string; d?: number; isLive?: boolean }

export const fit = (v: string, w: number) => (v.length <= w ? v : `${v.slice(0, Math.max(0, w - 1))}…`)

const span = (n: Node, bw: number): number => (n.kids.length === 0 ? bw : Math.max(bw, n.kids.reduce((s, k) => s + span(k, bw) + GAP, -GAP)))
const depth = (n: Node): number => (n.kids.length === 0 ? 0 : 1 + Math.max(...n.kids.map(depth)))
const isLive = (n: Node): boolean => n.isLive || n.kids.some(isLive)

// The diagram's rows as color runs, centered in `width`. `frame` moves the pulse; undefined holds it.
export function diagram(root: Node, width: number, frame: number | undefined, line: string, pulse: string) {
  // The widest boxes that fit; at the narrowest, the rows cut at the pane's edge.
  let bw = BOX_MAX
  while (bw > BOX_MIN && span(root, bw) > width) {
    bw -= 1
  }
  const gridW = span(root, bw)
  const grid: Cell[][] = Array.from({ length: depth(root) * LEVEL + 3 }, () => Array.from({ length: gridW }, () => ({ ch: ' ', color: line })))
  const put = (x: number, y: number, cell: Cell) => {
    grid[y]![x] = cell
  }
  const write = (x: number, y: number, s: string, color: string) => [...s].forEach((ch, i) => put(x + i, y, { ch, color }))

  // Draws n's subtree from column x0 and returns the column of n's center. `base` is the distance of the
  // joint on n's top border, so one pulse flows on from main through each box to its children.
  const leftOf = (n: Node, x0: number) => x0 + Math.floor((span(n, bw) - bw) / 2)
  const place = (n: Node, x0: number, y: number, base: number): number => {
    const left = leftOf(n, x0)
    const c = left + Math.floor(bw / 2)
    write(left, y, `┌${'─'.repeat(bw - 2)}┐`, line)
    write(left, y + 1, '│', line)
    write(left + 1, y + 1, `${n.glyph} ${fit(n.label, bw - 4)}`.padEnd(bw - 2), n.color)
    write(left + bw - 1, y + 1, '│', line)
    write(left, y + 2, `└${'─'.repeat(bw - 2)}┘`, line)
    if (n.kids.length === 0) {
      return c
    }

    let kx = x0 + Math.floor((span(n, bw) - n.kids.reduce((s, k) => s + span(k, bw) + GAP, -GAP)) / 2)
    const ends = n.kids.map(k => {
      const at = place(k, kx, y + LEVEL, base + 5 + Math.abs(leftOf(k, kx) + Math.floor(bw / 2) - c))
      kx += span(k, bw) + GAP
      return { at, isLive: isLive(k) }
    })
    const anyLive = ends.some(e => e.isLive)
    put(c, y + 2, { ch: '┬', color: line, d: base + 2, isLive: anyLive })
    put(c, y + 3, { ch: '│', color: line, d: base + 3, isLive: anyLive })
    const lo = Math.min(c, ...ends.map(e => e.at))
    const hi = Math.max(c, ...ends.map(e => e.at))
    for (let x = lo; x <= hi; x += 1) {
      const arms = (x === c ? 8 : 0) | (ends.some(e => e.at === x) ? 4 : 0) | (x > lo ? 2 : 0) | (x < hi ? 1 : 0)
      // A bus cell leads to each child on its side at or past it.
      const live = ends.some(e => e.isLive && (x === c || (x < c ? e.at <= x : e.at >= x)))
      put(x, y + 4, { ch: JOIN[arms] ?? '─', color: line, d: base + 4 + Math.abs(x - c), isLive: live })
    }
    for (const e of ends) {
      put(e.at, y + LEVEL, { ch: '┴', color: line, d: base + 5 + Math.abs(e.at - c), isLive: e.isLive })
    }

    return c
  }
  // Main's stub is distance 0.
  place(root, 0, 0, -3)

  const isLit = (cell: Cell) =>
    cell.isLive === true && cell.d !== undefined && (frame === undefined || (((cell.d - frame) % PULSE) + PULSE) % PULSE === 0)
  const isCut = gridW > width
  const pad = isCut ? 0 : Math.floor((width - gridW) / 2)
  const rows = grid.map(row => {
    const cells = isCut && row.slice(width - 1).some(c => c.ch !== ' ') ? [...row.slice(0, width - 1), { ch: '…', color: line }] : row.slice(0, width)
    const runs: Run[] = pad > 0 ? [{ text: ' '.repeat(pad), color: line }] : []
    for (const cell of cells) {
      const ch = isLit(cell) ? (HEAVY[cell.ch] ?? cell.ch) : cell.ch
      const color = isLit(cell) ? pulse : cell.color
      const last = runs.at(-1)
      if (last?.color === color) {
        last.text += ch
      } else {
        runs.push({ text: ch, color })
      }
    }
    return runs
  })

  return { rows, isCut }
}
