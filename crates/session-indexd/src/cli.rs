use std::ffi::OsString;
use std::path::PathBuf;

use crate::{DatabaseMode, ServerConfig};

pub const DEFAULT_READERS: usize = 4;
pub const DEFAULT_QUEUE_CAPACITY: usize = 64;
pub const MIN_READERS: usize = 1;
pub const MAX_READERS: usize = 16;
pub const MIN_QUEUE_CAPACITY: usize = 1;
pub const MAX_QUEUE_CAPACITY: usize = 1024;

pub const USAGE: &str = "Usage: qq-session-indexd --socket <absolute-path> --database <absolute-path> (--create | --open) [--readers <1..16>] [--queue-capacity <1..1024>]";

pub fn parse_config(arguments: Vec<OsString>) -> Result<ServerConfig, String> {
    let mut socket_path = None;
    let mut database_path = None;
    let mut database_mode = None;
    let mut readers = None;
    let mut queue_capacity = None;
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
            Some("--readers") => set_number(
                "--readers",
                &mut readers,
                arguments.next().ok_or("--readers requires a number")?,
                MIN_READERS,
                MAX_READERS,
            )?,
            Some("--queue-capacity") => set_number(
                "--queue-capacity",
                &mut queue_capacity,
                arguments
                    .next()
                    .ok_or("--queue-capacity requires a number")?,
                MIN_QUEUE_CAPACITY,
                MAX_QUEUE_CAPACITY,
            )?,
            _ => return Err(format!("unexpected argument {argument:?}")),
        }
    }
    Ok(ServerConfig {
        socket_path: socket_path.ok_or("--socket is required")?,
        database_path: database_path.ok_or("--database is required")?,
        database_mode: database_mode.ok_or("exactly one of --create or --open is required")?,
        readers: readers.unwrap_or(DEFAULT_READERS),
        queue_capacity: queue_capacity.unwrap_or(DEFAULT_QUEUE_CAPACITY),
    })
}

fn set_path(name: &str, target: &mut Option<PathBuf>, value: OsString) -> Result<(), String> {
    if target.replace(PathBuf::from(value)).is_some() {
        return Err(format!("{name} may be supplied only once"));
    }
    Ok(())
}

fn set_number(
    name: &str,
    target: &mut Option<usize>,
    value: OsString,
    minimum: usize,
    maximum: usize,
) -> Result<(), String> {
    if target.is_some() {
        return Err(format!("{name} may be supplied only once"));
    }
    let value = value
        .to_str()
        .ok_or_else(|| format!("{name} must be UTF-8"))?
        .parse::<usize>()
        .map_err(|_| format!("{name} must be an integer in {minimum}..={maximum}"))?;
    if !(minimum..=maximum).contains(&value) {
        return Err(format!("{name} must be in {minimum}..={maximum}"));
    }
    *target = Some(value);
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
        let defaults = parse_config(args(&["--socket", "/x", "--database", "/y", "--create"]))
            .expect("defaults");
        assert_eq!(defaults.readers, DEFAULT_READERS);
        assert_eq!(defaults.queue_capacity, DEFAULT_QUEUE_CAPACITY);
        let bounded = parse_config(args(&[
            "--socket",
            "/x",
            "--database",
            "/y",
            "--create",
            "--readers",
            "2",
            "--queue-capacity",
            "7",
        ]))
        .expect("bounded scheduler options");
        assert_eq!(bounded.readers, 2);
        assert_eq!(bounded.queue_capacity, 7);
        for invalid in ["0", "17", "no"] {
            assert!(
                parse_config(args(&[
                    "--socket",
                    "/x",
                    "--database",
                    "/y",
                    "--create",
                    "--readers",
                    invalid,
                ]))
                .is_err()
            );
        }
        assert!(
            parse_config(args(&[
                "--socket",
                "/x",
                "--database",
                "/y",
                "--create",
                "--queue-capacity",
                "1025",
            ]))
            .is_err()
        );
    }
}
