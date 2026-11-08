import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface OverlayProps {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

function useDialogFocus(open: boolean, onClose: () => void, ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const node = ref.current
    const focusables = node?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusables?.[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !focusables?.length) return
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
      document.body.style.overflow = bodyOverflow
      previous?.focus()
    }
  }, [open, onClose, ref])
}

export function Modal({ title, open, onClose, children, footer, wide = false }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(open, onClose, ref)
  if (!open) return null

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <X size={22} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ title, open, onClose, children, footer }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocus(open, onClose, ref)
  if (!open) return null

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer__head">
          <h2 className="drawer__title">{title}</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭">
            <X size={22} />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </aside>
    </div>,
    document.body,
  )
}
