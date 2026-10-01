import { readFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const BUILTINS = new Set(builtinModules.flatMap(module => [module, `node:${module}`]))

// Alias prefixes/specifiers that are resolved by Nuxt/Vite, not by Node ESM.
const ALIASES = ['@/', '@server', '@shared', '~', '~~', '~server']

function is_alias(specifier) {
  return ALIASES.some(alias => specifier === alias || specifier.startsWith(`${alias}/`))
}

// Read a bare package's package.json via the project's node_modules, or null
// when it cannot be resolved (not a dependency, or its exports map forbids
// exposing package.json — either way another layer already has an opinion).
function read_package_json(package_name) {
  try {
    const path = require.resolve(`${package_name}/package.json`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return null
  }
}

export default {
  rules: {
    'no-extensionless-package-subpath': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow extensionless subpath imports of packages without an exports field, which fail in Node ESM at runtime (e.g. dayjs/plugin/utc).',
        },
        schema: [],
        messages: {
          extensionless:
            'Extensionless subpath import "{{specifier}}" targets "{{packageName}}", which has no exports field; add the file extension (e.g. .js) so it resolves under Node ESM.',
        },
      },
      create(context) {
        function check(source) {
          if (! source || typeof source.value !== 'string')
            return

          const specifier = source.value
          if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#'))
            return
          if (BUILTINS.has(specifier) || is_alias(specifier))
            return

          const segments = specifier.split('/')
          const package_name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
          const subpath = specifier.slice(package_name.length)

          // Package root import, or the subpath already carries a file extension.
          if (! subpath || /\.[a-z0-9]+$/i.test(subpath))
            return

          const pkg = read_package_json(package_name)
          if (! pkg || pkg.exports != null)
            return

          context.report({
            node: source,
            messageId: 'extensionless',
            data: { specifier, packageName: package_name },
          })
        }

        return {
          ImportDeclaration(node) {
            if (node.importKind !== 'type')
              check(node.source)
          },
          ExportNamedDeclaration(node) {
            if (node.exportKind !== 'type' && node.source)
              check(node.source)
          },
          ExportAllDeclaration(node) {
            if (node.exportKind !== 'type' && node.source)
              check(node.source)
          },
          ImportExpression(node) {
            check(node.source)
          },
        }
      },
    },
  },
}
