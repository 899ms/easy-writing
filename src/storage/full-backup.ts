/**
 * 一键备份 / 一键恢复（桌面端，单个 zip）。
 *
 * 包内条目：
 *   manifest.json        格式与计数
 *   library.json         作品库四张表（分组/书/卷/章，含已删除）
 *   writing.json         正文草稿、章节历史版本、sync_settings 键值
 *   local-storage.json   全部 ew-* 本地键（模型配置含 API Key、提示词偏好、统计、界面设置……）
 *   fonts.json + fonts/  导入的自定义字体
 *   prompts/             提示词文档（Rust 侧直接从 Documents/易创提示词 进出）
 *
 * 恢复两种模式：
 *   overwrite  先清空再写入，工作台整体回到备份时的状态（可先自动做一次安全备份）
 *   merge      备份里的作品作为新记录加入；与本机冲突的 id 重映射，正文/版本/统计/位置随之改键；
 *              设置类以备份为准，模型按 id 补缺，其余本机已有的保留
 */

import { getLocalLibraryStorage } from './local-library'
import {
  buildChapterStorageKey,
  createChapterVersionId,
  getWritingStorage,
  isTauriRuntime,
  type LocalWritingSettings,
  type WritingStorageDump,
} from './index'
import type { LocalLibraryDump } from './local-library-types'
import { createLocalEntityId } from './local-library-utils'
import { clearImportedFonts, listImportedFonts, readImportedFontFile, saveImportedFont } from './local-fonts'
import type { ImportedFont } from '@/types/imported-font'

export type FullRestoreMode = 'overwrite' | 'merge'

export const FULL_BACKUP_FORMAT = 'ew-full-backup'
export const FULL_BACKUP_VERSION = 1

export interface FullBackupManifest {
  format: typeof FULL_BACKUP_FORMAT
  version: number
  createdAt: string
  appVersion: string
  platform: string
  counts: {
    groups: number
    books: number
    volumes: number
    chapters: number
    drafts: number
    versions: number
    fonts: number
    localStorageKeys: number
  }
}

export interface FullBackupSummary {
  path: string
  bytes: number
  entries: number
}

export interface FullBackupEntry {
  path: string
  size: number
}

export interface FullBackupInspection {
  session: string
  manifest: FullBackupManifest
  entries: FullBackupEntry[]
  promptCount: number
}

export interface FullRestoreReport {
  mode: FullRestoreMode
  books: number
  chapters: number
  versions: number
  fonts: number
  prompts: number
  safetyBackupPath: string
}

const LOCAL_STORAGE_PREFIX = 'ew-'
/** 会话级临时键，不进备份也不恢复 */
const LOCAL_STORAGE_SKIP = new Set(['ew-workflow-active-run'])
/** 合并模式下"以备份为准"的设置类键 */
const SETTINGS_KEYS = new Set([
  'ew-ui-preferences',
  'ew-theme',
  'ew-skin',
  'ew-writing-editor',
  'ew-writing-plan',
  'ew-workflow-rail-panel-width',
  'ew-writing-entity-highlight-dismissed',
])
const AI_MODELS_KEY = 'ew-local-ai-models'
const WRITE_STATS_KEY = 'ew-local-write-stats'
const POSITIONS_KEY = 'ew-writing-positions'
const LOCAL_SETTINGS_KEY = 'localWritingSettings'
const BOOK_WORD_COUNT_PREFIX = 'bookWordCounts:'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 纯函数：localStorage 快照
// ---------------------------------------------------------------------------

export const snapshotLocalStorage = (storage: StorageLike = localStorage): Record<string, string> => {
  const out: Record<string, string> = {}
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key || !key.startsWith(LOCAL_STORAGE_PREFIX) || LOCAL_STORAGE_SKIP.has(key)) continue
    const value = storage.getItem(key)
    if (value !== null) out[key] = value
  }
  return out
}

/** overwrite：先清掉本机全部 ew-* 键再写；merge：只写给定键 */
export const applyLocalStorageSnapshot = (
  next: Record<string, string>,
  mode: FullRestoreMode,
  storage: StorageLike = localStorage
) => {
  if (mode === 'overwrite') {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key && key.startsWith(LOCAL_STORAGE_PREFIX) && !LOCAL_STORAGE_SKIP.has(key)) keys.push(key)
    }
    keys.forEach(key => storage.removeItem(key))
  }
  for (const [key, value] of Object.entries(next)) {
    if (LOCAL_STORAGE_SKIP.has(key)) continue
    storage.setItem(key, value)
  }
}

