import type { ImportedFont } from '@/types/imported-font'

const DB_NAME = 'ew-font-store'
const METADATA = 'metadata'
const FILES = 'files'

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => {
    const db = request.result
    db.createObjectStore(METADATA, { keyPath: 'id' })
    db.createObjectStore(FILES)
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

async function read<T>(storeName: string, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly')
      const request = run(tx.objectStore(storeName))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error || new Error('读取字体失败'))
      tx.onerror = () => reject(tx.error || new Error('读取字体失败'))
    })
  } finally {
    db.close()
  }
}

// 启动时只读名称；字体二进制在选用时加载，避免所有字体同时占用内存。
export const listImportedFonts = () => read<ImportedFont[]>(METADATA, (store) => store.getAll())
export const readImportedFontFile = (id: string) => read<ArrayBuffer | undefined>(FILES, (store) => store.get(id))

export async function saveImportedFont(font: ImportedFont, data: ArrayBuffer): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      // 名称和文件必须一起提交，事务完成后才向界面报告成功。
      const tx = db.transaction([METADATA, FILES], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error || new Error('字体保存失败'))
      tx.onerror = () => reject(tx.error || new Error('字体保存失败'))
      try {
        tx.objectStore(METADATA).put(font)
        tx.objectStore(FILES).put(data, font.id)
      } catch (error) {
        tx.abort()
        reject(error)
      }
    })
  } finally {
    db.close()
  }
}

/** 一键恢复（覆盖模式）用：清空全部已导入字体 */
export async function clearImportedFonts(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([METADATA, FILES], 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error || new Error('清空字体失败'))
      tx.onerror = () => reject(tx.error || new Error('清空字体失败'))
      tx.objectStore(METADATA).clear()
      tx.objectStore(FILES).clear()
    })
  } finally {
    db.close()
  }
}
