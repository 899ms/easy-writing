import { readonly, shallowRef } from 'vue'
import { listImportedFonts, readImportedFontFile, saveImportedFont } from '@/storage/local-fonts'
import type { ImportedFont, ImportedFontOption } from '@/types/imported-font'

const fonts = shallowRef<ImportedFontOption[]>([])
const loadedFonts = new Map<string, Promise<void>>()
let initialization: Promise<void> | undefined
const MAX_FONT_SIZE = 50 * 1024 * 1024

const toOption = (font: ImportedFont): ImportedFontOption => ({
  ...font,
  value: `"${font.id}", system-ui, sans-serif`,
})

export const importedFonts = readonly(fonts)

export function initImportedFonts(): Promise<void> {
  if (!initialization) {
    initialization = listImportedFonts().then((items) => {
      fonts.value = items.sort((a, b) => a.createdAt - b.createdAt).map(toOption)
    }).catch((error) => {
      initialization = undefined
      throw error
    })
  }
  return initialization
}

export function loadImportedFont(family: string): Promise<void> {
  const id = family.match(/^"(ew-imported-font-[a-f0-9]{64})"/)?.[1]
  if (!id) return Promise.resolve()
  const pending = loadedFonts.get(id)
  if (pending) return pending
  const loading = (async () => {
    const data = await readImportedFontFile(id)
    if (!data) throw new Error('找不到已导入字体，请重新导入')
    const face = await new FontFace(id, data, { display: 'swap' }).load()
    document.fonts.add(face)
  })().catch((error) => {
    loadedFonts.delete(id)
    throw error
  })
  loadedFonts.set(id, loading)
  return loading
}

export async function importFontFile(file: File, displayName?: string): Promise<{ font: ImportedFontOption; duplicate: boolean; renamed: boolean }> {
  if (!/\.(ttf|otf)$/i.test(file.name)) throw new Error('请选择 TTF 或 OTF 字体文件')
  if (!file.size) throw new Error('字体文件为空，请重新选择')
  if (file.size > MAX_FONT_SIZE) throw new Error('字体文件不能超过 50 MB')
  const customName = displayName?.trim()
  if (displayName !== undefined && (!customName || customName.length > 40)) throw new Error('字体名称须为 1 至 40 个字符')
  const data = await file.arrayBuffer()
  const signature = data.byteLength >= 12 ? new DataView(data).getUint32(0) : 0
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) {
    throw new Error('文件不是有效的 TTF 或 OTF 字体')
  }
  const hash = await crypto.subtle.digest('SHA-256', data)
  const id = 'ew-imported-font-' + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  await initImportedFonts()
  const existing = fonts.value.find((font) => font.id === id)
  if (existing) {
    await loadImportedFont(existing.value)
    if (customName && customName !== existing.name) {
      const font = { id, name: customName, createdAt: existing.createdAt }
      try {
        await saveImportedFont(font, data)
      } catch {
        throw new Error('字体名称保存失败，请检查本地存储空间后重试')
      }
      const option = toOption(font)
      fonts.value = fonts.value.map((item) => item.id === id ? option : item)
      return { font: option, duplicate: true, renamed: true }
    }
    return { font: existing, duplicate: true, renamed: false }
  }

  let face: FontFace
  try {
    face = await new FontFace(id, data, { display: 'swap' }).load()
  } catch {
    throw new Error('字体文件损坏或不受支持，请更换字体文件')
  }
  const font: ImportedFont = {
    id,
    name: customName || file.name.replace(/\.(ttf|otf)$/i, '').trim().slice(0, 40) || '导入字体',
    createdAt: Date.now(),
  }
  try {
    await saveImportedFont(font, data)
  } catch {
    throw new Error('字体保存失败，请检查本地存储空间后重试')
  }
  document.fonts.add(face)
  loadedFonts.set(id, Promise.resolve())
  const option = toOption(font)
  fonts.value = [...fonts.value.filter((item) => item.id !== id), option]
  return { font: option, duplicate: false, renamed: false }
}