// ---------------------------------------------------------------------------
// 纯函数：合并模式的 id 重映射
// ---------------------------------------------------------------------------

export interface IdRemap {
  groups: Map<number, number>
  books: Map<number, number>
  volumes: Map<number, number>
  chapters: Map<number, number>
}

export const emptyIdRemap = (): IdRemap => ({ groups: new Map(), books: new Map(), volumes: new Map(), chapters: new Map() })

export const collectLibraryIds = (dump: LocalLibraryDump) => {
  const ids = new Set<number>()
  dump.groups.forEach(item => ids.add(Number(item.id)))
  dump.books.forEach(item => ids.add(Number(item.id)))
  dump.volumes.forEach(item => ids.add(Number(item.id)))
  dump.chapters.forEach(item => ids.add(Number(item.id)))
  return ids
}

/** 本地 id 是负的时间戳；从当前时刻往下逐个分配，保证不撞本机已有 id */
export const createIdAllocator = (taken: Set<number>, seed = createLocalEntityId()) => {
  let cursor = seed
  return () => {
    do {
      cursor -= 1
    } while (taken.has(cursor))
    taken.add(cursor)
    return cursor
  }
}

/** 只给与本机冲突的 id 换新号；不冲突的保留原号，这样同机备份里"删掉后想找回"的书能原样回来 */
export const planIdRemap = (dump: LocalLibraryDump, existing: Set<number>, allocate: () => number): IdRemap => {
  const remap = emptyIdRemap()
  const assign = (map: Map<number, number>, id: number) => {
    if (existing.has(id)) map.set(id, allocate())
  }
  dump.groups.forEach(item => assign(remap.groups, Number(item.id)))
  dump.books.forEach(item => assign(remap.books, Number(item.id)))
  dump.volumes.forEach(item => assign(remap.volumes, Number(item.id)))
  dump.chapters.forEach(item => assign(remap.chapters, Number(item.id)))
  return remap
}

const mapId = (map: Map<number, number>, id: number | string | null | undefined) => {
  if (id === null || id === undefined || id === '') return id
  const numeric = Number(id)
  const next = map.get(numeric)
  return next === undefined ? id : next
}
const mapIdString = (map: Map<number, number>, id: string | number) => String(mapId(map, id))

export const remapLibraryDump = (dump: LocalLibraryDump, remap: IdRemap): LocalLibraryDump => ({
  groups: dump.groups.map(group => ({ ...group, id: Number(mapId(remap.groups, group.id)) })),
  books: dump.books.map(book => ({
    ...book,
    id: Number(mapId(remap.books, book.id)),
    groupId: book.groupId == null || book.groupId === '' ? book.groupId : mapIdString(remap.groups, book.groupId),
    lastChapterId: book.lastChapterId == null ? book.lastChapterId : Number(mapId(remap.chapters, book.lastChapterId)),
  })),
  volumes: dump.volumes.map(volume => ({
    ...volume,
    id: Number(mapId(remap.volumes, volume.id)),
    bookId: mapIdString(remap.books, volume.bookId),
  })),
  chapters: dump.chapters.map(chapter => ({
    ...chapter,
    id: Number(mapId(remap.chapters, chapter.id)),
    bookId: mapIdString(remap.books, chapter.bookId),
    volumeId: mapIdString(remap.volumes, chapter.volumeId),
  })),
})

const remapBookWordCounts = (raw: string, remap: IdRemap) => {
  const counts = parseJson<Record<string, number>>(raw, {})
  const next: Record<string, number> = {}
  for (const [bookId, count] of Object.entries(counts)) next[mapIdString(remap.books, bookId)] = count
  return next
}

export const remapWritingDump = (dump: WritingStorageDump, remap: IdRemap): WritingStorageDump => ({
  chapters: dump.chapters.map(chapter => {
    const bookId = mapIdString(remap.books, chapter.bookId)
    const chapterId = Number(mapId(remap.chapters, chapter.chapterId))
    return { ...chapter, bookId, chapterId, storageKey: buildChapterStorageKey(chapter.userId, bookId, chapterId) }
  }),
  versions: dump.versions.map(version => {
    const bookId = mapIdString(remap.books, version.bookId)
    const chapterId = Number(mapId(remap.chapters, version.chapterId))
    return {
      ...version,
      bookId,
      chapterId,
      id: createChapterVersionId(version.userId, bookId, chapterId, version.source, version.createdAt),
    }
  }),
  settings: dump.settings.map(item =>
    item.key.startsWith(BOOK_WORD_COUNT_PREFIX)
      ? { key: item.key, value: JSON.stringify(remapBookWordCounts(item.value, remap)) }
      : item
  ),
})

