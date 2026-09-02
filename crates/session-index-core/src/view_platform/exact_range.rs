use std::collections::BTreeMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Transaction, params, params_from_iter};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    CompiledView, HandlerQueryResult, ViewAccessManifestV1, ViewAuthorityV1, ViewError,
    ViewManifestV1, checked_optional_text, checked_scope_token, checked_text, invalid_mutation,
    invalid_query, parse_row,
};

static ACCESSES: &[ViewAccessManifestV1] = &[ViewAccessManifestV1 {
    name: "exact-range",
    maximum_results: 32,
    maximum_work_units: 32,
    authorization: "workspace-token-set/v1:pre-result",
}];

pub static MANIFEST: ViewManifestV1 = ViewManifestV1 {
    id: "qq.test.exact-range",
    version: 1,
    digest: "sha256:528222f54ca28386148f2a2f0d3443a1f1078ac615dd5fc584e2e63eaec2e365",
    build_id: "exact-range-v1-physical-1",
    source_contract: "generated-test-source/v1",
    source_state_version: "generated-exact-range-projection-v1",
    partition_key: "bucket",
    row_schema: "generated-exact-range-row-v1",
    authorization_contract: "workspace-token-set/v1",
    maximum_partition_rows: 1_024,
    maximum_partition_bytes: 900 * 1_024,
    physical_schema: "generated-exact-range-sqlite-v1",
    test_only: true,
    accesses: ACCESSES,
};

pub(super) struct ExactRangeView;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactRangeRow {
    row_key: String,
    exact_key: String,
    ordinal: i64,
    workspace_scope_token: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactRangeParams {
    exact_key: String,
    minimum: i64,
    maximum: i64,
    limit: usize,
}

impl CompiledView for ExactRangeView {
    fn manifest(&self) -> &'static ViewManifestV1 {
        &MANIFEST
    }

    fn create_schema(&self, transaction: &Transaction<'_>) -> Result<(), ViewError> {
        transaction.execute_batch(
            "CREATE TABLE exact_range_rows (
                row_key TEXT PRIMARY KEY,
                partition_key TEXT NOT NULL REFERENCES view_partitions(partition_key) ON DELETE CASCADE,
                exact_key TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                workspace_scope_token TEXT NOT NULL,
                value TEXT NOT NULL
             ) STRICT;
             CREATE INDEX exact_range_access ON exact_range_rows(workspace_scope_token, exact_key, ordinal, row_key);",
        )?;
        Ok(())
    }

    fn validate_schema(&self, connection: &Connection) -> Result<(), ViewError> {
        for name in ["exact_range_rows", "exact_range_access"] {
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                [name],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(ViewError::InvalidStorage(format!(
                    "exact-range schema missing {name}"
                )));
            }
        }
        Ok(())
    }

    fn replace_partition(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
        rows: &[Value],
    ) -> Result<usize, ViewError> {
        ensure_provisional_partition(transaction, partition_key)?;
        transaction.execute(
            "DELETE FROM exact_range_rows WHERE partition_key = ?1",
            [partition_key],
        )?;
        for row in rows {
            insert_row(transaction, partition_key, row)?;
        }
        Ok(rows.len())
    }

    fn apply_delta(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
        upserts: &[Value],
        deletes: &[String],
    ) -> Result<usize, ViewError> {
        for row_key in deletes {
            transaction.execute(
                "DELETE FROM exact_range_rows WHERE row_key = ?1 AND partition_key = ?2",
                params![row_key, partition_key],
            )?;
        }
        for row in upserts {
            insert_row(transaction, partition_key, row)?;
        }
        Ok(upserts.len() + deletes.len())
    }

    fn delete_partition(
        &self,
        transaction: &Transaction<'_>,
        partition_key: &str,
    ) -> Result<usize, ViewError> {
        Ok(transaction.execute(
            "DELETE FROM exact_range_rows WHERE partition_key = ?1",
            [partition_key],
        )?)
    }

    fn execute(
        &self,
        connection: &Connection,
        access: &str,
        params: &Value,
        authority: &ViewAuthorityV1,
    ) -> Result<HandlerQueryResult, ViewError> {
        if access != "exact-range" {
            return Err(ViewError::UnsupportedAccess {
                id: MANIFEST.id.to_owned(),
                version: MANIFEST.version,
                access: access.to_owned(),
            });
        }
        let params: ExactRangeParams = serde_json::from_value(params.clone())
            .map_err(|error| invalid_query(error.to_string()))?;
        checked_query_text(&params.exact_key)?;
        if params.minimum > params.maximum {
            return Err(invalid_query("minimum must not exceed maximum"));
        }
        if params.limit == 0 || params.limit > 32 {
            return Err(invalid_query("limit must be 1..=32"));
        }
        let mut sql = String::from(
            "SELECT row_key, ordinal, value FROM exact_range_rows
             WHERE workspace_scope_token IN (",
        );
        let mut bindings = Vec::new();
        for (index, token) in authority.scope_tokens.iter().enumerate() {
            if index != 0 {
                sql.push(',');
            }
            sql.push('?');
            bindings.push(SqlValue::Text(token.clone()));
        }
        sql.push_str(") AND exact_key = ? AND ordinal >= ? AND ordinal <= ? ORDER BY ordinal, row_key LIMIT ?");
        bindings.push(SqlValue::Text(params.exact_key));
        bindings.push(SqlValue::Integer(params.minimum));
        bindings.push(SqlValue::Integer(params.maximum));
        bindings.push(SqlValue::Integer(params.limit as i64));
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(bindings.iter()), |row| Ok(json!({
            "rowKey": row.get::<_, String>(0)?, "ordinal": row.get::<_, i64>(1)?, "value": row.get::<_, String>(2)?,
        })))?.collect::<Result<Vec<_>, _>>()?;
        let mut counts = BTreeMap::new();
        counts.insert("results".to_owned(), rows.len() as u64);
        Ok(HandlerQueryResult {
            value: json!({ "rows": rows }),
            counts,
        })
    }
}

