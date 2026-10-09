import type { Register } from 'claude-code'

import { spendGate } from './spend-gate'
import { turnReceipt } from './turn-receipt'

export const register: Register = on => {
  spendGate(on)
  turnReceipt(on)
}
