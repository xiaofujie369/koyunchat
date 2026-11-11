import { api } from './api'
import type { Attachment } from './types'

// 大照片上传前压缩（GIF 和小图不动）
function compressImage(file: File): Promise<File> {
  return new Promise(resolve => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return resolve(file)
    const img = new Image(), url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const k = Math.min(1, 1920 / Math.max(img.width, img.height))
      if (k === 1 && file.size < 1.5 * 1024 * 1024) return resolve(file)
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => resolve(b && b.size < file.size ? new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.85)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}
export async function uploadFile(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error('文件不能超过 20MB')
  const fd = new FormData(); fd.append('file', await compressImage(file))
  return api<Attachment>('POST', '/api/upload', fd)
}