// ---------------------------------------------------------------------------
// 纯函数：localStorage 各键的重映射与合并
// ---------------------------------------------------------------------------

interface WriteStatsFile {
  version?: number
  targets?: unknown
  days?: Record<string, Record<string, unknown>>
  chapterBase?: Record<string, number>
  chapterTextBase?: Record<string, number>
}

const remapChapterKey = (key: string, remap: IdRemap) => {
  const [bookId, chapterId] = key.split(':')
  if (chapterId === undefined) return key
  return `${mapIdString(remap.books, bookId)}:${mapIdString(remap.chapters, chapterId)}`
}

const remapWriteStats = (file: WriteStatsFile, remap: IdRemap): WriteStatsFile => {
  const days: Record<string, Record<string, unknown>> = {}
  for (const [date, books] of Object.entries(file.days || {})) {
    days[date] = {}
    for (const [bookId, record] of Object.entries(books || {})) days[date][mapIdString(remap.books, bookId)] = record
  }
  const mapBase = (base?: Record<string, number>) => {
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(base || {})) out[remapChapterKey(key, remap)] = value
    return out
  }
  return { ...file, days, chapterBase: mapBase(file.chapterBase), chapterTextBase: mapBase(file.chapterTextBase) }
}

const mergeWriteStats = (currentRaw: string, backupRaw: string, remap: IdRemap) => {
  const current = parseJson<WriteStatsFile>(currentRaw, {})
  const backup = remapWriteStats(parseJson<WriteStatsFile>(backupRaw, {}), remap)
  const days = { ...(current.days || {}) }
  for (const [date, books] of Object.entries(backup.days || {})) {
    days[date] = { ...(books || {}), ...(days[date] || {}) }
  }
  return JSON.stringify({
    ...backup,
    ...current,
    days,
    chapterBase: { ...(backup.chapterBase || {}), ...(current.chapterBase || {}) },
    chapterTextBase: { ...(backup.chapterTextBase || {}), ...(current.chapterTextBase || {}) },
  })
}

type PositionsFile = Record<string, Record<string, unknown>>

const remapPositions = (file: PositionsFile, remap: IdRemap): PositionsFile => {
  const out: PositionsFile = {}
  for (const [bookId, chapters] of Object.entries(file || {})) {
    const nextBook = mapIdString(remap.books, bookId)
    out[nextBook] = {}
    for (const [chapterId, record] of Object.entries(chapters || {})) out[nextBook][mapIdString(remap.chapters, chapterId)] = record
  }
  return out
}

const mergePositions = (currentRaw: string, backupRaw: string, remap: IdRemap) => {
  const current = parseJson<PositionsFile>(currentRaw, {})
  const backup = remapPositions(parseJson<PositionsFile>(backupRaw, {}), remap)
  const out: PositionsFile = { ...backup }
  for (const [bookId, chapters] of Object.entries(current)) out[bookId] = { ...(out[bookId] || {}), ...chapters }
  return JSON.stringify(out)
}

interface AiModelsFile {
  version?: number
  models?: Array<{ id: number }>
  preferences?: Record<string, string>
}

const mergeAiModels = (currentRaw: string, backupRaw: string) => {
  const current = parseJson<AiModelsFile>(currentRaw, {})
  const backup = parseJson<AiModelsFile>(backupRaw, {})
  const known = new Set((current.models || []).map(model => Number(model.id)))
  const added = (backup.models || []).filter(model => !known.has(Number(model.id)))
  return JSON.stringify({
    version: current.version ?? backup.version ?? 1,
    models: [...(current.models || []), ...added],
    preferences: { ...(backup.preferences || {}), ...(current.preferences || {}) },
  })
}

/** 备份里的键在本机不存在时也要按新 id 改键（统计、位置） */
const remapLocalStorageValue = (key: string, raw: string, remap: IdRemap) => {
  if (key === WRITE_STATS_KEY) return JSON.stringify(remapWriteStats(parseJson<WriteStatsFile>(raw, {}), remap))
  if (key === POSITIONS_KEY) return JSON.stringify(remapPositions(parseJson<PositionsFile>(raw, {}), remap))
  return raw
}

