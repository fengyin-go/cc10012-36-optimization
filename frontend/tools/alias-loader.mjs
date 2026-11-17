// 仅用于 Node 直跑 TS 时解析源码里的 "@/" 别名与扩展less相对导入，不参与前端构建。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function resolveWithExt(base) {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  if (fs.existsSync(`${base}.ts`)) return `${base}.ts`
  const indexFile = path.join(base, 'index.ts')
  if (fs.existsSync(indexFile)) return indexFile
  return `${base}.ts`
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const file = resolveWithExt(path.resolve(process.cwd(), 'src', specifier.slice(2)))
    return { url: pathToFileURL(file).href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && context.parentURL) {
    const base = fileURLToPath(new URL(specifier, context.parentURL))
    const file = resolveWithExt(base)
    return { url: pathToFileURL(file).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
