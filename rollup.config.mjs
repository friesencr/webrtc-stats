import { createRequire } from 'node:module'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import typescript from '@rollup/plugin-typescript'
import babel from '@rollup/plugin-babel'
import terser from '@rollup/plugin-terser'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')
const babelConfig = require('./.babelrc.json')

const plugins = [
  nodeResolve({
    browser: true,
    preferBuiltins: false
  }),
  commonjs(),
  typescript({
    compilerOptions: {
      rootDir: 'src',
      // Must match Rollup output dir (see @rollup/plugin-typescript validatePaths)
      outDir: 'dist',
      declaration: false,
      noEmit: false
    }
  }),
  babel({
    ...babelConfig,
    babelHelpers: 'bundled',
    extensions: ['.ts', '.js'],
    exclude: 'node_modules/**'
  })
]

export default [{
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/browser.js',
      name: 'window',
      format: 'iife',
      extend: true
    },
    {
      file: 'dist/browser.min.js',
      format: 'iife',
      name: 'window',
      extend: true,
      plugins: [terser()]
    },
    {
      file: pkg.main,
      format: 'cjs'
    }
  ],
  plugins
}]
