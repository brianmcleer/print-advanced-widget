/** @jsx jsx */
/**
 * Print Advanced settings - pagx importer.
 * The LOOK of the output is driven entirely by the imported ArcGIS Pro .pagx
 * layout. Settings only handle: which map, which .pagx files, capture options
 * (DPI, image format, extent mode), and attaching picture images (the .pagx
 * stores file paths, not image bytes).
 */
import { React, jsx, css, Immutable } from 'jimu-core'
import { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { Button, Select, TextInput, TextArea, NumericInput, Alert, Switch, Checkbox, Tooltip } from 'jimu-ui'
// Import UI constants from printConstants, NOT from runtime/lib/pdfRenderer.
// pdfRenderer imports esri/* modules; pulling it into the settings bundle makes
// the settings panel fail to load in the builder (no AMD loader there yet).
import { FORMAT_LABELS, NORTH_ARROW_STYLES, SCALE_BAR_STYLES, SCALE_BAR_UNITS } from '../printConstants'
import { IMConfig, PrintLayout, PictureEl, LegendEl, newLayoutId } from '../config'
import { parsePagx } from '../pagxParser'
import defaultMessages from './translations/default'

interface State {
    fontImport: string
    fontImportBusy: boolean
    fontImportMsg: string
    newFontName: string
    newFontUrl: string
    newFontBoldUrl: string
    editingId: string
    importWarnings: string[]
    importError: string | null
    exportXml: string
    importXml: string
    ieError: string | null
    ieSuccess: string | null
}

const XML_ROOT = 'PrintAdvancedConfig'

function xmlEsc(s: string): string {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Serialize any JSON-ish config value to typed, round-trippable XML.
 *  Each element carries t = s|n|b|o|a|null so import restores exact types. */
function valueToXml(value: any, tag: string, indent: string): string {
    const pad = indent
    if (value === null || value === undefined) return `${pad}<${tag} t="null"/>`
    if (Array.isArray(value)) {
        if (!value.length) return `${pad}<${tag} t="a"/>`
        const items = value.map(v => valueToXml(v, 'item', indent + '  ')).join('\n')
        return `${pad}<${tag} t="a">\n${items}\n${pad}</${tag}>`
    }
    const type = typeof value
    if (type === 'object') {
        const keys = Object.keys(value)
        if (!keys.length) return `${pad}<${tag} t="o"/>`
        const kids = keys.map(k => valueToXml(value[k], k, indent + '  ')).join('\n')
        return `${pad}<${tag} t="o">\n${kids}\n${pad}</${tag}>`
    }
    if (type === 'number') return `${pad}<${tag} t="n">${value}</${tag}>`
    if (type === 'boolean') return `${pad}<${tag} t="b">${value ? 'true' : 'false'}</${tag}>`
    return `${pad}<${tag} t="s">${xmlEsc(value)}</${tag}>`
}

function configToXml(config: any): string {
    const body = valueToXml(config || {}, XML_ROOT, '')
    // inject version attribute on the root element
    const withVer = body.replace(`<${XML_ROOT} t="o"`, `<${XML_ROOT} version="1" t="o"`)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + withVer + '\n'
}

interface CfgNode { tag: string, attrs: { [k: string]: string }, children: CfgNode[], text: string }

/** Unescape the XML entities our serializer emits, plus numeric refs. */
function unescapeXml(s: string): string {
    // Single pass over one alternation, so a decoded value can never be re-scanned
    // and turned back into an entity. Each match maps to exactly one character.
    return s.replace(/&(?:lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#\d+);/g, (ent) => {
        switch (ent) {
            case '&lt;': return '<'
            case '&gt;': return '>'
            case '&quot;': return '"'
            case '&apos;': return "'"
            case '&amp;': return '&'
            default:
                return ent.charAt(2) === 'x' || ent.charAt(2) === 'X'
                    ? String.fromCodePoint(parseInt(ent.slice(3, -1), 16))
                    : String.fromCodePoint(Number(ent.slice(2, -1)))
        }
    })
}

/**
 * Parse our own structurally-typed config XML WITHOUT DOMParser, so the imported
 * string is never handed to a markup/HTML parser. The format is exactly what
 * valueToXml (above) produces: elements carrying t = s|n|b|o|a|null, arrays of
 * <item>, objects keyed by tag name. Patterns are delimiter-bounded (no nested
 * quantifiers) to avoid catastrophic backtracking.
 */
function parseConfigXml(xml: string): CfgNode {
    // Single scan. The prolog (<?...?>), comments (<!--...-->) and declarations
    // (<!...>) are matched as tokens and skipped in place, so there is no separate
    // string-sanitization pass. Every pattern is delimiter-bounded to avoid
    // catastrophic backtracking.
    const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_$][\w.$-]*)([^>]*?)(\/?)>/g
    const attrRe = /([\w.$-]+)\s*=\s*"([^"]*)"/g
    const stack: CfgNode[] = []
    let root: CfgNode | null = null
    let last = 0
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(xml)) !== null) {
        if (stack.length) {
            const between = xml.slice(last, m.index)
            if (between) stack[stack.length - 1].text += unescapeXml(between)
        }
        last = tokenRe.lastIndex
        const name = m[2]
        if (name === undefined) continue // prolog / comment / declaration: skip
        if (m[1] === '/') { // closing tag
            const node = stack.pop()
            if (!node || node.tag !== name) throw new Error('The file is not valid XML.')
            if (!stack.length) root = node
            continue
        }
        const attrs: { [k: string]: string } = {}
        let a: RegExpExecArray | null
        attrRe.lastIndex = 0
        while ((a = attrRe.exec(m[3] || '')) !== null) attrs[a[1]] = unescapeXml(a[2])
        const node: CfgNode = { tag: name, attrs, children: [], text: '' }
        if (stack.length) stack[stack.length - 1].children.push(node)
        if (m[4] === '/') { if (!stack.length) root = node } // self-closing element
        else stack.push(node)
    }
    if (stack.length || !root) throw new Error('The file is not valid XML.')
    return root
}

/** Restore a config value from a parsed node using its t attribute. */
function nodeToValue(node: CfgNode): any {
    const t = node.attrs.t
    if (t === 'null') return null
    if (t === 'a') return node.children.map(nodeToValue)
    if (t === 'o') {
        const obj: any = {}
        node.children.forEach(c => { obj[c.tag] = nodeToValue(c) })
        return obj
    }
    const text = node.text
    if (t === 'n') return text === '' ? 0 : Number(text)
    if (t === 'b') return text === 'true'
    return text // t === 's' (default)
}

function xmlToConfig(xmlString: string): any {
    const root = parseConfigXml(xmlString)
    if (root.tag !== XML_ROOT && root.tag !== 'PrintDesignerConfig') {
        throw new Error('This is not a Print Advanced configuration (root <' + XML_ROOT + '> not found).')
    }
    return nodeToValue(root)
}