export const mergeLocalStorage = (
  current: Record<string, string>,
  backup: Record<string, string>,
  remap: IdRemap
): Record<string, string> => {
  const next = { ...current }
  for (const [key, raw] of Object.entries(backup)) {
    if (LOCAL_STORAGE_SKIP.has(key)) continue
    if (!(key in current)) {
      next[key] = remapLocalStorageValue(key, raw, remap)
      continue
    }
    if (SETTINGS_KEYS.has(key)) next[key] = raw
    else if (key === AI_MODELS_KEY) next[key] = mergeAiModels(current[key], raw)
    else if (key === WRITE_STATS_KEY) next[key] = mergeWriteStats(current[key], raw, remap)
    else if (key === POSITIONS_KEY) next[key] = mergePositions(current[key], raw, remap)
    // 其余（灵感、敏感词、榜单缓存、备份印记等）本机已有就保留
  }
  return next
}

/** 备份目录是本机路径，换机器多半不存在；两种模式都沿用本机现有值 */
export const preserveMachineSettings = (
  settings: WritingStorageDump['settings'],
  current: LocalWritingSettings
): WritingStorageDump['settings'] =>
  settings.map(item => {
    if (item.key !== LOCAL_SETTINGS_KEY) return item
    const parsed = parseJson<Partial<LocalWritingSettings>>(item.value, {})
    return { key: item.key, value: JSON.stringify({ ...parsed, backupDir: current.backupDir }) }
  })

export const buildFullBackupFileName = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `易创全量备份-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`
}

export const parseFullBackupManifest = (raw: string): FullBackupManifest => {
  const manifest = parseJson<Partial<FullBackupManifest> | null>(raw, null)
  if (!manifest || manifest.format !== FULL_BACKUP_FORMAT) throw new Error('这不是易创的一键备份文件')
  if (Number(manifest.version) > FULL_BACKUP_VERSION) throw new Error('备份文件由更新版本的易创生成，请先升级应用再恢复')
  return manifest as FullBackupManifest
}

// ---------------------------------------------------------------------------
// 桌面端流程
// ---------------------------------------------------------------------------

export const isFullBackupSupported = () => isTauriRuntime()

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const getInvoke = async () => (await import('@tauri-apps/api/core')).invoke

const readAppVersion = async () => {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return ''
  }
}

const platformLabel = () => {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua)) return 'linux'
  return 'unknown'
}

export async function createFullBackup(
  targetPath: string,
  onProgress?: (text: string) => void
): Promise<FullBackupSummary> {
  const invoke = await getInvoke()
  const session = await invoke<string>('full_backup_begin')
  const add = async (entry: string, data: Uint8Array | string) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    await invoke('full_backup_add_entry', bytes, {
      headers: { 'x-ew-session': session, 'x-ew-entry': encodeURIComponent(entry) },
    })
  }
  try {
    onProgress?.('导出作品库…')
    const library = await getLocalLibraryStorage().exportAllRecords()
    await add('library.json', JSON.stringify(library))

    onProgress?.('导出正文与版本历史…')
    const writing = await getWritingStorage().exportAllRecords()
    await add('writing.json', JSON.stringify(writing))

    onProgress?.('导出配置与统计…')
    const localStorageSnapshot = snapshotLocalStorage()
    await add('local-storage.json', JSON.stringify(localStorageSnapshot))

    onProgress?.('导出字体…')
    const fonts: ImportedFont[] = []
    for (const font of await listImportedFonts()) {
      const data = await readImportedFontFile(font.id)
      if (!data) continue
      await add(`fonts/${font.id}`, new Uint8Array(data))
      fonts.push(font)
    }
    await add('fonts.json', JSON.stringify(fonts))

    const manifest: FullBackupManifest = {
      format: FULL_BACKUP_FORMAT,
      version: FULL_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: await readAppVersion(),
      platform: platformLabel(),
      counts: {
        groups: library.groups.length,
        books: library.books.filter(book => !book.deletedAt).length,
        volumes: library.volumes.length,
        chapters: library.chapters.filter(chapter => !chapter.deletedAt).length,
        drafts: writing.chapters.length,
        versions: writing.versions.length,
        fonts: fonts.length,
        localStorageKeys: Object.keys(localStorageSnapshot).length,
      },
    }
    await add('manifest.json', JSON.stringify(manifest, null, 2))

    onProgress?.('压缩打包…')
    return await invoke<FullBackupSummary>('full_backup_finish', { session, targetPath, includePrompts: true })
  } catch (error) {
    await invoke('full_restore_close', { session }).catch(() => undefined)
    throw error
  }
}

export async function openFullBackup(zipPath: string): Promise<FullBackupInspection> {
  const invoke = await getInvoke()
  const info = await invoke<{ session: string; manifest: string; entries: FullBackupEntry[] }>('full_restore_open', { zipPath })
  try {
    const manifest = parseFullBackupManifest(info.manifest)
    return {
      session: info.session,
      manifest,
      entries: info.entries,
      promptCount: info.entries.filter(entry => entry.path.startsWith('prompts/')).length,
    }
  } catch (error) {
    await invoke('full_restore_close', { session: info.session }).catch(() => undefined)
    throw error
  }
}

