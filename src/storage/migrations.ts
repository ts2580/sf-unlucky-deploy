import type { Database } from 'sqlite';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_auth_deployment_schema',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('VIEWER', 'OPERATOR', 'DEPLOYER', 'ADMIN')),
        disabled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (provider, subject)
      ) STRICT;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('VIEWER', 'OPERATOR', 'DEPLOYER', 'ADMIN')),
        token_hash TEXT NOT NULL UNIQUE,
        invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE registered_projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        real_path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE deployment_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('DRY_RUN', 'DEPLOY')),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED',
          'DRY_RUN_RUNNING',
          'APPROVAL_PENDING',
          'DEPLOYING',
          'SUCCEEDED',
          'FAILED',
          'RECONCILE_REQUIRED'
        )),
        source TEXT NOT NULL,
        target_alias TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        payload_checksum TEXT NOT NULL,
        run_directory TEXT,
        salesforce_deployment_id TEXT,
        dry_run_job_id TEXT REFERENCES deployment_jobs(id) ON DELETE RESTRICT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        CHECK (
          (kind = 'DRY_RUN' AND dry_run_job_id IS NULL)
          OR (kind = 'DEPLOY' AND dry_run_job_id IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE deployment_approvals (
        id TEXT PRIMARY KEY,
        dry_run_job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT UNIQUE,
        deploy_job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT UNIQUE,
        approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        payload_checksum TEXT NOT NULL,
        target_alias TEXT NOT NULL,
        approved_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_sessions_user_expires ON sessions(user_id, expires_at);
      CREATE INDEX idx_invitations_email_expires ON invitations(email, expires_at);
      CREATE INDEX idx_deployment_jobs_status_created ON deployment_jobs(status, created_at);
      CREATE INDEX idx_deployment_jobs_target_created ON deployment_jobs(target_alias, created_at);
      CREATE INDEX idx_audit_events_entity_created ON audit_events(entity_type, entity_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'local_password_authentication',
    sql: `
      CREATE TABLE password_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      ALTER TABLE sessions ADD COLUMN csrf_token_hash TEXT;
      CREATE UNIQUE INDEX idx_sessions_csrf_token_hash ON sessions(csrf_token_hash);
    `,
  },
  {
    version: 3,
    name: 'comparison_jobs',
    sql: `
      CREATE TABLE comparison_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
        project_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        left_source TEXT NOT NULL,
        right_source TEXT NOT NULL,
        strict INTEGER NOT NULL DEFAULT 0 CHECK (strict IN (0, 1)),
        show_identical INTEGER NOT NULL DEFAULT 0 CHECK (show_identical IN (0, 1)),
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        run_directory TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;

      CREATE INDEX idx_comparison_jobs_created ON comparison_jobs(created_at DESC);
      CREATE INDEX idx_comparison_jobs_status_created ON comparison_jobs(status, created_at);
    `,
  },
  {
    version: 4,
    name: 'dry_run_artifacts',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN is_prepared INTEGER NOT NULL DEFAULT 0 CHECK (is_prepared IN (0, 1));
      ALTER TABLE deployment_jobs ADD COLUMN comparison_result_json TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN test_plan_json TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN dry_run_result_json TEXT;
    `,
  },
  {
    version: 5,
    name: 'comparison_scope',
    sql: `
      ALTER TABLE comparison_jobs
      ADD COLUMN scope TEXT NOT NULL DEFAULT 'MANIFEST' CHECK (scope IN ('MANIFEST', 'ALL'));
    `,
  },
  {
    version: 6,
    name: 'comparison_metadata_type',
    sql: `
      ALTER TABLE comparison_jobs ADD COLUMN metadata_type TEXT;
    `,
  },
  {
    version: 7,
    name: 'deployment_scope',
    sql: `
      ALTER TABLE deployment_jobs
      ADD COLUMN scope TEXT NOT NULL DEFAULT 'MANIFEST' CHECK (scope IN ('MANIFEST', 'ALL'));
      ALTER TABLE deployment_jobs ADD COLUMN metadata_type TEXT;
    `,
  },
  {
    version: 8,
    name: 'selected_component_deployments',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN selected_components_json TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN deployment_result_json TEXT;
    `,
  },
  {
    version: 9,
    name: 'direct_deployments',
    sql: `
      PRAGMA defer_foreign_keys = ON;
      DROP INDEX idx_deployment_jobs_status_created;
      DROP INDEX idx_deployment_jobs_target_created;
      ALTER TABLE deployment_approvals RENAME TO deployment_approvals_legacy;
      ALTER TABLE deployment_jobs RENAME TO deployment_jobs_legacy;

      CREATE TABLE deployment_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('DRY_RUN', 'DEPLOY')),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED',
          'DRY_RUN_RUNNING',
          'APPROVAL_PENDING',
          'DEPLOYING',
          'SUCCEEDED',
          'FAILED',
          'RECONCILE_REQUIRED'
        )),
        source TEXT NOT NULL,
        target_alias TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        payload_checksum TEXT NOT NULL,
        run_directory TEXT,
        salesforce_deployment_id TEXT,
        dry_run_job_id TEXT REFERENCES deployment_jobs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        is_prepared INTEGER NOT NULL DEFAULT 0 CHECK (is_prepared IN (0, 1)),
        comparison_result_json TEXT,
        test_plan_json TEXT,
        dry_run_result_json TEXT,
        scope TEXT NOT NULL DEFAULT 'MANIFEST' CHECK (scope IN ('MANIFEST', 'ALL')),
        metadata_type TEXT,
        selected_components_json TEXT,
        deployment_result_json TEXT,
        CHECK (kind = 'DEPLOY' OR dry_run_job_id IS NULL)
      ) STRICT;

      INSERT INTO deployment_jobs (
        id, kind, status, source, target_alias, manifest_path, payload_checksum, run_directory,
        salesforce_deployment_id, dry_run_job_id, created_by, error_code, error_message,
        created_at, updated_at, started_at, completed_at, is_prepared, comparison_result_json,
        test_plan_json, dry_run_result_json, scope, metadata_type, selected_components_json,
        deployment_result_json
      )
      SELECT
        id, kind, status, source, target_alias, manifest_path, payload_checksum, run_directory,
        salesforce_deployment_id, dry_run_job_id, created_by, error_code, error_message,
        created_at, updated_at, started_at, completed_at, is_prepared, comparison_result_json,
        test_plan_json, dry_run_result_json, scope, metadata_type, selected_components_json,
        deployment_result_json
      FROM deployment_jobs_legacy;

      CREATE TABLE deployment_approvals (
        id TEXT PRIMARY KEY,
        dry_run_job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT UNIQUE,
        deploy_job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT UNIQUE,
        approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        payload_checksum TEXT NOT NULL,
        target_alias TEXT NOT NULL,
        approved_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO deployment_approvals
      SELECT * FROM deployment_approvals_legacy;
      DROP TABLE deployment_approvals_legacy;
      DROP TABLE deployment_jobs_legacy;

      CREATE INDEX idx_deployment_jobs_status_created ON deployment_jobs(status, created_at);
      CREATE INDEX idx_deployment_jobs_target_created ON deployment_jobs(target_alias, created_at);
    `,
  },
  {
    version: 10,
    name: 'salesforce_deployment_progress',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN progress_json TEXT;
    `,
  },
  {
    version: 11,
    name: 'user_test_class_suffix',
    sql: `
      CREATE TABLE user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        test_class_suffix TEXT NOT NULL DEFAULT '_Test',
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

export async function applyMigrations(
  database: Database,
  now: () => string,
  maximumVersion = Number.POSITIVE_INFINITY,
): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedVersions = new Set(
    (await database.all<{ version: number }[]>('SELECT version FROM schema_migrations'))
      .map((row) => row.version),
  );

  for (const migration of MIGRATIONS.filter((entry) => entry.version <= maximumVersion)) {
    if (!appliedVersions.has(migration.version)) {
      await database.exec('BEGIN IMMEDIATE');
      try {
        await database.exec(migration.sql);
        await database.run(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          migration.version,
          migration.name,
          now(),
        );
        await database.exec('COMMIT');
      } catch (error) {
        await database.exec('ROLLBACK');
        throw error;
      }
    }
  }
}
