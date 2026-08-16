// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { BalanceMeter, type BalanceMeterProps } from '../src/client/skeleton/BalanceMeter.tsx'

afterEach(cleanup)

const CNY: BalanceMeterProps['readBalance'] = () => Promise.resolve({
  balance: { currency: 'CNY', total: '26.52', granted: '0.00', toppedUp: '26.52' },
})

describe('BalanceMeter', () => {
  it('renders nothing while no balance is available', async () => {
    const view = render(<BalanceMeter readBalance={() => Promise.resolve({ balance: null })} running={false} />)
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('renders the balance text directly (not just an icon) once a balance lands', async () => {
    const view = render(<BalanceMeter readBalance={CNY} running={false} />)
    await vi.waitFor(() => expect(view.getByText('余额: ¥26.52')).toBeTruthy())
    // The hover detail carries the full breakdown; the visible text stays clean.
    const trigger = view.getByLabelText('余额: ¥26.52')
    expect(trigger.getAttribute('title')).toBe('总额 ¥26.52 · 赠送 ¥0.00 · 充值 ¥26.52')
    expect(trigger.textContent).toContain('余额: ¥26.52')
  })

  it('hides when the host query fails', async () => {
    const view = render(<BalanceMeter readBalance={() => Promise.reject(new Error('boom'))} running={false} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('refreshes on the running → idle edge (request completion)', async () => {
    const readBalance = vi.fn()
      .mockResolvedValueOnce({ balance: { currency: 'CNY', total: '1.00', granted: '0', toppedUp: '1' } })
      .mockResolvedValueOnce({ balance: { currency: 'CNY', total: '0.50', granted: '0', toppedUp: '0.5' } })
    const view = render(<BalanceMeter readBalance={readBalance} running={false} />)
    await vi.waitFor(() => expect(view.getByText('余额: ¥1.00')).toBeTruthy())
    // Turn starts, then completes → the edge triggers a second fetch.
    view.rerender(<BalanceMeter readBalance={readBalance} running={true} />)
    view.rerender(<BalanceMeter readBalance={readBalance} running={false} />)
    await vi.waitFor(() => expect(view.getByText('余额: ¥0.50')).toBeTruthy())
    expect(readBalance).toHaveBeenCalledTimes(2)
  })

  it('polls for live updates while visible', async () => {
    vi.useFakeTimers()
    try {
      const readBalance = vi.fn()
        .mockResolvedValueOnce({ balance: { currency: 'CNY', total: '1.00', granted: '0', toppedUp: '1' } })
        .mockResolvedValueOnce({ balance: { currency: 'CNY', total: '1.00', granted: '0', toppedUp: '1' } })
        .mockResolvedValueOnce({ balance: { currency: 'CNY', total: '0.40', granted: '0', toppedUp: '0.4' } })
      const view = render(<BalanceMeter readBalance={readBalance} running={false} />)
      // Flush the initial promise chain under fake timers.
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(view.getByText('余额: ¥1.00')).toBeTruthy())
      // Two poll ticks later the third fetch lands a changed balance.
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(view.getByText('余额: ¥0.40')).toBeTruthy())
      expect(readBalance).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders nothing without a host query (no session)', () => {
    const view = render(<BalanceMeter readBalance={undefined} running={false} />)
    expect(view.container.querySelector('button')).toBeNull()
  })
})
