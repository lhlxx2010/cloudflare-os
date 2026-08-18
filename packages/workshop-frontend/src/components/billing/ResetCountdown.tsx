import { useEffect, useRef, useState } from 'react'

// Format the milliseconds remaining until `resetAt` as a compact "Hh Mm Ss" string.
function formatRemaining(ms: number): string {
  if (ms <= 0) return '0 秒'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours} 小时`)
  if (hours > 0 || minutes > 0) parts.push(`${minutes} 分钟`)
  parts.push(`${seconds} 秒`)
  return parts.join(' ')
}

/**
 * Live-ticking countdown to a reset time (ISO timestamp). Updates once per second. Calls
 * `onElapsed` once when the countdown reaches zero (e.g. to refresh usage). Renders nothing if no
 * valid `resetAt` is provided.
 */
export default function ResetCountdown({
  resetAt,
  onElapsed,
}: {
  resetAt?: string
  onElapsed?: () => void
}) {
  const [now, setNow] = useState(() => Date.now())

  // Keep the latest onElapsed in a ref so the "elapsed" effect can fire it without depending on a
  // (possibly unstable) callback identity, which would otherwise re-run the effect every render.
  const onElapsedRef = useRef(onElapsed)
  onElapsedRef.current = onElapsed

  const target = resetAt ? new Date(resetAt).getTime() : NaN
  const valid = Number.isFinite(target)

  useEffect(() => {
    if (!valid) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [valid, resetAt])

  const remaining = valid ? target - now : 0
  const elapsed = valid && remaining <= 0

  useEffect(() => {
    if (elapsed) onElapsedRef.current?.()
  }, [elapsed])

  if (!valid) return null

  return <span className="tabular-nums font-medium">{formatRemaining(remaining)}</span>
}
