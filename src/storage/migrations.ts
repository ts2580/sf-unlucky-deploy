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
  {
    version: 12,
    name: 'deployment_remote_state',
    sql: `
      ALTER TABLE deployment_jobs
      ADD COLUMN remote_status TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'
      CHECK (remote_status IN ('NOT_SUBMITTED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'));
      ALTER TABLE deployment_jobs ADD COLUMN persistence_warning TEXT;
    `,
  },
  {
    version: 13,
    name: 'direct_deployment_idempotency',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN client_request_id TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN request_hash TEXT;
      CREATE UNIQUE INDEX idx_deployment_jobs_direct_request
      ON deployment_jobs(created_by, client_request_id)
      WHERE kind = 'DEPLOY' AND dry_run_job_id IS NULL AND client_request_id IS NOT NULL;
    `,
  },
  {
    version: 14,
    name: 'deployment_org_identity',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN source_org_identity_json TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN target_org_identity_json TEXT;
    `,
  },
  {
    version: 15,
    name: 'job_summary_columns',
    sql: `
      ALTER TABLE comparison_jobs ADD COLUMN summary_added INTEGER;
      ALTER TABLE comparison_jobs ADD COLUMN summary_removed INTEGER;
      ALTER TABLE comparison_jobs ADD COLUMN summary_modified INTEGER;
      ALTER TABLE comparison_jobs ADD COLUMN summary_identical INTEGER;
      ALTER TABLE comparison_jobs ADD COLUMN summary_total INTEGER;
      ALTER TABLE comparison_jobs ADD COLUMN summary_different INTEGER;

      UPDATE comparison_jobs SET
        summary_added = CAST(json_extract(result_json, '$.summary.added') AS INTEGER),
        summary_removed = CAST(json_extract(result_json, '$.summary.removed') AS INTEGER),
        summary_modified = CAST(json_extract(result_json, '$.summary.modified') AS INTEGER),
        summary_identical = CAST(json_extract(result_json, '$.summary.identical') AS INTEGER),
        summary_total = CAST(json_extract(result_json, '$.summary.total') AS INTEGER),
        summary_different = CAST(json_extract(result_json, '$.summary.different') AS INTEGER)
      WHERE result_json IS NOT NULL AND json_valid(result_json);

      ALTER TABLE deployment_jobs ADD COLUMN summary_added INTEGER;
      ALTER TABLE deployment_jobs ADD COLUMN summary_removed INTEGER;
      ALTER TABLE deployment_jobs ADD COLUMN summary_modified INTEGER;
      ALTER TABLE deployment_jobs ADD COLUMN summary_identical INTEGER;
      ALTER TABLE deployment_jobs ADD COLUMN summary_total INTEGER;
      ALTER TABLE deployment_jobs ADD COLUMN summary_different INTEGER;

      UPDATE deployment_jobs SET
        summary_added = CAST(json_extract(comparison_result_json, '$.summary.added') AS INTEGER),
        summary_removed = CAST(json_extract(comparison_result_json, '$.summary.removed') AS INTEGER),
        summary_modified = CAST(json_extract(comparison_result_json, '$.summary.modified') AS INTEGER),
        summary_identical = CAST(json_extract(comparison_result_json, '$.summary.identical') AS INTEGER),
        summary_total = CAST(json_extract(comparison_result_json, '$.summary.total') AS INTEGER),
        summary_different = CAST(json_extract(comparison_result_json, '$.summary.different') AS INTEGER)
      WHERE comparison_result_json IS NOT NULL AND json_valid(comparison_result_json);
    `,
  },
  {
    version: 16,
    name: 'compressed_job_artifacts',
    sql: `
      ALTER TABLE comparison_jobs ADD COLUMN result_artifact_path TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN comparison_artifact_path TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN dry_run_artifact_path TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN deployment_artifact_path TEXT;
    `,
  },
  {
    version: 17,
    name: 'deployment_test_coverage_summary',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN test_coverage REAL
      CHECK (test_coverage IS NULL OR (test_coverage >= 0 AND test_coverage <= 100));
    `,
  },
  {
    version: 18,
    name: 'dry_run_idempotency',
    sql: `
      CREATE UNIQUE INDEX idx_deployment_jobs_dry_run_request
      ON deployment_jobs(created_by, client_request_id)
      WHERE kind = 'DRY_RUN' AND client_request_id IS NOT NULL;
    `,
  },
  {
    version: 19,
    name: 'private_source_job_access',
    sql: `
      ALTER TABLE comparison_jobs ADD COLUMN access_owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
      ALTER TABLE deployment_jobs ADD COLUMN access_owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
      CREATE TABLE job_access_grants (
        job_type TEXT NOT NULL CHECK (job_type IN ('comparison', 'deployment')),
        job_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL CHECK (permission IN ('READ', 'EXECUTE')),
        granted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_type, job_id, user_id)
      ) STRICT;
      CREATE INDEX idx_job_access_grants_user ON job_access_grants(user_id, job_type, job_id);
    `,
  },
  {
    version: 20,
    name: 'encrypted_user_git_connections',
    sql: `
      CREATE TABLE git_connections (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
        provider_host TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        encrypted_access_token TEXT,
        encrypted_refresh_token TEXT,
        expires_at TEXT,
        granted_permissions_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REAUTH_REQUIRED', 'REVOKED')),
        key_version INTEGER NOT NULL CHECK (key_version > 0),
        token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((provider = 'github' AND provider_host = 'github.com')
          OR (provider = 'gitlab' AND provider_host = 'gitlab.com')
          OR (provider = 'bitbucket' AND provider_host = 'bitbucket.org')),
        CHECK ((status = 'ACTIVE' AND encrypted_access_token IS NOT NULL)
          OR (status <> 'ACTIVE' AND encrypted_access_token IS NULL AND encrypted_refresh_token IS NULL)),
        UNIQUE (owner_user_id, provider, provider_host, provider_account_id)
      ) STRICT;
      CREATE INDEX idx_git_connections_owner ON git_connections(owner_user_id, status);
    `,
  },
  {
    version: 21,
    name: 'git_import_history_and_immutable_job_sources',
    sql: `
      CREATE TABLE git_imports (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        connection_id TEXT REFERENCES git_connections(id) ON DELETE SET NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
        repository_path TEXT NOT NULL,
        ref_kind TEXT NOT NULL CHECK (ref_kind IN ('branch', 'tag', 'commit')),
        ref_name TEXT NOT NULL,
        expected_commit_sha TEXT NOT NULL,
        project_root TEXT,
        status TEXT NOT NULL CHECK (status IN ('QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING', 'READY', 'FAILED', 'CANCELLED', 'EXPIRED', 'DELETED')),
        project_roots_json TEXT NOT NULL DEFAULT '[]',
        source_provenance_json TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        safe_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_git_imports_owner ON git_imports(owner_user_id, created_at);
      ALTER TABLE comparison_jobs ADD COLUMN source_provenance_json TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN source_provenance_json TEXT;
    `,
  },
  {
    version: 22,
    name: 'session_bound_git_oauth_transactions',
    sql: `
      CREATE TABLE git_oauth_transactions (
        id TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        initiating_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        browser_binding_hash TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
        encrypted_pkce_verifier TEXT,
        callback_uri TEXT NOT NULL,
        fixed_return_path TEXT NOT NULL CHECK (fixed_return_path = '/settings'),
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('STARTED', 'EXCHANGING', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED')),
        encrypted_pending_credential TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_git_oauth_owner ON git_oauth_transactions(owner_user_id, status, expires_at);
    `,
  },
  {
    version: 23,
    name: 'git_personal_token_credentials',
    sql: `
      ALTER TABLE git_connections ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'oauth'
        CHECK (credential_type IN ('oauth', 'token'));
      ALTER TABLE git_connections ADD COLUMN encrypted_api_username TEXT;
      UPDATE git_connections SET encrypted_access_token = NULL, encrypted_refresh_token = NULL,
        expires_at = NULL, status = 'REAUTH_REQUIRED', token_version = token_version + 1
        WHERE status <> 'REVOKED';
      DELETE FROM git_oauth_transactions;
    `,
  },
  {
    version: 24,
    name: 'git_token_secret_salt',
    sql: `
      CREATE TABLE git_token_key_parameters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 25,
    name: 'git_repository_bound_credentials',
    sql: 'ALTER TABLE git_connections ADD COLUMN repository_path TEXT;',
  },
  {
    version: 26,
    name: 'git_import_metadata_scope',
    sql: 'ALTER TABLE git_imports ADD COLUMN metadata_type TEXT;',
  },
  {
    version: 27,
    name: 'git_registered_branches',
    sql: `CREATE TABLE git_registrations (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id),
      request_json TEXT NOT NULL, repository_id TEXT NOT NULL, status TEXT NOT NULL,
      last_commit_sha TEXT, last_synced_at TEXT, error_message TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_git_registrations_owner ON git_registrations(owner_user_id);`,
  },
  {
    version: 28,
    name: 'user_comparison_file_limit',
    sql: `ALTER TABLE user_settings ADD COLUMN maximum_comparison_files INTEGER NOT NULL DEFAULT 2000
      CHECK (maximum_comparison_files BETWEEN 1 AND 50000);
      ALTER TABLE comparison_jobs ADD COLUMN comparison_limit_json TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN comparison_limit_json TEXT;`,
  },
  {
    version: 29,
    name: 'deployment_submission_attempts',
    sql: `
      PRAGMA defer_foreign_keys = ON;
      DROP INDEX idx_deployment_jobs_status_created;
      DROP INDEX idx_deployment_jobs_target_created;
      DROP INDEX idx_deployment_jobs_direct_request;
      DROP INDEX idx_deployment_jobs_dry_run_request;
      ALTER TABLE deployment_approvals RENAME TO deployment_approvals_legacy;
      ALTER TABLE deployment_jobs RENAME TO deployment_jobs_legacy;
      CREATE TABLE deployment_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('DRY_RUN', 'DEPLOY')),
        status TEXT NOT NULL CHECK (status IN (
          'QUEUED',
          'DRY_RUN_RUNNING',
          'APPROVAL_PENDING',
          'VALIDATED_PENDING_EXECUTION',
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
        deployment_result_json TEXT, progress_json TEXT, remote_status TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'
      CHECK (remote_status IN ('NOT_SUBMITTED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')), persistence_warning TEXT, client_request_id TEXT, request_hash TEXT, source_org_identity_json TEXT, target_org_identity_json TEXT, summary_added INTEGER, summary_removed INTEGER, summary_modified INTEGER, summary_identical INTEGER, summary_total INTEGER, summary_different INTEGER, comparison_artifact_path TEXT, dry_run_artifact_path TEXT, deployment_artifact_path TEXT, test_coverage REAL
      CHECK (test_coverage IS NULL OR (test_coverage >= 0 AND test_coverage <= 100)), access_owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT, source_provenance_json TEXT, comparison_limit_json TEXT, active_attempt_id TEXT,
        CHECK (kind = 'DEPLOY' OR dry_run_job_id IS NULL)
      ) STRICT;
      INSERT INTO deployment_jobs (id, kind, status, source, target_alias, manifest_path, payload_checksum, run_directory, salesforce_deployment_id, dry_run_job_id, created_by, error_code, error_message, created_at, updated_at, started_at, completed_at, is_prepared, comparison_result_json, test_plan_json, dry_run_result_json, scope, metadata_type, selected_components_json, deployment_result_json, progress_json, remote_status, persistence_warning, client_request_id, request_hash, source_org_identity_json, target_org_identity_json, summary_added, summary_removed, summary_modified, summary_identical, summary_total, summary_different, comparison_artifact_path, dry_run_artifact_path, deployment_artifact_path, test_coverage, access_owner_user_id, source_provenance_json, comparison_limit_json) SELECT id, kind, status, source, target_alias, manifest_path, payload_checksum, run_directory, salesforce_deployment_id, dry_run_job_id, created_by, error_code, error_message, created_at, updated_at, started_at, completed_at, is_prepared, comparison_result_json, test_plan_json, dry_run_result_json, scope, metadata_type, selected_components_json, deployment_result_json, progress_json, remote_status, persistence_warning, client_request_id, request_hash, source_org_identity_json, target_org_identity_json, summary_added, summary_removed, summary_modified, summary_identical, summary_total, summary_different, comparison_artifact_path, dry_run_artifact_path, deployment_artifact_path, test_coverage, access_owner_user_id, source_provenance_json, comparison_limit_json FROM deployment_jobs_legacy;
      CREATE TABLE deployment_approvals (
        id TEXT PRIMARY KEY,
        dry_run_job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT UNIQUE,
        deploy_job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT UNIQUE,
        approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        payload_checksum TEXT NOT NULL,
        target_alias TEXT NOT NULL,
        approved_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO deployment_approvals SELECT * FROM deployment_approvals_legacy;
      DROP TABLE deployment_approvals_legacy;
      DROP TABLE deployment_jobs_legacy;
      CREATE INDEX idx_deployment_jobs_status_created ON deployment_jobs(status, created_at);
      CREATE INDEX idx_deployment_jobs_target_created ON deployment_jobs(target_alias, created_at);
      CREATE UNIQUE INDEX idx_deployment_jobs_direct_request
      ON deployment_jobs(created_by, client_request_id)
      WHERE kind = 'DEPLOY' AND dry_run_job_id IS NULL AND client_request_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_deployment_jobs_dry_run_request
      ON deployment_jobs(created_by, client_request_id)
      WHERE kind = 'DRY_RUN' AND client_request_id IS NOT NULL;
      CREATE TABLE deployment_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL CHECK (operation IN ('VALIDATE', 'DEPLOY', 'QUICK_DEPLOY')),
        submission_state TEXT NOT NULL CHECK (submission_state IN ('NOT_SUBMITTED', 'SUBMITTING', 'SUBMITTED', 'TERMINAL')),
        validation_id TEXT,
        deployment_id TEXT,
        target_org_identity_json TEXT NOT NULL,
        payload_checksum TEXT NOT NULL,
        digest_version INTEGER NOT NULL,
        approval_job_id TEXT REFERENCES deployment_jobs(id) ON DELETE RESTRICT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        remote_status TEXT NOT NULL,
        report_json TEXT,
        persistence_warning TEXT,
        version INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX idx_deployment_attempts_job ON deployment_attempts(job_id, started_at);
    `,
  },
  {
    version: 30,
    name: 'deployment_execution_evidence_classification',
    sql: `
      ALTER TABLE deployment_jobs ADD COLUMN execution_evidence TEXT NOT NULL DEFAULT 'NOT_STARTED';
      UPDATE deployment_jobs SET execution_evidence = CASE
        WHEN salesforce_deployment_id IS NULL THEN 'LEGACY_NO_EXTERNAL_ID'
        WHEN kind = 'DRY_RUN' OR progress_json LIKE '%"phase":"DRY_RUN"%' THEN 'LEGACY_VALIDATION_ONLY'
        WHEN deployment_result_json IS NOT NULL THEN 'LEGACY_EXECUTION_REPORT_UNVERIFIED'
        ELSE 'LEGACY_UNVERIFIED'
      END;
    `,
  },
  {
    version: 31,
    name: 'deployment_payload_digest_version',
    sql: `ALTER TABLE deployment_jobs ADD COLUMN payload_digest_version INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    version: 32,
    name: 'deployment_execution_plan',
    sql: `ALTER TABLE deployment_jobs ADD COLUMN execution_mode TEXT
      CHECK (execution_mode IS NULL OR execution_mode IN ('QUICK_DEPLOY', 'STANDARD_DEPLOY', 'REVALIDATION_REQUIRED', 'RECONCILE_REQUIRED'));
      ALTER TABLE deployment_jobs ADD COLUMN reused_validation_id TEXT;
      ALTER TABLE deployment_jobs ADD COLUMN execution_reason TEXT;`,
  },
  {
    version: 33,
    name: 'deployment_admission_leases',
    sql: `CREATE TABLE deployment_admission_leases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_deployment_admission_leases_expiry ON deployment_admission_leases(expires_at);
    CREATE INDEX idx_deployment_admission_leases_user ON deployment_admission_leases(user_id, expires_at);`,
  },
  {
    version: 34,
    name: 'org_execution_access',
    sql: `CREATE TABLE org_execution_policies (
      target_alias TEXT PRIMARY KEY,
      enabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      enabled_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE org_execution_grants (
      target_alias TEXT NOT NULL REFERENCES org_execution_policies(target_alias) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      granted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (target_alias, user_id)
    ) STRICT;
    CREATE INDEX idx_org_execution_grants_user ON org_execution_grants(user_id, target_alias);`,
  },
  {
    version: 35,
    name: 'deployment_execution_leases',
    sql: `CREATE TABLE deployment_execution_leases (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_deployment_execution_leases_expiry ON deployment_execution_leases(expires_at);`,
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