export default class Setting extends React.PureComponent<AllWidgetSettingProps<IMConfig>, State> {
    private fileInputRef = React.createRef<HTMLInputElement>()
    private pictureInputRef = React.createRef<HTMLInputElement>()
    private logoInputRef = React.createRef<HTMLInputElement>()
    private xmlInputRef = React.createRef<HTMLInputElement>()
    private pendingPictureIndex = -1

    constructor(props: AllWidgetSettingProps<IMConfig>) {
        super(props)
        const layouts = this.getLayouts()
        this.state = {
            editingId: layouts.length > 0 ? layouts[0].id : '',
            importWarnings: [],
            importError: null,
            exportXml: '',
            importXml: '',
            ieError: null,
            ieSuccess: null,
            fontImport: '',
            fontImportBusy: false,
            fontImportMsg: '',
            newFontName: '',
            newFontUrl: '',
            newFontBoldUrl: ''
        }
    }

    /* ---------------- config plumbing ---------------- */

    getLayouts = (): PrintLayout[] => {
        const raw = this.props.config && (this.props.config as any).layouts
        if (!raw) return []
        const arr = typeof (raw as any).asMutable === 'function'
            ? (raw as any).asMutable({ deep: true })
            : [...(raw as any)]
        return arr as PrintLayout[]
    }

    commitLayouts = (layouts: PrintLayout[]): void => {
        const base: any = (this.props.config as any) || Immutable({})
        this.props.onSettingChange({
            id: this.props.id,
            config: base.set('layouts', Immutable(layouts))
        })
    }

    currentConfigPlain = (): any => {
        const c: any = this.props.config
        return c && c.asMutable ? c.asMutable({ deep: true }) : (c || {})
    }

    exportConfig = (): void => {
        try {
            const xml = configToXml(this.currentConfigPlain())
            this.setState({ exportXml: xml, ieError: null, ieSuccess: null })
        } catch (e: any) {
            this.setState({ ieError: (e && e.message) || 'Export failed.' })
        }
    }

    copyConfig = (): void => {
        const m = defaultMessages as any
        const xml = this.state.exportXml || configToXml(this.currentConfigPlain())
        try {
            navigator.clipboard.writeText(xml)
            this.setState({ exportXml: xml, ieSuccess: m.ieCopied, ieError: null })
        } catch (e) {
            this.setState({ exportXml: xml, ieError: m.ieCopyFail })
        }
    }

