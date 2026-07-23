import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = join(__dirname, 'node_modules', '@primeuix', 'mcp', 'dist', 'index.js')

let src = readFileSync(target, 'utf-8')

const oldFunc = 'function F(a,e,n){for(let c of n){let r={};for(let[l,t]of Object.entries(c.parameters))r[l]={type:t.type,description:t.description};a.tool(c.name,c.description,r,l=>m(null,null,function*(){return yield c.handler(e,l)}))}}'
const newFunc = 'function F(a,e,n){for(let c of n){let r={};for(let[l,t]of Object.entries(c.parameters)){let o=g.any();t.type==="string"?o=g.string():t.type==="number"?o=g.number():t.type==="boolean"?o=g.boolean():t.type==="array"?o=g.array(g.any()):t.type==="object"&&(o=g.object({}));t.description&&(o=o.describe(t.description));r[l]=o}a.tool(c.name,c.description,r,l=>m(null,null,function*(){return yield c.handler(e,l)}))}}'

if (! src.includes(oldFunc)) {
  if (src.includes(newFunc)) {
    console.error('patch.js: already patched')
    process.exit(0)
  }
  console.error('patch.js: expected original F function not found, cannot patch')
  process.exit(1)
}

src = src.replace(oldFunc, newFunc)
writeFileSync(target, src, 'utf-8')
console.error('patch.js: patched @primeuix/mcp')