export async function closeFullBackup(session: string) {
  const invoke = await getInvoke()
  await invoke('full_restore_close', { session }).catch(() => undefined)
}

const readEntryBytes = async (session: string, path: string) => {
  const invoke = await getInvoke()
  const data = await invoke<ArrayBuffer | Uint8Array | number[]>('full_restore_read_entry', { session, path })
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}

const readEntryJson = async <T>(session: string, path: string, fallback: T) =>
  parseJson<T>(decoder.decode(await readEntryBytes(session, path)), fallback)

export async function applyFullBackup(
  inspection: FullBackupInspection,
  mode: FullRestoreMode,
  options: { safetyBackupPath?: string; onProgress?: (text: string) => void } = {}
): Promise<FullRestoreReport> {
  const { session } = inspection
  const onProgress = options.onProgress
  const invoke = await getInvoke()
  const library = getLocalLibraryStorage()
  const writing = getWritingStorage()

  let safetyBackupPath = ''
  if (mode === 'overwrite' && options.safetyBackupPath) {
    onProgress?.('恢复前先做一次安全备份…')
    safetyBackupPath = (await createFullBackup(options.safetyBackupPath)).path
  }

  onProgress?.('读取备份内容…')
  const emptyLibrary: LocalLibraryDump = { groups: [], books: [], volumes: [], chapters: [] }
  const emptyWriting: WritingStorageDump = { chapters: [], versions: [], settings: [] }
  let libraryDump = await readEntryJson<LocalLibraryDump>(session, 'library.json', emptyLibrary)
  let writingDump = await readEntryJson<WritingStorageDump>(session, 'writing.json', emptyWriting)
  const backupLocalStorage = await readEntryJson<Record<string, string>>(session, 'local-storage.json', {})
  const fonts = await readEntryJson<ImportedFont[]>(session, 'fonts.json', [])

  let remap = emptyIdRemap()
  if (mode === 'merge') {
    const existing = collectLibraryIds(await library.exportAllRecords())
    remap = planIdRemap(libraryDump, existing, createIdAllocator(existing))
    libraryDump = remapLibraryDump(libraryDump, remap)
    writingDump = remapWritingDump(writingDump, remap)
    // 书级字数缓存按 userId 分桶：备份里的桶要和本机同桶合并，本机值优先
    writingDump.settings = await Promise.all(
      writingDump.settings.map(async item => {
        if (!item.key.startsWith(BOOK_WORD_COUNT_PREFIX)) return item
        const current = await writing.getBookWordCounts(item.key.slice(BOOK_WORD_COUNT_PREFIX.length))
        return { key: item.key, value: JSON.stringify({ ...parseJson<Record<string, number>>(item.value, {}), ...current }) }
      })
    )
  }
  writingDump.settings = preserveMachineSettings(writingDump.settings, await writing.getLocalWritingSettings())

  onProgress?.(mode === 'overwrite' ? '写入作品库（覆盖）…' : '写入作品库（合并）…')
  await library.importAllRecords(libraryDump, { replace: mode === 'overwrite' })
  onProgress?.('写入正文与版本历史…')
  await writing.importAllRecords(writingDump, { replace: mode === 'overwrite' })

  onProgress?.('写入配置与统计…')
  const nextLocalStorage =
    mode === 'overwrite' ? backupLocalStorage : mergeLocalStorage(snapshotLocalStorage(), backupLocalStorage, remap)
  applyLocalStorageSnapshot(nextLocalStorage, mode)

  onProgress?.('写入字体…')
  if (mode === 'overwrite') await clearImportedFonts()
  const knownFonts = new Set(mode === 'merge' ? (await listImportedFonts()).map(font => font.id) : [])
  let fontCount = 0
  for (const font of fonts) {
    if (knownFonts.has(font.id)) continue
    const bytes = await readEntryBytes(session, `fonts/${font.id}`)
    await saveImportedFont(font, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    fontCount += 1
  }

  onProgress?.('写入提示词…')
  const prompts = await invoke<number>('full_restore_apply_prompts', { session, mode })

  await closeFullBackup(session)
  return {
    mode,
    books: libraryDump.books.filter(book => !book.deletedAt).length,
    chapters: libraryDump.chapters.filter(chapter => !chapter.deletedAt).length,
    versions: writingDump.versions.length,
    fonts: fontCount,
    prompts,
    safetyBackupPath,
  }
}
