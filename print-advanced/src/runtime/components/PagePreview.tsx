/** @jsx jsx */
/**
 * PagePreview - the live picture of the printed page shown in the panel.
 *
 * A function component for the same reason as FirstRunHint: `useTokens()` is a
 * hook and the Print Advanced widget is a class component. Every color is a
 * token read, so the frame follows the app's theme in light and dark mode.
 *
 * Accessibility: the image carries a text alternative, the caption is a
 * polite live region so a screen reader hears "Updating" and the printed
 * scale without the user moving focus, and aria-busy marks the refresh.
 */
import { React, jsx } from 'jimu-core'
import { useTokens } from '../theme'

export interface PagePreviewProps {
  url: string
  busy: boolean
  note: string
  alt: string
  loadingText: string
  updatingText: string
  /** page width / height, for the placeholder box before the first image */
  aspect: number
  captionId: string
}

const PagePreview: React.FC<PagePreviewProps> = ({ url, busy, note, alt, loadingText, updatingText, aspect, captionId }) => {
  const tokens = useTokens()
  return (
    <div className='pd-row'>
      <div
        aria-busy={busy}
        style={{
          position: 'relative',
          border: '1px solid ' + tokens.divider,
          borderRadius: tokens.radius,
          background: tokens.surface,
          overflow: 'hidden',
          lineHeight: 0,
          aspectRatio: aspect > 0 ? String(aspect) : undefined
        }}>
        {url
          ? <img src={url} alt={alt} aria-describedby={captionId}
              style={{ width: '100%', height: 'auto', display: 'block', opacity: busy ? 0.6 : 1 }} />
          : <div style={{ padding: 16, lineHeight: 1.4, fontSize: 12, color: tokens.textSecondary }}>{loadingText}</div>}
      </div>
      <div id={captionId} role='status' aria-live='polite'
        style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4, color: tokens.textSecondary }}>
        {busy && url ? updatingText : note}
      </div>
    </div>
  )
}

export default PagePreview
