use std::ffi::OsString;
use std::path::PathBuf;

use crate::{DatabaseMode, ServerConfig};

pub const USAGE: &str = "Usage: qq-session-indexd --socket <absolute-path> --database <absolute-path> (--create | --open)";

pub fn parse_config(arguments: Vec<OsString>) -> Result<ServerConfig, String> {
    let mut socket_path = None;
    let mut database_path = None;
    let mut database_mode = None;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--socket") => set_path(
                "--socket",
                &mut socket_path,
                arguments.next().ok_or("--socket requires a path")?,
            )?,
            Some("--database") => set_path(
                "--database",
                &mut database_path,
                arguments.next().ok_or("--database requires a path")?,
            )?,
            Some("--create") => set_mode(&mut database_mode, DatabaseMode::Create)?,
            Some("--open") => set_mode(&mut database_mode, DatabaseMode::Open)?,
            _ => return Err(format!("unexpected argument {argument:?}")),
        }
    }
    Ok(ServerConfig {
        socket_path: socket_path.ok_or("--socket is required")?,
        database_path: database_path.ok_or("--database is required")?,
        database_mode: database_mode.ok_or("exactly one of --create or --open is required")?,
    })
}

fn set_path(name: &str, target: &mut Option<PathBuf>, value: OsString) -> Result<(), String> {
    if target.replace(PathBuf::from(value)).is_some() {
        return Err(format!("{name} may be supplied only once"));
    }
    Ok(())
}

fn set_mode(target: &mut Option<DatabaseMode>, value: DatabaseMode) -> Result<(), String> {
    if target.replace(value).is_some() {
        return Err("exactly one of --create or --open may be supplied".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn explicit_create_or_open_is_required() {
        assert!(parse_config(args(&["--socket", "/x", "--database", "/y"])).is_err());
        assert!(
            parse_config(args(&[
                "--socket",
                "/x",
                "--database",
                "/y",
                "--create",
                "--open"
            ]))
            .is_err()
        );
        assert_eq!(
            parse_config(args(&["--socket", "/x", "--database", "/y", "--create"]))
                .expect("valid create")
                .database_mode,
            DatabaseMode::Create
        );
    }
}
