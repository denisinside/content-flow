<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const footer = ref<HTMLElement>()
const ribbon = ref<SVGGElement>()
const ribbonWidth = 1400
const ribbonCopies = [-ribbonWidth, 0, ribbonWidth]
let disposeMotion = () => {}

const marks = [
  { name: 'pencil', path: 'm4 20 1-5L16 4l4 4L9 19l-5 1ZM14 6l4 4M4 20h7' },
  { name: 'page', path: 'M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h6' },
  { name: 'quote', path: 'M4 7h6v7H4zM10 14c0 3-2 4-4 4M14 7h6v7h-6zM20 14c0 3-2 4-4 4' },
  { name: 'book', path: 'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15M6 8h3M15 8h3M6 12h3M15 12h3' },
  { name: 'type', path: 'M4 6V3h16v3M12 3v18M8 21h8' },
  { name: 'paragraph', path: 'M13 3v18M18 3v18M21 3H9a5 5 0 0 0 0 10h4' },
  { name: 'check', path: 'm4 7 2 2 3-4M12 7h8M4 15l2 2 3-4M12 15h8' },
  { name: 'lines', path: 'M4 5h16M4 10h12M4 15h16M4 20h9' },
  { name: 'link', path: 'm10 14 4-4M7 17l-1 1a4 4 0 0 1-6-6l6-6a4 4 0 0 1 6 0M17 7l1-1a4 4 0 0 1 6 6l-6 6a4 4 0 0 1-6 0', transform: 'translate(2 0) scale(.85 1)' },
  { name: 'folder', path: 'M3 6h7l2 3h9v12H3zM3 6V3h7l2 3h9v3' },
]
const tiles = Array.from({ length: 42 }, (_, index) => {
  const row = Math.floor(index / 14)
  const column = index % 14
  const x = column * 100 + (row % 2 ? 42 : 10)
  const y = row * 80 + 20
  return { mark: marks[(column + row * 3) % marks.length]!, x, y, angle: [-12, 0, 10, 0][(column + row) % 4] }
})

onMounted(() => {
  const element = footer.value
  const track = ribbon.value
  if (!element || !track) return

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const listeners = new AbortController()
  let visible = false
  let pointerInside = false
  let pointerX = 0
  let direction = 0
  let velocity = 0
  let position = 0
  let lastTime = 0
  let frame: number | undefined

  function stop() {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    lastTime = 0
    velocity = 0
    track!.style.willChange = ''
  }

  function tick(time: number) {
    const elapsed = lastTime ? Math.min((time - lastTime) / 1000, 0.064) : 0
    lastTime = time
    const targetVelocity = pointerInside ? direction * 32 : 0
    // Ease velocity, rather than position: reversals retain momentum, brake,
    // cross zero and gently accelerate, including during rapid pointer changes.
    velocity += (targetVelocity - velocity) * (1 - Math.exp(-elapsed / 0.6))
    position = (position + velocity * elapsed + ribbonWidth) % ribbonWidth
    track!.style.transform = `translate3d(${position}px, 0, 0)`
    if (!targetVelocity && Math.abs(velocity) < 0.03) {
      stop()
      return
    }
    frame = requestAnimationFrame(tick)
  }

  function syncPlayback() {
    if (!visible || document.hidden || reducedMotion.matches) {
      stop()
      return
    }
    if (frame === undefined && (pointerInside || velocity)) {
      track!.style.willChange = 'transform'
      frame = requestAnimationFrame(tick)
    }
  }

  function updateDirection() {
    // A small neutral zone prevents jitter at the exact viewport midpoint.
    const midpoint = window.innerWidth / 2
    if (pointerX < midpoint - 8) direction = -1
    else if (pointerX > midpoint + 8) direction = 1
    syncPlayback()
  }

  function move(event: PointerEvent) {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return
    pointerInside = true
    pointerX = event.clientX
    updateDirection()
  }

  function leave() {
    pointerInside = false
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false
    syncPlayback()
  })
  observer.observe(element)
  window.addEventListener('pointermove', move, { passive: true, signal: listeners.signal })
  window.addEventListener('resize', updateDirection, { signal: listeners.signal })
  window.addEventListener('blur', leave, { signal: listeners.signal })
  document.addEventListener('pointerleave', leave, { signal: listeners.signal })
  document.addEventListener('visibilitychange', syncPlayback, { signal: listeners.signal })
  reducedMotion.addEventListener('change', syncPlayback, { signal: listeners.signal })
  disposeMotion = () => {
    listeners.abort()
    observer.disconnect()
    stop()
  }
})

onBeforeUnmount(() => disposeMotion())
</script>

<template>
  <footer
    ref="footer"
    class="editorial-footer"
  >
    <div
      class="editorial-footer-pattern"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 1200 220"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        stroke="currentColor"
        stroke-width="1.15"
        stroke-linecap="round"
        stroke-linejoin="round"
        focusable="false"
      >
        <g ref="ribbon">
          <g
            v-for="copy in ribbonCopies"
            :key="copy"
            :transform="`translate(${copy} 0)`"
          >
            <svg
              v-for="(tile, index) in tiles"
              :key="index"
              :x="tile.x"
              :y="tile.y"
              width="28"
              height="28"
              viewBox="0 0 24 24"
              :transform="`rotate(${tile.angle} ${tile.x + 14} ${tile.y + 14})`"
            >
              <path
                :d="tile.mark.path"
                :transform="tile.mark.transform"
              />
            </svg>
          </g>
        </g>
      </svg>
    </div>
    <div class="editorial-footer-inner">
      <p class="editorial-footer-name">
        ContextFlow
      </p>
      <p class="editorial-footer-signature">
        Редакторський простір
      </p>
    </div>
  </footer>
</template>

<style scoped>
.editorial-footer { position: relative; isolation: isolate; flex-shrink: 0; min-height: 137px; overflow: hidden; border-top: 1px solid var(--rule); background: #f7f7f5; color: var(--ink); }
.editorial-footer-inner { position: relative; width: min(100% - 88px, 1440px); margin-inline: auto; padding-block: 20px; }
.editorial-footer-name { margin: 0; font-family: var(--serif); font-size: 32px; font-weight: 500; line-height: 1.15; letter-spacing: -.025em; }
.editorial-footer-copy { margin: 10px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.editorial-footer-signature { margin: 10px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.editorial-footer-pattern { position: absolute; inset: 0 0 0 35%; z-index: -1; pointer-events: none; color: #abb0b1; opacity: .62; mask-image: linear-gradient(90deg, transparent, #000 40%); }
.editorial-footer-pattern > svg { width: 100%; height: 100%; }
@media (max-width: 900px) { .editorial-footer-inner { width: calc(100% - 48px); } }
@media (max-width: 760px) {
  .editorial-footer { min-height: 152px; }
  .editorial-footer-inner { width: calc(100% - 40px); }
  .editorial-footer-pattern { left: 15%; opacity: .4; mask-image: linear-gradient(90deg, transparent, #000 75%); }
}
</style>
