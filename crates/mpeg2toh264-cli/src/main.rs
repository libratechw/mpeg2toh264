//! Command line front end: MPEG-TS or MPEG-2 elementary stream in, raw Annex B
//! H.264 or fragmented MP4 out.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use mpeg2toh264::{
    extract_mpeg2_video_es, h264_to_fmp4, is_mpeg_transport_stream, mpeg2_video_timeline,
    transcode, TranscodeOptions,
};

const USAGE: &str = "\
Usage: mpeg2toh264 [options] <input.ts|input.m2v> <output.h264|output.mp4>

Transcode an MPEG transport stream or MPEG-2 video elementary stream to raw
Annex B H.264 or video-only fragmented MP4. The output format is selected from
the output extension. The first MPEG-2 video program in a TS is selected.

Arguments:
  input.ts|input.m2v        MPEG-TS or MPEG-2 video elementary stream
  output.h264|output.mp4    Raw H.264/AVC or timestamped fragmented MP4

Options:
  -o, --oversample <n>      Quantiser search oversampling factor (default: 2)
      --i-frames-only       Convert MPEG-2 I pictures only
  -q, --quiet               Do not print the conversion summary
  -h, --help                Show this help
";

struct CliOptions {
    input: PathBuf,
    output: PathBuf,
    quiet: bool,
    transcode: TranscodeOptions,
}

/// What `parse_args` decided to do, since `--help` is a successful exit rather
/// than a set of options.
enum Invocation {
    Run(Box<CliOptions>),
    Help,
}

fn fail(message: &str) -> ! {
    eprintln!("mpeg2toh264: {message}");
    eprintln!("Try 'mpeg2toh264 --help' for usage.");
    std::process::exit(2);
}

fn parse_args(args: &[String]) -> Invocation {
    let mut positional: Vec<&str> = Vec::new();
    let mut oversample: f64 = 2.0;
    let mut i_frames_only = false;
    let mut quiet = false;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "-h" | "--help" => return Invocation::Help,
            "--i-frames-only" => i_frames_only = true,
            "-q" | "--quiet" => quiet = true,
            "-o" | "--oversample" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    fail(&format!("{arg} requires a value"));
                };
                oversample = value.parse().unwrap_or(f64::NAN);
            }
            _ if arg.starts_with("--oversample=") => {
                oversample = arg["--oversample=".len()..].parse().unwrap_or(f64::NAN);
            }
            _ if arg.starts_with('-') => fail(&format!("unknown option '{arg}'")),
            _ => positional.push(arg),
        }
        i += 1;
    }

    if !oversample.is_finite() || oversample <= 0.0 {
        fail("oversample must be a positive number");
    }
    if positional.len() != 2 {
        fail(&format!(
            "expected input and output paths, got {} positional argument(s)",
            positional.len()
        ));
    }
    let input = absolute(Path::new(positional[0]));
    let output = absolute(Path::new(positional[1]));
    if input == output {
        fail("input and output must be different files");
    }
    Invocation::Run(Box::new(CliOptions {
        input,
        output,
        quiet,
        transcode: TranscodeOptions {
            oversample,
            i_frames_only,
        },
    }))
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

fn run(options: &CliOptions) -> Result<(), Box<dyn std::error::Error>> {
    let container = std::fs::read(&options.input)?;
    let transport_stream = is_mpeg_transport_stream(&container);
    let source = if transport_stream {
        extract_mpeg2_video_es(&container)?
    } else {
        container
    };

    let started = Instant::now();
    let result = transcode(&source, options.transcode)?;
    let elapsed = started.elapsed();

    let is_mp4 = options
        .output
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"));
    let (output_data, output_kind) = if is_mp4 {
        let timeline = mpeg2_video_timeline(&source, false)?;
        let mp4 = h264_to_fmp4(&result.bitstream, &timeline)?;
        let mut data = mp4.init_segment;
        data.extend_from_slice(&mp4.media_segment);
        (data, "fragmented MP4")
    } else {
        (result.bitstream, "raw H.264")
    };
    std::fs::write(&options.output, &output_data)?;

    if !options.quiet {
        let seconds = elapsed.as_secs_f64();
        let fps = if seconds > 0.0 {
            result.pictures_converted as f64 / seconds
        } else {
            f64::INFINITY
        };
        println!(
            "{} ({}) -> {} ({output_kind})",
            options.input.display(),
            if transport_stream {
                "MPEG-TS"
            } else {
                "MPEG-2 ES"
            },
            options.output.display(),
        );
        println!(
            "{} pictures converted, {} skipped, {} bytes, {:.1} ms ({fps:.2} fps)",
            result.pictures_converted,
            result.pictures_skipped,
            output_data.len(),
            seconds * 1000.0,
        );
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_args(&args) {
        Invocation::Help => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Invocation::Run(options) => options,
    };
    match run(&options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("mpeg2toh264: {error}");
            ExitCode::FAILURE
        }
    }
}
