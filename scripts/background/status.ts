export {}

process.env.NODE_ENV ??= 'development'
const { get_background_status } = await import('@server/services/background/status.service')
const { db } = await import('@server/lib/db')
try {
  console.log(JSON.stringify(await get_background_status(), null, 2))
  if (process.argv.includes('--storage-findings')) {
    const { get_storage_audit_findings } = await import('@server/services/storage-audit/service')
    console.log(JSON.stringify({ storage_audit_findings: await get_storage_audit_findings({ after_id: 0, limit: 100 }) }, null, 2))
  }
}
catch {
  console.error('background_status_failed')
  process.exitCode = 1
}
finally { await db.end() }