    downloadConfig = (): void => {
        const xml = this.state.exportXml || configToXml(this.currentConfigPlain())
        const blob = new Blob([xml], { type: 'application/xml' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'print-advanced-config.xml'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        this.setState({ exportXml: xml })
    }

    onXmlFileChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = (ev) => this.setState({ importXml: String(ev.target?.result || ''), ieError: null, ieSuccess: null })
        reader.onerror = () => this.setState({ ieError: (defaultMessages as any).ieReadFail })
        reader.readAsText(file)
    }

    importConfig = (): void => {
        const m = defaultMessages as any
        const text = (this.state.importXml || '').trim()
        if (!text) { this.setState({ ieError: m.ieEmpty, ieSuccess: null }); return }
        try {
            const parsed = xmlToConfig(text)
            if (!parsed || typeof parsed !== 'object') throw new Error(m.ieBad)
            const next: any = Immutable(parsed)
            const layouts = (next.layouts && next.layouts.asMutable ? next.layouts.asMutable() : next.layouts) || []
            this.props.onSettingChange({ id: this.props.id, config: next })
            this.setState({
                editingId: layouts.length ? layouts[0].id : '',
                importXml: '',
                ieError: null,
                ieSuccess: m.ieImported
            })
        } catch (e: any) {
            this.setState({ ieError: (e && e.message) || m.ieBad, ieSuccess: null })
        }
    }

    setCfg = (key: string, value: any): void => {
        const base: any = (this.props.config as any) || Immutable({})
        this.props.onSettingChange({
            id: this.props.id,
            config: value === undefined || value === '' ? base.without(key) : base.set(key, value)
        })
    }

    setMapExtent = (field: string, value: any): void => {
        let base: any = (this.props.config as any) || Immutable({})
        const cur = base.mapExtent
        const obj = (cur && cur.asMutable ? cur.asMutable({ deep: true }) : cur) || {}
        const next: any = { ...obj }
        if (value === '' || value === undefined) delete next[field]
        else next[field] = value
        this.props.onSettingChange({
            id: this.props.id,
            config: Object.keys(next).length ? base.set('mapExtent', next) : base.without('mapExtent')
        })
    }

    meVal = (field: string): any => {
        const me: any = (this.props.config as any)?.mapExtent
        if (!me) return undefined
        return me[field]
    }

    meOn = (field: string, dflt = false): boolean => {
        const v = this.meVal(field)
        return v === undefined ? dflt : v !== false
    }

    setSub = (objKey: 'runtimeDefaults' | 'controls', field: string, value: any): void => {
        const base: any = (this.props.config as any) || Immutable({})
        const curRaw = base[objKey]
        const cur = (curRaw && curRaw.asMutable ? curRaw.asMutable() : curRaw) || {}
        const next = { ...cur }
        if (value === '' || value === undefined) delete next[field]
        else next[field] = value
        this.props.onSettingChange({
            id: this.props.id,
            config: Object.keys(next).length ? base.set(objKey, next) : base.without(objKey)
        })
    }

    toggleFormat = (v: string, on: boolean): void => {
        const base: any = (this.props.config as any) || Immutable({})
        const raw = base.enabledFormats
        const all = FORMAT_LABELS.filter(f => !f.disabled).map(f => f.value as string)
        let list: string[] = raw ? (raw.asMutable ? raw.asMutable() : [...raw]) : [...all]
        list = on ? Array.from(new Set([...list, v])) : list.filter(x => x !== v)
        if (!list.length) list = ['pdf'] // never allow zero formats
        const isAll = all.every(f => list.indexOf(f) >= 0)
        this.props.onSettingChange({
            id: this.props.id,
            config: isAll ? base.without('enabledFormats') : base.set('enabledFormats', list)
        })
    }

    formatEnabled = (v: string): boolean => {
        const raw: any = (this.props.config as any)?.enabledFormats
        if (!raw || !raw.length) return true
        const list = raw.asMutable ? raw.asMutable() : raw
        return list.indexOf(v) >= 0
    }

    /**
     * Resolve a Google Fonts family into direct TTF URLs from the
     * github.com/google/fonts repository (GitHub API is CORS-enabled).
     * Accepts a family name ("Montserrat") or a css2 link
     * (https://fonts.googleapis.com/css2?family=Montserrat) - the css2 CSS
     * itself only serves WOFF2, which PDF embedding cannot use, so the family
     * is resolved to real TTFs once here and stored as plain URLs.
     */
    resolveGoogleFont = async (): Promise<void> => {
        const q = (this.state.fontImport || '').trim()
        if (!q || this.state.fontImportBusy) return
        this.setState({ fontImportBusy: true, fontImportMsg: '' })
        try {
            let family = q
            const m = q.match(/[?&]family=([^&:@]+)/)
            if (m) family = decodeURIComponent(m[1].replace(/\+/g, ' '))
            family = family.replace(/^https?:\/\/\S*$/, '').trim() || q.trim()
            const slug = family.toLowerCase().replace(/[^a-z0-9]/g, '')
            const compact = family.replace(/\s+/g, '')
            if (!slug) throw new Error('Could not read a font family from that input.')

            let listing: any[] | null = null
            let basePath = ''
            let rateLimited = false
            for (const lic of ['ofl', 'apache', 'ufl']) {
                const r = await fetch(`https://api.github.com/repos/google/fonts/contents/${lic}/${slug}`)
                if (r.ok) { listing = await r.json(); basePath = `${lic}/${slug}`; break }
                if (r.status === 403) { rateLimited = true; break }
            }
            if (rateLimited) {
                throw new Error('GitHub API rate limit reached (60 lookups/hour per network). Wait a bit, or paste the TTF Raw URL directly into the fields below.')
            }
            if (!listing) throw new Error(`"${family}" was not found in the Google Fonts repository.`)

            let files = listing
            if (listing.some((e: any) => e.type === 'dir' && e.name === 'static')) {
                const r2 = await fetch(`https://api.github.com/repos/google/fonts/contents/${basePath}/static`)
                if (r2.ok) files = await r2.json()
            }
            const ttfs = files.filter((e: any) => e.type === 'file' && /\.ttf$/i.test(e.name))
            if (!ttfs.length) throw new Error(`No .ttf files found for "${family}".`)

            const exact = (suffix: string): any =>
                ttfs.find((e: any) => e.name.toLowerCase() === (compact + suffix).toLowerCase())
            let reg = exact('-Regular.ttf') || ttfs.find((e: any) => /-regular\.ttf$/i.test(e.name))
            let bold = exact('-Bold.ttf') ||
                ttfs.find((e: any) => /-bold\.ttf$/i.test(e.name) && !/(semi|extra|ultra)bold/i.test(e.name))
            let note = ''
            if (!reg) {
                // variable-font-only family: single file for all weights
                reg = ttfs.find((e: any) => /\[[^\]]*wght[^\]]*\]\.ttf$/i.test(e.name)) || ttfs[0]
                bold = undefined
                note = ' (variable-weight TTF; bold text renders in regular weight)'
            }

            this.addCustomFont({ name: family, url: reg.download_url, ...(bold ? { boldUrl: bold.download_url } : {}) })
            this.setState({
                fontImportBusy: false,
                fontImportMsg: `Imported ${family}${bold ? ' (regular + bold)' : ''}.${note} It appears in the widget's Font list (Advanced options); if it isn't there yet, save the app so the widget reloads.`
            })
        } catch (e: any) {
            this.setState({ fontImportBusy: false, fontImportMsg: (e && e.message) || 'Import failed.' })
        }
    }

    customFontsList = (): Array<{ name: string, url: string, boldUrl?: string }> => {
        const c: any = this.props.config
        const arr = c && c.customFonts && c.customFonts.asMutable ? c.customFonts.asMutable({ deep: true }) : (c && c.customFonts)
        const out: Array<any> = Array.isArray(arr) ? [...arr] : []
        const legacy = c && c.customFont && c.customFont.asMutable ? c.customFont.asMutable({ deep: true }) : (c && c.customFont)
        if (legacy && legacy.url && !out.some(f => f.name === legacy.name)) out.unshift(legacy)
        return out
    }

    addCustomFont = (font: { name: string, url: string, boldUrl?: string }): void => {
        let base: any = (this.props.config as any) || Immutable({})
        const cur = base.customFonts && base.customFonts.asMutable ? base.customFonts.asMutable({ deep: true }) : base.customFonts
        const list: Array<any> = Array.isArray(cur) ? cur.filter((f: any) => f.name.toLowerCase() !== font.name.toLowerCase()) : []
        // fold any legacy single font into the array too
        const legacy = base.customFont && base.customFont.asMutable ? base.customFont.asMutable({ deep: true }) : base.customFont
        if (legacy && legacy.url && legacy.name.toLowerCase() !== font.name.toLowerCase() && !list.some((f: any) => f.name === legacy.name)) {
            list.unshift(legacy)
        }
        list.push(font)
        base = base.set('customFonts', list)
        if (base.customFont) base = base.without('customFont')
        this.props.onSettingChange({ id: this.props.id, config: base })
    }

    removeCustomFont = (name: string): void => {
        let base: any = (this.props.config as any) || Immutable({})
        const cur = base.customFonts && base.customFonts.asMutable ? base.customFonts.asMutable({ deep: true }) : base.customFonts
        const list: Array<any> = (Array.isArray(cur) ? cur : []).filter((f: any) => f.name !== name)
        base = list.length ? base.set('customFonts', list) : base.without('customFonts')
        if (base.customFont && base.customFont.name === name) base = base.without('customFont')
        this.props.onSettingChange({ id: this.props.id, config: base })
    }

    addManualFont = (): void => {
        const name = (this.state.newFontName || '').trim()
        const url = (this.state.newFontUrl || '').trim()
        if (!name || !url) { this.setState({ fontImportMsg: (defaultMessages as any).fontNeedNameUrl }); return }
        this.addCustomFont({ name, url, ...(this.state.newFontBoldUrl.trim() ? { boldUrl: this.state.newFontBoldUrl.trim() } : {}) })
        this.setState({ newFontName: '', newFontUrl: '', newFontBoldUrl: '', fontImportMsg: (defaultMessages as any).fontAdded.replace('{name}', name) })
    }

    setDefaultLogo = (dataUrl: string | undefined): void => {
        const base: any = (this.props.config as any) || Immutable({})
        this.props.onSettingChange({
            id: this.props.id,
            config: dataUrl ? base.set('defaultLogo', dataUrl) : base.without('defaultLogo')
        })
    }

    /** Normalize any image file (incl. BMP) to a PNG dataURL via canvas. */
    normalizeImage = (file: File, done: (dataUrl: string | null) => void): void => {
        const url = URL.createObjectURL(file)
        const img = new Image()
        img.onload = () => {
            try {
                const c = document.createElement('canvas')
                c.width = img.naturalWidth || 300
                c.height = img.naturalHeight || 150
                const ctx = c.getContext('2d')
                if (!ctx) throw new Error('canvas')
                ctx.drawImage(img, 0, 0)
                done(c.toDataURL('image/png'))
            } catch (e) { done(null) } finally { URL.revokeObjectURL(url) }
        }
        img.onerror = () => { URL.revokeObjectURL(url); done(null) }
        img.src = url
    }

    onLogoChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''
        if (!file) return
        this.normalizeImage(file, (dataUrl) => {
            if (dataUrl) this.setDefaultLogo(dataUrl)
            else this.setState({ importError: 'Could not read that image.' })
        })
    }

    getEditing = (): PrintLayout | null => {
        const layouts = this.getLayouts()
        return layouts.find(l => l.id === this.state.editingId) || layouts[0] || null
    }

    patch = (partial: Partial<PrintLayout>): void => {
        const editing = this.getEditing()
        if (!editing) return
        this.commitLayouts(this.getLayouts().map(l => (l.id === editing.id ? { ...l, ...partial } : l)))
    }

    onMapWidgetSelected = (useMapWidgetIds: string[]): void => {
        this.props.onSettingChange({ id: this.props.id, useMapWidgetIds })
    }

    /* ---------------- pagx import ---------------- */

    onImportClick = (): void => {
        this.fileInputRef.current?.click()
    }

    onPagxChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            try {
                const doc = JSON.parse(String(reader.result))
                const { layout, warnings } = parsePagx(doc, file.name)
                this.commitLayouts([...this.getLayouts(), layout])
                this.setState({ editingId: layout.id, importWarnings: warnings, importError: null })
            } catch (err: any) {
                this.setState({ importError: (err && err.message) || 'Import failed.', importWarnings: [] })
            }
        }
        reader.onerror = () => this.setState({ importError: 'Could not read the file.', importWarnings: [] })
        reader.readAsText(file)
    }

    duplicateLayout = (): void => {
        const editing = this.getEditing()
        if (!editing) return
        const copy: PrintLayout = { ...editing, id: newLayoutId(), name: editing.name + ' (copy)' }
        this.commitLayouts([...this.getLayouts(), copy])
        this.setState({ editingId: copy.id })
    }

    removeLayout = (): void => {
        const editing = this.getEditing()
        if (!editing) return
        const layouts = this.getLayouts().filter(l => l.id !== editing.id)
        this.commitLayouts(layouts)
        this.setState({ editingId: layouts.length > 0 ? layouts[0].id : '', importWarnings: [] })
    }

    moveLayout = (dir: -1 | 1): void => {
        const editing = this.getEditing()
        if (!editing) return
        const layouts = this.getLayouts()
        const i = layouts.findIndex(l => l.id === editing.id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= layouts.length) return
        const next = [...layouts]
        const t = next[i]; next[i] = next[j]; next[j] = t
        this.commitLayouts(next)
    }

    /* ---------------- picture attachment ---------------- */

    onAttachPicture = (elementIndex: number): void => {
        this.pendingPictureIndex = elementIndex
        this.pictureInputRef.current?.click()
    }

    onPictureChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''
        const idx = this.pendingPictureIndex
        this.pendingPictureIndex = -1
        const editing = this.getEditing()
        if (!file || !editing || idx < 0) return

        this.normalizeImage(file, (dataUrl) => {
            if (!dataUrl) { this.setState({ importError: 'Could not read that image (unsupported format?).' }); return }
            const elements = editing.elements.map((el, i) =>
                i === idx && el.type === 'picture' ? { ...el, dataUrl } : el
            )
            this.patch({ elements })
        })
    }

    clearPicture = (elementIndex: number): void => {
        const editing = this.getEditing()
        if (!editing) return
        const elements = editing.elements.map((el, i) =>
            i === elementIndex && el.type === 'picture' ? { ...el, dataUrl: undefined } : el
        )
        this.patch({ elements })
    }

    toggleWhiteBg = (elementIndex: number, whiteBg: boolean): void => {
        const editing = this.getEditing()
        if (!editing) return
        const elements = editing.elements.map((el, i) =>
            i === elementIndex && el.type === 'picture' ? { ...el, whiteBg } : el
        )
        this.patch({ elements })
    }

    patchLegendMax = (elementIndex: number, maxItems: number): void => {
        const editing = this.getEditing()
        if (!editing) return
        const elements = editing.elements.map((el, i) =>
            i === elementIndex && el.type === 'legend' ? { ...el, maxItems } : el
        )
        this.patch({ elements })
    }

    /* ---------------- render helpers ---------------- */

    rowWrap = (label: string, control: React.ReactNode) => (
        <SettingRow flow='wrap' label={label} truncateLabel>{control}</SettingRow>
    )

    rowInline = (label: string, control: React.ReactNode) => (
        <SettingRow label={label} truncateLabel>{control}</SettingRow>
    )

    select = (value: string, onChange: (v: string) => void, options: Array<{ value: string, label: string }>) => (
        <Select size='sm' className='w-100' value={value} onChange={(e: any) => onChange(e.target.value)}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
    )

    getStyle = () => css`
    .pd-toolbar { display: flex; gap: .375rem; width: 100%; .jimu-btn { flex: 1 1 0; } }
    .pd-hint { font-size: .8125rem; color: var(--ref-palette-neutral-1100); line-height: 1.3; }
    .pd-font-item { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: 2px 0; }
    .pd-font-name { flex: 1 1 auto; font-size: .8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pd-warn {
      font-size: .75rem; color: var(--ref-palette-neutral-1100);
      background: var(--ref-palette-neutral-300); border-radius: 2px;
      padding: .375rem .5rem; margin-top: .25rem; line-height: 1.35;
      max-height: 12rem; overflow: auto; width: 100%;
      ul { margin: 0; padding-left: 1rem; }
    }
    .pd-pic { display: flex; align-items: center; gap: .5rem; width: 100%;
      img { width: 2.25rem; height: 2.25rem; object-fit: contain; background: #fff; border: 1px solid var(--ref-palette-neutral-500); }
      .pd-pic-name { flex: 1 1 auto; font-size: .8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    }
    .pd-src { font-size: .75rem; color: var(--ref-palette-neutral-1000); word-break: break-all; }
  `

    render(): React.ReactNode {
        const messages = defaultMessages as any
        const layouts = this.getLayouts()
        const editing = this.getEditing()

        return (
            <div css={this.getStyle()}>
                {/* hidden file inputs */}
                <input ref={this.fileInputRef} type='file' accept='.pagx,application/json'
                    tabIndex={-1} aria-label={messages.importPagx}
                    style={{ display: 'none' }} onChange={this.onPagxChosen} />
                <input ref={this.pictureInputRef} type='file' accept='image/*'
                    tabIndex={-1} aria-label={messages.attachImage}
                    style={{ display: 'none' }} onChange={this.onPictureChosen} />
                <input ref={this.logoInputRef} type='file' accept='image/*'
                    tabIndex={-1} aria-label={messages.attachImage}
                    style={{ display: 'none' }} onChange={this.onLogoChosen} />
                <input ref={this.xmlInputRef} type='file' accept='.xml,text/xml,application/xml'
                    tabIndex={-1} aria-label={messages.ieImportFile}
                    style={{ display: 'none' }} onChange={this.onXmlFileChosen} />

                <SettingSection title={messages.mapSection}>
                    <SettingRow>
                        <MapWidgetSelector
                            useMapWidgetIds={this.props.useMapWidgetIds}
                            onSelect={this.onMapWidgetSelected}
                        />
                    </SettingRow>
                </SettingSection>

                <SettingSection title={messages.srcSection}>
                    <SettingRow flow='wrap' label={messages.srcMode} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.printSource) || 'pagx'}
                            onChange={(e: any) => this.setCfg('printSource', e.target.value === 'pagx' ? '' : e.target.value)}>
                            <option value='pagx'>{messages.srcPagx}</option>
                            <option value='service'>{messages.srcService}</option>
                        </Select>
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-hint'>{messages.srcHint}</div>
                    </SettingRow>
                    {((this.props.config as any)?.printSource === 'service') && (
                        <React.Fragment>
                            <SettingRow flow='wrap' label={messages.srcUrl} truncateLabel>
                                <TextInput size='sm' className='w-100'
                                    value={((this.props.config as any)?.printServiceUrl) || ''}
                                    placeholder='https://…/arcgis/rest/services/…/GPServer/Export%20Web%20Map%20Task'
                                    onChange={(e: any) => this.setCfg('printServiceUrl', e.target.value)} />
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.srcTemplates} truncateLabel>
                                <TextInput size='sm' className='w-100'
                                    value={(() => { const c = (this.props.config as any)?.serviceTemplates; const a = c && c.asMutable ? c.asMutable() : c; return Array.isArray(a) ? a.join(', ') : '' })()}
                                    placeholder='letter-ansi-a-landscape, a4-landscape, map-only'
                                    onChange={(e: any) => {
                                        const list = String(e.target.value).split(',').map(s => s.trim()).filter(Boolean)
                                        this.setCfg('serviceTemplates', list.length ? list : '')
                                    }} />
                            </SettingRow>
                            <SettingRow>
                                <div className='pd-hint'>{messages.srcTemplatesHint}</div>
                            </SettingRow>
                        </React.Fragment>
                    )}
                </SettingSection>

                <SettingSection title={messages.layoutsSection}>
                    <SettingRow>
                        <div className='pd-hint'>{messages.pagxIntro}</div>
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-toolbar'>
                            <Tooltip title={messages.importPagxTip} placement='top'>
                                <Button size='sm' type='primary' onClick={this.onImportClick}>{messages.importPagx}</Button>
                            </Tooltip>
                            <Tooltip title={messages.duplicateTip} placement='top'>
                                <Button size='sm' onClick={this.duplicateLayout} disabled={!editing}>{messages.duplicate}</Button>
                            </Tooltip>
                            <Tooltip title={messages.removeTip} placement='top'>
                                <Button size='sm' onClick={this.removeLayout} disabled={!editing}>{messages.remove}</Button>
                            </Tooltip>
                        </div>
                    </SettingRow>
                    {layouts.length > 1 && (
                        <SettingRow label={messages.layoutOrder} truncateLabel>
                            <div style={{ display: 'flex', gap: '.375rem' }}>
                                <Button size='sm' icon
                                    title={messages.moveUp}
                                    aria-label={messages.moveUp}
                                    disabled={!editing || layouts.findIndex(l => l.id === (editing && editing.id)) <= 0}
                                    onClick={() => this.moveLayout(-1)}>↑</Button>
                                <Button size='sm' icon
                                    title={messages.moveDown}
                                    aria-label={messages.moveDown}
                                    disabled={!editing || layouts.findIndex(l => l.id === (editing && editing.id)) >= layouts.length - 1}
                                    onClick={() => this.moveLayout(1)}>↓</Button>
                            </div>
                        </SettingRow>
                    )}
                    {this.state.importError && (
                        <SettingRow>
                            <Alert type='error' text={this.state.importError} withIcon className='w-100' />
                        </SettingRow>
                    )}
                    {this.state.importWarnings.length > 0 && (
                        <SettingRow>
                            <div className='pd-warn'>
                                <strong>{messages.importNotes}</strong>
                                <ul>
                                    {this.state.importWarnings.map((w, i) => <li key={i}>{w}</li>)}
                                </ul>
                            </div>
                        </SettingRow>
                    )}
                    {layouts.length === 0 && !this.state.importError && (
                        <SettingRow>
                            <Alert type='info' text={messages.noLayouts} withIcon className='w-100' />
                        </SettingRow>
                    )}
                    {layouts.length > 0 && this.rowWrap(messages.editLayout,
                        this.select(editing ? editing.id : '', (id) => this.setState({ editingId: id, importWarnings: [] }),
                            layouts.map(l => ({ value: l.id, label: l.name })))
                    )}
                </SettingSection>

                {editing && (
                    <React.Fragment>
                        <SettingSection title={messages.layoutSection}>
                            {this.rowWrap(messages.name, (
                                <TextInput size='sm' className='w-100' value={editing.name}
                                    onChange={(e) => this.patch({ name: e.target.value })} />
                            ))}
                            <SettingRow>
                                <div className='pd-src'>
                                    {editing.sourceFile ? messages.source + ': ' + editing.sourceFile + ' · ' : ''}
                                    {editing.pageWidthIn} × {editing.pageHeightIn} in · {editing.elements.length} {messages.elements}
                                </div>
                            </SettingRow>
                        </SettingSection>

                        <SettingSection title={messages.captureSection}>
                            {this.rowWrap(messages.dpi, this.select(String(editing.dpi),
                                v => this.patch({ dpi: Number(v) }),
                                [
                                    { value: '96', label: '96 (draft)' },
                                    { value: '150', label: '150' },
                                    { value: '200', label: '200 (recommended)' },
                                    { value: '300', label: '300' }
                                ]))}
                            {this.rowWrap(messages.imageFormat, this.select(editing.imageFormat,
                                v => this.patch({ imageFormat: v as any }),
                                [
                                    { value: 'jpg', label: 'JPEG (smaller file)' },
                                    { value: 'png', label: 'PNG (crisper labels)' }
                                ]))}
                            {this.rowWrap(messages.preserve, this.select(editing.preserve,
                                v => this.patch({ preserve: v as any }),
                                [
                                    { value: 'scale', label: messages.preserveScale },
                                    { value: 'extent', label: messages.preserveExtent }
                                ]))}
                        </SettingSection>

                        {editing.elements.some(el => el.type === 'picture') && (
                            <SettingSection title={messages.picturesSection}>
                                <SettingRow>
                                    <div className='pd-hint'>{messages.picturesHint}</div>
                                </SettingRow>
                                {editing.elements.map((el, i) => {
                                    if (el.type !== 'picture') return null
                                    const pic = el as PictureEl
                                    return (
                                        <SettingRow key={i}>
                                            <div className='pd-pic'>
                                                {pic.dataUrl
                                                    ? <img src={pic.dataUrl} alt={pic.sourceName || messages.picturesSection} />
                                                    : <span aria-hidden='true' style={{ width: '2.25rem', textAlign: 'center' }}>none</span>}
                                                <span className='pd-pic-name' title={pic.sourceName}>{pic.sourceName}</span>
                                                <Button size='sm'
                                                    aria-label={(pic.dataUrl ? messages.replaceImage : messages.attachImage) + (pic.sourceName ? ': ' + pic.sourceName : '')}
                                                    onClick={() => this.onAttachPicture(i)}>
                                                    {pic.dataUrl ? messages.replaceImage : messages.attachImage}
                                                </Button>
                                                {pic.dataUrl && (
                                                    <Button size='sm'
                                                        aria-label={messages.clear + (pic.sourceName ? ': ' + pic.sourceName : '')}
                                                        onClick={() => this.clearPicture(i)}>{messages.clear}</Button>
                                                )}
                                            </div>
                                        </SettingRow>
                                    )
                                })}
                                {editing.elements.map((el, i) => {
                                    if (el.type !== 'picture') return null
                                    const pic = el as PictureEl
                                    return (
                                        <SettingRow key={'bg' + i} tag='label' label={messages.whiteBg + (pic.sourceName ? ' (' + pic.sourceName + ')' : '')} truncateLabel>
                                            <Switch checked={!!pic.whiteBg} onChange={(e) => this.toggleWhiteBg(i, e.target.checked)} />
                                        </SettingRow>
                                    )
                                })}
                            </SettingSection>
                        )}

                        {editing.elements.some(el => el.type === 'legend') && (
                            <SettingSection title={messages.legendSection}>
                                {editing.elements.map((el, i) => {
                                    if (el.type !== 'legend') return null
                                    const leg = el as LegendEl
                                    return (
                                        <SettingRow key={i} label={messages.legendMaxItems} truncateLabel>
                                            <NumericInput size='sm' value={leg.maxItems} min={1} max={100} step={1} showHandlers={false}
                                                onChange={(v) => { if (typeof v === 'number' && !isNaN(v)) this.patchLegendMax(i, Math.round(v)) }}
                                                style={{ width: '5.5rem' }} />
                                        </SettingRow>
                                    )
                                })}
                            </SettingSection>
                        )}
                    </React.Fragment>
                )}

                <SettingSection title={messages.widgetOptionsSection}>
                    <SettingRow tag='label' label={messages.allowAdvanced} truncateLabel>
                        <Switch
                            checked={((this.props.config as any)?.showAdvancedOptions) !== false}
                            onChange={(e) => {
                                const base: any = (this.props.config as any) || Immutable({})
                                this.props.onSettingChange({
                                    id: this.props.id,
                                    config: base.set('showAdvancedOptions', e.target.checked)
                                })
                            }}
                        />
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-hint'>{messages.allowAdvancedHint}</div>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defaultFont} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.defaultFontFamily) || 'sans'}
                            onChange={(e: any) => {
                                const base: any = (this.props.config as any) || Immutable({})
                                this.props.onSettingChange({
                                    id: this.props.id,
                                    config: base.set('defaultFontFamily', e.target.value)
                                })
                            }}>
                            <option value='sans'>Sans-serif (Helvetica / Arial)</option>
                            <option value='serif'>Serif (Times)</option>
                            <option value='mono'>Monospace (Courier)</option>
                        </Select>
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-hint'>{messages.defaultFontHint}</div>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.fontImportLabel} truncateLabel>
                        <div style={{ display: 'flex', gap: '.375rem', width: '100%' }}>
                            <TextInput size='sm' style={{ flex: 1 }}
                                aria-label={messages.fontImportLabel}
                                value={this.state.fontImport}
                                placeholder='Montserrat  or  https://fonts.googleapis.com/css2?family=Montserrat'
                                onChange={(e: any) => this.setState({ fontImport: e.target.value })} />
                            <Tooltip title={messages.fontImportTip} placement='top'>
                                <Button size='sm' type='primary' disabled={this.state.fontImportBusy}
                                    aria-label={messages.fontImportGo}
                                    onClick={this.resolveGoogleFont}>
                                    {this.state.fontImportBusy ? <span aria-hidden='true'>…</span> : messages.fontImportGo}
                                </Button>
                            </Tooltip>
                        </div>
                    </SettingRow>
                    {this.state.fontImportMsg && (
                        <SettingRow>
                            <div className='pd-hint' role='status' aria-live='polite'>{this.state.fontImportMsg}</div>
                        </SettingRow>
                    )}
                    {this.customFontsList().length > 0 && (
                        <SettingRow flow='wrap' label={messages.customFontsListLabel} truncateLabel>
                            <div className='w-100'>
                                {this.customFontsList().map(f => (
                                    <div key={f.name} className='pd-font-item'>
                                        <span className='pd-font-name' title={f.url}>{f.name}{f.boldUrl ? ' + bold' : ''}</span>
                                        <Button size='sm' type='tertiary'
                                            aria-label={messages.remove + ': ' + f.name}
                                            onClick={() => this.removeCustomFont(f.name)}>{messages.remove}</Button>
                                    </div>
                                ))}
                            </div>
                        </SettingRow>
                    )}
                    <SettingRow flow='wrap' label={messages.customFontName} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={this.state.newFontName}
                            placeholder='Open Sans'
                            onChange={(e: any) => this.setState({ newFontName: e.target.value })} />
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.customFontUrl} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={this.state.newFontUrl}
                            placeholder='https://…/OpenSans-Regular.ttf'
                            onChange={(e: any) => this.setState({ newFontUrl: e.target.value })} />
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.customFontBoldUrl} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={this.state.newFontBoldUrl}
                            placeholder='https://…/OpenSans-Bold.ttf (optional)'
                            onChange={(e: any) => this.setState({ newFontBoldUrl: e.target.value })} />
                    </SettingRow>
                    <SettingRow>
                        <Tooltip title={messages.customFontAddTip} placement='top'>
                            <Button size='sm' type='primary' className='w-100'
                                disabled={!this.state.newFontName.trim() || !this.state.newFontUrl.trim()}
                                onClick={this.addManualFont}>{messages.customFontAdd}</Button>
                        </Tooltip>
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-hint'>{messages.customFontHint}</div>
                    </SettingRow>
                </SettingSection>

                <SettingSection title={messages.defaultsSection}>
                    <SettingRow flow='wrap' label={messages.defFormat} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.runtimeDefaults?.format) || 'pdf'}
                            onChange={(e: any) => this.setSub('runtimeDefaults', 'format', e.target.value === 'pdf' ? '' : e.target.value)}>
                            {FORMAT_LABELS.filter(f => !f.disabled).map(f => (
                                <option key={f.value} value={f.value}>{f.label}</option>
                            ))}
                        </Select>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defDpi} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.runtimeDefaults?.dpi) || ''}
                            onChange={(e: any) => this.setSub('runtimeDefaults', 'dpi', e.target.value)}>
                            <option value=''>{messages.defDpiLayout}</option>
                            <option value='96'>96</option>
                            <option value='150'>150</option>
                            <option value='200'>200</option>
                            <option value='300'>300</option>
                        </Select>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defNa} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.runtimeDefaults?.northArrowStyle) || ''}
                            onChange={(e: any) => this.setSub('runtimeDefaults', 'northArrowStyle', e.target.value)}>
                            <option value=''>{messages.fromPagx}</option>
                            {NORTH_ARROW_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </Select>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defSb} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.runtimeDefaults?.scaleBarStyle) || ''}
                            onChange={(e: any) => this.setSub('runtimeDefaults', 'scaleBarStyle', e.target.value)}>
                            <option value=''>{messages.fromPagx}</option>
                            {SCALE_BAR_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </Select>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defUnits} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.runtimeDefaults?.scaleBarUnits) || ''}
                            onChange={(e: any) => this.setSub('runtimeDefaults', 'scaleBarUnits', e.target.value)}>
                            <option value=''>{messages.fromPagx}</option>
                            {SCALE_BAR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </Select>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defUnits2} truncateLabel>
                        <Select size='sm' className='w-100'
                            value={((this.props.config as any)?.runtimeDefaults?.scaleBarUnits2) || ''}
                            onChange={(e: any) => this.setSub('runtimeDefaults', 'scaleBarUnits2', e.target.value)}>
                            <option value=''>{messages.dualNone}</option>
                            {SCALE_BAR_UNITS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </Select>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defTitle} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={((this.props.config as any)?.defaultTitle) || ''}
                            placeholder='{layout}'
                            onChange={(e: any) => this.setCfg('defaultTitle', e.target.value)} />
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defAuthor} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={((this.props.config as any)?.defaultAuthor) || ''}
                            placeholder={messages.defAuthorPh}
                            onChange={(e: any) => this.setCfg('defaultAuthor', e.target.value)} />
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.defCopyright} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={((this.props.config as any)?.defaultCopyright) || ''}
                            onChange={(e: any) => this.setCfg('defaultCopyright', e.target.value)} />
                    </SettingRow>
                    <SettingRow tag='label' label={messages.includeAttribution} truncateLabel>
                        <Switch checked={((this.props.config as any)?.includeAttribution) !== false}
                            onChange={(e) => this.setCfg('includeAttribution', e.target.checked ? '' : false)} />
                    </SettingRow>
                    <SettingRow tag='label' label={messages.enableMapOnly} truncateLabel>
                        <Switch checked={((this.props.config as any)?.enableMapOnly) === true}
                            onChange={(e) => this.setCfg('enableMapOnly', e.target.checked ? true : '')} />
                    </SettingRow>
                    <SettingRow tag='label' label={messages.enableOutputSR} truncateLabel>
                        <Switch checked={((this.props.config as any)?.enableOutputSR) === true}
                            onChange={(e) => this.setCfg('enableOutputSR', e.target.checked ? true : '')} />
                    </SettingRow>
                    {((this.props.config as any)?.enableOutputSR) === true && (
                        <SettingRow flow='wrap' label={messages.defaultOutputWkid} truncateLabel>
                            <NumericInput size='sm' className='w-100' min={0} step={1}
                                value={Number((this.props.config as any)?.defaultOutputWkid) || 0}
                                onChange={(v: number) => this.setCfg('defaultOutputWkid', v ? Math.round(v) : '')} />
                        </SettingRow>
                    )}
                    <SettingRow flow='wrap' label={messages.defFilename} truncateLabel>
                        <TextInput size='sm' className='w-100'
                            value={((this.props.config as any)?.defaultFilename) || ''}
                            placeholder='{title}-{date}'
                            onChange={(e: any) => this.setCfg('defaultFilename', e.target.value)} />
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.maxCapture} truncateLabel>
                        <NumericInput size='sm' className='w-100' min={1024} max={8192} step={256}
                            value={Number((this.props.config as any)?.maxImagePx) || 4096}
                            onChange={(v: number) => this.setCfg('maxImagePx', v === 4096 ? '' : v)} />
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-hint'>{messages.defaultsHint}</div>
                    </SettingRow>
                </SettingSection>

                <SettingSection title={messages.meSection}>
                    <SettingRow tag='label' label={messages.meEnabled} truncateLabel>
                        <Switch checked={this.meOn('enabled')}
                            onChange={(e) => this.setMapExtent('enabled', e.target.checked ? true : '')} />
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-hint'>{messages.meHint}</div>
                    </SettingRow>
                    {this.meOn('enabled') && (
                        <React.Fragment>
                            <SettingRow tag='label' label={messages.meShowPreview} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('showPreview', true)}
                                    onChange={(e) => this.setMapExtent('showPreview', e.target.checked ? '' : false)} />
                            </SettingRow>
                            <SettingRow tag='label' label={messages.meShowPreserveScale} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('showPreserveScale', true)}
                                    onChange={(e) => this.setMapExtent('showPreserveScale', e.target.checked ? '' : false)} />
                            </SettingRow>
                            <SettingRow tag='label' label={messages.meShowPreserveExtent} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('showPreserveExtent')}
                                    onChange={(e) => this.setMapExtent('showPreserveExtent', e.target.checked ? true : '')} />
                            </SettingRow>
                            <SettingRow tag='label' label={messages.meShowForceScale} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('showForceScale')}
                                    onChange={(e) => this.setMapExtent('showForceScale', e.target.checked ? true : '')} />
                            </SettingRow>
                            <SettingRow tag='label' label={messages.meShowScaleSelect} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('showScaleSelect')}
                                    onChange={(e) => this.setMapExtent('showScaleSelect', e.target.checked ? true : '')} />
                            </SettingRow>
                            <SettingRow tag='label' label={messages.meShowLock} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('showLock')}
                                    onChange={(e) => this.setMapExtent('showLock', e.target.checked ? true : '')} />
                            </SettingRow>
                            <SettingRow tag='label' label={messages.mePreviewDefault} truncateLabel indentLevel={1}>
                                <Switch checked={this.meOn('previewOnByDefault')}
                                    onChange={(e) => this.setMapExtent('previewOnByDefault', e.target.checked ? true : '')} />
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.mePreviewOutline} truncateLabel>
                                <TextInput size='sm' className='w-100' value={this.meVal('previewOutlineColor') || '#007ac2'}
                                    onChange={(e: any) => this.setMapExtent('previewOutlineColor', e.target.value)} />
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.mePreviewWidth} truncateLabel>
                                <NumericInput size='sm' className='w-100' min={1} max={10} step={1}
                                    value={Number(this.meVal('previewOutlineWidth')) || 2}
                                    onChange={(v: number) => this.setMapExtent('previewOutlineWidth', v === 2 ? '' : v)} />
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.mePreviewFill} truncateLabel>
                                <TextInput size='sm' className='w-100' value={this.meVal('previewFillColor') || ''}
                                    placeholder={messages.mePreviewFillPh}
                                    onChange={(e: any) => this.setMapExtent('previewFillColor', e.target.value)} />
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.meDefaultMode} truncateLabel>
                                <Select size='sm' className='w-100' value={this.meVal('defaultMode') || 'current'}
                                    onChange={(e: any) => this.setMapExtent('defaultMode', e.target.value === 'current' ? '' : e.target.value)}>
                                    <option value='current'>{messages.modeCurrent}</option>
                                    <option value='preserveExtent'>{messages.modeExtent}</option>
                                    <option value='fixed'>{messages.modeFixed}</option>
                                </Select>
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.meDefaultScale} truncateLabel>
                                <NumericInput size='sm' className='w-100' min={1} step={100}
                                    value={Number(this.meVal('defaultScale')) || 0}
                                    onChange={(v: number) => this.setMapExtent('defaultScale', v || '')} />
                            </SettingRow>
                            <SettingRow flow='wrap' label={messages.meScaleChoices} truncateLabel>
                                <TextInput size='sm' className='w-100'
                                    value={(() => { const c = this.meVal('scaleChoices'); const a = c && c.asMutable ? c.asMutable() : c; return Array.isArray(a) ? a.join(', ') : '' })()}
                                    placeholder='1000, 2400, 6000, 12000, 24000, 50000'
                                    onChange={(e: any) => {
                                        const nums = String(e.target.value).split(',').map(s => parseInt(s.replace(/[^0-9]/g, ''), 10)).filter(n => n > 0)
                                        this.setMapExtent('scaleChoices', nums.length ? nums : '')
                                    }} />
                            </SettingRow>
                            <SettingRow>
                                <div className='pd-hint'>{messages.meScaleChoicesHint}</div>
                            </SettingRow>
                        </React.Fragment>
                    )}
                </SettingSection>

                <SettingSection title={messages.formatsSection}>
                    <SettingRow>
                        <div className='pd-hint'>{messages.formatsHint}</div>
                    </SettingRow>
                    {FORMAT_LABELS.filter(f => !f.disabled).map(f => (
                        <SettingRow key={f.value} tag='label' label={f.label} truncateLabel>
                            <Checkbox checked={this.formatEnabled(f.value)}
                                onChange={(e: any) => this.toggleFormat(f.value, e.target.checked)} />
                        </SettingRow>
                    ))}
                </SettingSection>

                <SettingSection title={messages.controlsSection}>
                    <SettingRow>
                        <div className='pd-hint'>{messages.controlsHint}</div>
                    </SettingRow>
                    {([
                        ['title', messages.ctrlTitle],
                        ['format', messages.ctrlFormat],
                        ['dpi', messages.ctrlDpi],
                        ['font', messages.ctrlFont],
                        ['northArrow', messages.ctrlNa],
                        ['scaleBar', messages.ctrlSb],
                        ['fileName', messages.ctrlFilename],
                        ['author', messages.ctrlAuthor],
                        ['copyright', messages.ctrlCopyright],
                        ['legend', messages.ctrlLegend]
                    ] as Array<[string, string]>).map(([key, label]) => (
                        <SettingRow key={key} tag='label' label={label} truncateLabel>
                            <Switch
                                checked={!((this.props.config as any)?.controls) || ((this.props.config as any).controls[key] !== false)}
                                onChange={(e) => this.setSub('controls', key, e.target.checked ? '' : false)} />
                        </SettingRow>
                    ))}
                    <SettingRow tag='label' label={messages.advOpenDefault} truncateLabel>
                        <Switch checked={((this.props.config as any)?.advancedOpenByDefault) === true}
                            onChange={(e) => this.setCfg('advancedOpenByDefault', e.target.checked ? true : '')} />
                    </SettingRow>
                </SettingSection>

                <SettingSection title={messages.logoSection}>
                    <SettingRow>
                        <div className='pd-hint'>{messages.logoHint}</div>
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-pic'>
                            {(this.props.config as any)?.defaultLogo
                                ? <img src={(this.props.config as any).defaultLogo} alt={messages.logoLabel} />
                                : <span aria-hidden='true' style={{ width: '2.25rem', textAlign: 'center' }}>none</span>}
                            <span className='pd-pic-name'>{messages.logoLabel}</span>
                            <Button size='sm'
                                aria-label={((this.props.config as any)?.defaultLogo ? messages.replaceImage : messages.attachImage) + ': ' + messages.logoLabel}
                                onClick={() => this.logoInputRef.current?.click()}>
                                {(this.props.config as any)?.defaultLogo ? messages.replaceImage : messages.attachImage}
                            </Button>
                            {(this.props.config as any)?.defaultLogo && (
                                <Button size='sm'
                                    aria-label={messages.clear + ': ' + messages.logoLabel}
                                    onClick={() => this.setDefaultLogo(undefined)}>{messages.clear}</Button>
                            )}
                        </div>
                    </SettingRow>
                </SettingSection>

                <SettingSection title={messages.ieSection}>
                    <SettingRow>
                        <div className='pd-hint'>{messages.ieHint}</div>
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-toolbar'>
                            <Tooltip title={messages.ieExportTip} placement='top'>
                                <Button size='sm' onClick={this.exportConfig}>{messages.ieExport}</Button>
                            </Tooltip>
                            <Tooltip title={messages.ieCopyTip} placement='top'>
                                <Button size='sm' onClick={this.copyConfig}>{messages.ieCopy}</Button>
                            </Tooltip>
                            <Tooltip title={messages.ieDownloadTip} placement='top'>
                                <Button size='sm' type='primary' onClick={this.downloadConfig}>{messages.ieDownload}</Button>
                            </Tooltip>
                        </div>
                    </SettingRow>
                    {this.state.exportXml && (
                        <SettingRow flow='wrap' label={messages.ieExportedLabel} truncateLabel>
                            <TextArea aria-label={messages.ieExportedLabel} className='w-100' readOnly
                                height={120} value={this.state.exportXml} />
                        </SettingRow>
                    )}

                    <SettingRow>
                        <div className='pd-hint'>{messages.ieImportHint}</div>
                    </SettingRow>
                    <SettingRow flow='wrap' label={messages.ieImportLabel} truncateLabel>
                        <TextArea aria-label={messages.ieImportLabel} className='w-100'
                            height={120} value={this.state.importXml}
                            placeholder={'<' + 'PrintAdvancedConfig version="1" ...>'}
                            onChange={(e: any) => this.setState({ importXml: e.target.value, ieError: null, ieSuccess: null })} />
                    </SettingRow>
                    <SettingRow>
                        <div className='pd-toolbar'>
                            <Tooltip title={messages.ieImportFileTip} placement='top'>
                                <Button size='sm' onClick={() => this.xmlInputRef.current?.click()}>{messages.ieImportFile}</Button>
                            </Tooltip>
                            <Tooltip title={messages.ieImportTip} placement='top'>
                                <Button size='sm' type='primary' disabled={!this.state.importXml.trim()}
                                    onClick={this.importConfig}>{messages.ieImport}</Button>
                            </Tooltip>
                        </div>
                    </SettingRow>
                    {(this.state.ieError || this.state.ieSuccess) && (
                        <SettingRow>
                            <div className='pd-hint' role='status' aria-live='polite'>
                                {this.state.ieError
                                    ? <span style={{ color: 'var(--sys-color-error-main, #d83020)' }}>{this.state.ieError}</span>
                                    : <span style={{ color: 'var(--sys-color-success-main, #2e7d32)' }}>{this.state.ieSuccess}</span>}
                            </div>
                        </SettingRow>
                    )}
                </SettingSection>

            </div>
        )
    }
}