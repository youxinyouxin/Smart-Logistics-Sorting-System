import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { RightNav } from './RightNav'

interface NavDrawerProps {
  open: boolean
  onClose: () => void
}

export function NavDrawer({ open, onClose }: NavDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="nav-drawer-backdrop" onMouseDown={onClose}>
      <div
        className="nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="主导航"
        ref={panelRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="nav-drawer__head">
          <span>物流分拣云平台</span>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭导航" ref={closeRef}>
            <X size={22} />
          </button>
        </div>
        <RightNav variant="drawer" onNavigate={onClose} />
      </div>
    </div>,
    document.body,
  )
}