fn ensure_provisional_partition(
    transaction: &Transaction<'_>,
    partition_key: &str,
) -> Result<(), ViewError> {
    transaction.execute(
        "INSERT INTO view_partitions(partition_key, source_identity, durable_revision, next_cursor, generation)
         VALUES (?1, 'provisional', 'provisional', 0, 0) ON CONFLICT(partition_key) DO NOTHING", [partition_key],
    )?;
    Ok(())
}

fn insert_row(
    transaction: &Transaction<'_>,
    partition_key: &str,
    value: &Value,
) -> Result<(), ViewError> {
    let row: ExactRangeRow = parse_row(value)?;
    checked_text(&row.row_key, "rowKey", 256)?;
    checked_text(&row.exact_key, "exactKey", 256)?;
    checked_scope_token(&row.workspace_scope_token)?;
    checked_optional_text(&row.value, "value", 4_096)?;
    let changed = transaction.execute(
        "INSERT INTO exact_range_rows(row_key, partition_key, exact_key, ordinal, workspace_scope_token, value)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(row_key) DO UPDATE SET exact_key=excluded.exact_key,
           ordinal=excluded.ordinal, workspace_scope_token=excluded.workspace_scope_token, value=excluded.value
         WHERE exact_range_rows.partition_key = excluded.partition_key",
        params![row.row_key, partition_key, row.exact_key, row.ordinal, row.workspace_scope_token, row.value],
    ).map_err(|error| match error {
        rusqlite::Error::SqliteFailure(_, _) => invalid_mutation("exact-range row key conflicts with another partition"),
        other => ViewError::Sqlite(other),
    })?;
    if changed != 1 {
        return Err(invalid_mutation(
            "exact-range row key conflicts with another partition",
        ));
    }
    Ok(())
}

fn checked_query_text(value: &str) -> Result<(), ViewError> {
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(invalid_query(
            "exactKey must contain 1..=256 bytes and no NUL",
        ));
    }
    Ok(())
}
