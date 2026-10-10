import type { Rule } from 'eslint'
import { ESLint, RuleTester } from 'eslint'
import { describe, expect, it } from 'vitest'
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

describe('yaml configuration formatting', () => {
  it('requires block containers and a final newline', async () => {
    const source = 'app: { modes: [light, dark] }'
    const [result] = await new ESLint({ fix: false }).lintText(source, { filePath: 'config/formatting-fixture.yaml' })
    expect(result?.messages.map(message => message.ruleId)).toEqual(expect.arrayContaining([
      'yaml/block-mapping',
      'yaml/block-sequence',
      'style/eol-last',
    ]))
    const [fixed] = await new ESLint({ fix: true }).lintText(source, { filePath: 'config/formatting-fixture.yaml' })
    expect(fixed?.errorCount).toBe(0)
    expect(fixed?.output).toBe('app:\n  modes:\n    - light\n    - dark\n')
  })
})
