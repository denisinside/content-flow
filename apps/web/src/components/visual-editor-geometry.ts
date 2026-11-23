import type { VisualLayer } from '@contextflow/visuals'

export interface RectBounds { x: number; y: number; width: number; height: number }
export interface SnapResult { x: number; y: number; guideX: number | null; guideY: number | null }

/** Coordinates are always in original 1080 px document space, never screen pixels. */
export function snapBounds(
  moving: RectBounds,
  others: ReadonlyArray<Pick<VisualLayer, 'x' | 'y' | 'width' | 'height' | 'hidden'>>,
  canvas: { width: number; height: number },
  threshold = 8,
): SnapResult {
  const candidatesX = [0, canvas.width / 2, canvas.width]
  const candidatesY = [0, canvas.height / 2, canvas.height]
  for (const other of others) {
    if (other.hidden) continue
    candidatesX.push(other.x, other.x + other.width / 2, other.x + other.width)
    candidatesY.push(other.y, other.y + other.height / 2, other.y + other.height)
  }
  const align = (position: number, size: number, candidates: number[], max: number) => {
    let delta = 0
    let closest = threshold + Number.EPSILON
    let line: number | null = null
    for (const anchor of candidates) for (const offset of [0, size / 2, size]) {
      const proposed = anchor - position - offset
      if (Math.abs(proposed) <= threshold && Math.abs(proposed) < closest) {
        closest = Math.abs(proposed)
        delta = proposed
        line = anchor
      }
    }
    const coordinate = Math.max(0, Math.min(max - size, Math.round(position + delta)))
    return { coordinate, line: Math.abs(coordinate - (position + delta)) < 1 ? line : null }
  }
  const x = align(moving.x, moving.width, candidatesX, canvas.width)
  const y = align(moving.y, moving.height, candidatesY, canvas.height)
  return { x: x.coordinate, y: y.coordinate, guideX: x.line, guideY: y.line }
}
