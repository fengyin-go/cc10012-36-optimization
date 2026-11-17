// 通过 --import 预加载，把 alias-loader 注册成自定义解析钩子。
import { register } from 'node:module'

register('./alias-loader.mjs', import.meta.url)
