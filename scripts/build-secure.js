// =============================================================
//  Sonar — secure build
//  Compiles the enforcement-critical modules to V8 bytecode (.jsc)
//  so the licensing logic + session-hold enforcement can't be read
//  or patched in plain text.
//
//  Usage:  npm run build:secure
//  Then for a PRODUCTION deploy, delete the matching .js sources
//  (keep the .jsc) so require() resolves the bytecode. Keep the .js
//  in your own source control. .jsc is tied to the Node major version
//  used to build it — build on the same Node version you deploy with.
// =============================================================
const path = require('path')
const fs = require('fs')
const bytenode = require('bytenode')

const SRC = path.join(__dirname, '..', 'src')
// Modules that decide and enforce licensing. Compiling these defeats
// casual source-patching of the license gate.
const MODULES = ['license', 'sessionManager']

for (const m of MODULES) {
  const input = path.join(SRC, m + '.js')
  const output = path.join(SRC, m + '.jsc')
  if (!fs.existsSync(input)) { console.log('skip (no source):', m); continue }
  bytenode.compileFile({ filename: input, output, compileAsModule: true })
  const kb = (fs.statSync(output).size / 1024).toFixed(1)
  console.log(`compiled  src/${m}.js  ->  src/${m}.jsc  (${kb} KB)`)
}
console.log('\nDone. For production: delete the compiled modules\' .js files (keep .jsc).')
console.log('require() prefers .js when present (dev) and falls back to .jsc (prod).')
