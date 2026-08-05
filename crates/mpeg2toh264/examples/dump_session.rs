//! Run a [`Session`] over a transport stream and write what it emits to one
//! file, so the streaming path can be inspected without a browser.
//!
//! The initialization segment followed by every media fragment is a playable
//! fragmented MP4, which is exactly what an MSE `SourceBuffer` ends up holding.
//!
//! ```text
//! cargo run --release --example dump_session -- input.ts output.mp4
//! ```

use std::process::ExitCode;

use mpeg2toh264::{Fragment, Session};

#[derive(Default)]
struct Totals {
    media: usize,
    video_samples: usize,
    audio_samples: usize,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = args.as_slice() else {
        eprintln!("usage: dump_session <input.ts> <output.mp4>");
        return ExitCode::from(2);
    };

    match run(input, output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dump_session: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(input: &str, output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let stream = std::fs::read(input)?;
    let mut session = Session::default();
    let mut out = Vec::new();
    let mut totals = Totals::default();

    // A megabyte at a time, matching what the browser player reads per slice.
    for chunk in stream.chunks(1 << 20) {
        for fragment in session.push(chunk)? {
            report(&fragment, &mut out, &mut totals);
        }
    }
    for fragment in session.finish()? {
        report(&fragment, &mut out, &mut totals);
    }

    std::fs::write(output, &out)?;
    println!(
        "{} media fragments, {} video samples, {} audio samples, {} bytes",
        totals.media,
        totals.video_samples,
        totals.audio_samples,
        out.len()
    );
    Ok(())
}

fn report(fragment: &Fragment, out: &mut Vec<u8>, totals: &mut Totals) {
    match fragment {
        Fragment::Init { data, mime_codec } => {
            println!("init: {mime_codec} ({} bytes)", data.len());
            out.extend_from_slice(data);
        }
        Fragment::Media {
            data,
            start,
            random_access,
            video_samples,
            audio_samples,
        } => {
            totals.media += 1;
            totals.video_samples += video_samples;
            totals.audio_samples += audio_samples;
            // Restart points are what a player evicts up to, so call them out.
            if *random_access {
                println!(
                    "fragment {} at {start:.3}s: restart point, {video_samples} video, \
                     {audio_samples} audio",
                    totals.media
                );
            }
            out.extend_from_slice(data);
        }
    }
}
