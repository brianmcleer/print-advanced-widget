/** Load linked logos only on demand, normalizing to PNG for every output backend. */
export function createLinkedLogoResolver(rawUrl?: string): () => Promise<string | undefined> {
    let pending: Promise<string | undefined> | undefined
    return () => {
        if (!rawUrl?.trim()) return Promise.resolve(undefined)
        if (!pending) pending = loadLinkedLogo(rawUrl.trim())
        return pending
    }
}

async function loadLinkedLogo(rawUrl: string): Promise<string | undefined> {
    let url: URL
    try {
        url = new URL(rawUrl, document.baseURI)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    } catch (e) { return undefined }
    return new Promise(resolve => {
        const img = new Image()
        let settled = false
        const finish = (value?: string) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            img.onload = null
            img.onerror = null
            resolve(value)
        }
        const timer = setTimeout(() => { finish(); img.src = '' }, 15000)
        img.crossOrigin = 'anonymous'
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas')
                canvas.width = img.naturalWidth
                canvas.height = img.naturalHeight
                if (!canvas.width || !canvas.height) { finish(); return }
                const ctx = canvas.getContext('2d')
                if (!ctx) { finish(); return }
                ctx.drawImage(img, 0, 0)
                finish(canvas.toDataURL('image/png'))
            } catch (e) { finish() }
        }
        img.onerror = () => finish()
        img.src = url.href
    })
}
