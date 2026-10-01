import type { Rule } from 'eslint'
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import plugin from './eslint.local-rules.mjs'

const rule = plugin.rules['no-extensionless-package-subpath'] as Rule.RuleModule

// RuleTester delegates to the test framework's describe/it; point it at Vitest.
RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
})

tester.run('no-extensionless-package-subpath', rule, {
  valid: [
    // Package root import (no subpath) is out of scope.
    `import dayjs from 'dayjs'`,
    // Explicit file extension resolves under Node ESM.
    `import utc from 'dayjs/plugin/utc.js'`,
    // Package has an exports field, so the subpath is mapped by Node ESM.
    `import mysql from 'mysql2/promise'`,
    `import { initTRPC } from '@trpc/server'`,
    // Aliases and relative imports are resolved by other tooling.
    `import { env } from '@shared/env'`,
    `import { helper } from './helper'`,
  ],
  invalid: [
    {
      // dayjs has no exports field, so this extensionless subpath fails in Node ESM.
      code: `import utc from 'dayjs/plugin/utc'`,
      errors: [{ messageId: 'extensionless' }],
    },
  ],
})
