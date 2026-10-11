// The box diagram of the agent tree: main on the left, each agent's children in a column to its right, joined by
// lines; a lane's heading sits over its first box. No engine here, so the tests lay it out directly. A line toward a working agent pulses away from its
// parent, one cell a frame, so the motion runs toward the subagents; motion off, the live path holds lit.

// `meta`: the line under the name, model and time. `title`: a heading over the box, as a lane's first agent has.
export type Node = { label: string; glyph: string; color: string; meta: string; isLive: boolean; kids: Node[]; title?: string }
export type Run = { text: string; color: string }

const BOX_MAX = 24
const BOX_MIN = 12
// A box: its borders around three lines, the name in up to two and the meta under it.
const BOX_H = 5
// The row of a box where its lines join.
const MID = Math.floor(BOX_H / 2)
// Rows between sibling boxes.
const GAP = 1
// Columns between a box and its children: the stub, the bus and the lead.
const LINK = 3
// One lit cell in every PULSE cells of a live line.
const PULSE = 4
// A line cell's arms as bits: up 8, down 4, left 2, right 1.
const JOIN: Record<number, string> = { 12: '│', 3: '─', 5: '┌', 6: '┐', 9: '└', 10: '┘', 7: '┬', 11: '┴', 13: '├', 14: '┤', 15: '┼' }
const HEAVY: Record<string, string> = { '─': '━', '│': '┃' }

// A line cell keeps its distance from the parent and whether a working agent lies beyond it.
type Cell = { ch: string; color: string; d?: number; isLive?: boolean }

export const fit = (v: string, w: number) => (v.length <= w ? v : `${v.slice(0, Math.max(0, w - 1))}…`)

// The label in one line of w, else two, broken at the last space that fits; the rest is cut.
function lines(label: string, w: number): string[] {
  if (label.length <= w) {
    return [label]
  }
  const at = label.lastIndexOf(' ', w)
  return at > 0 ? [label.slice(0, at), fit(label.slice(at + 1), w)] : [label.slice(0, w), fit(label.slice(w), w)]
}

// The rows over n's box: the headings over its first child, its first grandchild and so on, so n sits level with them.
const lift = (n: Node): number => (n.kids[0] === undefined ? 0 : (n.kids[0].title === undefined ? 0 : 1) + lift(n.kids[0]))
// A child's rows: its heading, then its subtree.
const slot = (k: Node): number => (k.title === undefined ? 0 : 1) + span(k)
const span = (n: Node): number => (n.kids.length === 0 ? BOX_H : n.kids.reduce((s, k) => s + slot(k) + GAP, -GAP))
const depth = (n: Node): number => (n.kids.length === 0 ? 0 : 1 + Math.max(...n.kids.map(depth)))
const isLive = (n: Node): boolean => n.isLive || n.kids.some(isLive)

// The diagram's rows as color runs, centered in `width`. `frame` moves the pulse; undefined holds it.
export function diagram(root: Node, width: number, frame: number | undefined, line: string, pulse: string) {
  // The widest boxes that fit; at the narrowest, the rows cut at the pane's edge.
  const d = depth(root)
  const bw = Math.max(BOX_MIN, Math.min(BOX_MAX, Math.floor((width - d * LINK) / (d + 1))))
  const gridW = (d + 1) * bw + d * LINK
  const grid: Cell[][] = Array.from({ length: span(root) }, () => Array.from({ length: gridW }, () => ({ ch: ' ', color: line })))
  const put = (x: number, y: number, cell: Cell) => {
    grid[y]![x] = cell
  }
  const write = (x: number, y: number, s: string, color: string) => [...s].forEach((ch, i) => put(x + i, y, { ch, color }))

  // Draws n's subtree from row y0, its box at row y, level with its first child's. `base` is the distance of the joint
  // on n's right border, so one pulse flows on from main through each box to its children.
  const place = (n: Node, x: number, y0: number, base: number) => {
    const y = y0 + lift(n)
    const [first = '', second] = lines(n.label, bw - 6)
    const body: [string, string][] = [[` ${n.glyph} ${first}`, n.color]]
    if (second !== undefined) {
      body.push([`   ${second}`, n.color])
    }
    body.push([`   ${fit(n.meta, bw - 6)}`, line])
    write(x, y, `╭${'─'.repeat(bw - 2)}╮`, line)
    for (let i = 0; i < BOX_H - 2; i += 1) {
      const [text, color] = body[i] ?? ['', line]
      write(x, y + 1 + i, '│', line)
      write(x + 1, y + 1 + i, text.padEnd(bw - 2), color)
      write(x + bw - 1, y + 1 + i, '│', line)
    }
    write(x, y + BOX_H - 1, `╰${'─'.repeat(bw - 2)}╯`, line)
    if (n.kids.length === 0) {
      return
    }

    const r = x + bw - 1
    const my = y + MID
    let ky = y0
    const ends = n.kids.map(k => {
      if (k.title !== undefined) {
        write(r + LINK + 1, ky, fit(k.title, gridW - r - LINK - 1), line)
        ky += 1
      }
      const at = ky + lift(k) + MID
      place(k, r + LINK + 1, ky, base + LINK + bw + (at - my))
      ky += span(k) + GAP
      return { at, isLive: isLive(k) }
    })
    const anyLive = ends.some(e => e.isLive)
    put(r, my, { ch: '├', color: line, d: base, isLive: anyLive })
    put(r + 1, my, { ch: '─', color: line, d: base + 1, isLive: anyLive })
    const hi = Math.max(...ends.map(e => e.at))
    for (let yy = my; yy <= hi; yy += 1) {
      const arms = (yy > my ? 8 : 0) | (yy < hi ? 4 : 0) | (yy === my ? 2 : 0) | (ends.some(e => e.at === yy) ? 1 : 0)
      // A bus cell leads to each child at or under it.
      const live = ends.some(e => e.isLive && e.at >= yy)
      put(r + 2, yy, { ch: JOIN[arms] ?? '│', color: line, d: base + 2 + (yy - my), isLive: live })
    }
    for (const e of ends) {
      put(r + 3, e.at, { ch: '─', color: line, d: base + 3 + (e.at - my), isLive: e.isLive })
      put(r + 4, e.at, { ch: '┤', color: line, d: base + 4 + (e.at - my), isLive: e.isLive })
    }
  }
  // Main's stub is distance 0.
  place(root, 0, 0, -1)

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
