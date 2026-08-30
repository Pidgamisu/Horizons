import { useEffect, useState } from 'react'

// The same threshold BoardManager uses to pick its narrow board layout, so the
// chrome and the board always agree about which shape the screen is.
const NARROW_BELOW_ASPECT = 0.9
const SHORT_BELOW_HEIGHT = 520

function measure() {
  if (typeof window === 'undefined') return false
  // A phone on its side is short rather than narrow, but wants the same
  // compact bars, so both count here.
  return window.innerWidth / window.innerHeight < NARROW_BELOW_ASPECT ||
    window.innerHeight < SHORT_BELOW_HEIGHT
}

/**
 * True when the viewport is taller than it is wide enough to need the stacked
 * phone chrome. Driven by resize rather than a media query so it tracks
 * rotation and any container resize the same way the board does.
 */
export function useIsNarrow() {
  const [narrow, setNarrow] = useState(measure)
  useEffect(() => {
    const onResize = () => setNarrow(measure())
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return narrow
}
