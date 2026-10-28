import type { Settings } from '../../config/lib/schema'

export const settings: Settings = {
  app: {
    api: {
      base: '/api',
    },
    auth: {
      jwt: {
        expiresInDays: 14,
        renewBeforeDays: 7,
      },
      session: {
        maxAgeDays: 14,
        maxTokenGenerations: 8,
      },
      cookie: {
        maxAgeDays: 14,
        tokenName: 'stupig_session',
        userName: 'login',
      },
      bcryptRounds: 12,
    },
    otp: {
      expiresMinutes: 10,
      tier1: {
        dailyLimit: 5,
        cooldownMs: 60000,
      },
      tier2: {
        dailyLimit: 5,
        cooldownMs: 1800000,
      },
    },
    identity: {
      cookieName: 'stupig_identity',
      cookieMaxAgeDays: 30,
    },
    client: {
      colorMode: {
        fallback: 'dark',
        cookieName: 'stupig_color_mode',
      },
      timezone: {
        cookieName: 'stupig_timezone',
      },
      sync: {
        broadcastChannelName: 'stupig_sync_events',
        clientIdStorageKey: 'stupig_sync_client_id',
        eventDeduplicationLimit: 256,
        resourceGatherDelayMs: 200,
        reconnectDelayMs: 1000,
        connectTimeoutMs: 30000,
      },
    },
    online: {
      timeoutSeconds: 16,
      pingIdleIntervalSeconds: 4,
      pollIntervalSeconds: 4,
    },
    admin: {
      pollIntervalSeconds: 2,
    },
    avatar: {
      maxSizeMb: 1,
    },
    content: {
      story: {
        titleMaxLength: 60,
        labelMaxBytes: 255,
        descMaxBytes: 500,
        coverMaxBytes: 255,
        markdownMaxBytes: 1048576,
      },
      link: {
        fileNameMaxBytes: 255,
      },
      draft: {
        schemaVersion: 3,
        storagePrefix: 'stupig_content_draft_',
        autosaveDelayMs: 1000,
      },
      reference: {
        journalRetentionDays: 30,
        sweepIntervalSeconds: 60,
      },
      workspace: {
        batchLimit: 500,
        draftReferenceLimit: 10000,
        suffixAttempts: 10000,
        receiptHours: 24,
        sessionHours: 24,
        leaseSeconds: 120,
        heartbeatSeconds: 30,
        parallelUploads: 3,
      },
      name: {
        suffixSeparator: '_',
      },
      upload: {
        requestTimeoutSeconds: 120,
        handleStorageName: 'stupig_content_upload_handles',
        partSizeMb: 8,
        signBatchSize: 20,
        urlTtlSeconds: 900,
        maxSizeMb: 20480,
      },
      download: {
        urlTtlSeconds: 300,
      },
      read: {
        urlTtlSeconds: 3600,
      },
      redact: {
        maxDimension: 8192,
      },
      imageEditor: {
        maxPixels: 24000000,
        maxActions: 200,
        maxStrokePoints: 100000,
      },
      image: {
        lqipMaxBytes: 8192,
      },
      encrypt: {
        maxSizeMb: 20,
      },
    },
  },
  integrations: {
    mqtt: {
      qos: 1,
      topicPrefix: 'stupig/sync',
      clientIdPrefixServer: 'server',
      clientIdPrefixWeb: 'web',
      publishQueueSize: 100,
    },
  },
}
