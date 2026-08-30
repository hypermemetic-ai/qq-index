use std::env;
use std::process::ExitCode;

use qq_session_indexd::{USAGE, parse_config, run};

fn main() -> ExitCode {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    if arguments.len() == 1 && matches!(arguments[0].to_str(), Some("--help" | "-h")) {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    let config = match parse_config(arguments) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("qq-session-indexd: {error}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(&config) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("qq-session-indexd: {error}");
            ExitCode::FAILURE
        }
    }
}
