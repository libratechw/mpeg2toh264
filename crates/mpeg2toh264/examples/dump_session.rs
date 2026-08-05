//! Run a [`Session`] over a transport stream and write what it emits to one
//! file, so the streaming path can be inspected without a browser.
//!
//! The initialization segment followed by every media fragment is a playable
//! fragmented MP4, which is exactly what an MSE `SourceBuffer` ends up holding.
//!
//! ```text
//! cargo run --release --example dump_session -- input.ts output.mp4
//! ```

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::process::ExitCode;

use mpeg2toh264::{Fragment, Session};

#[derive(Default)]
struct Totals {
    media: usize,
    video_samples: usize,
    audio_samples: usize,
    bytes: u64,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (input, output, service) = match args.as_slice() {
        [input, output] => (input, output, None),
        [input, output, service] => match service.parse::<u16>() {
            Ok(service) => (input, output, Some(service)),
            Err(_) => {
                eprintln!("dump_session: service id must be a number");
                return ExitCode::from(2);
            }
        },
        _ => {
            eprintln!("usage: dump_session <input.ts> <output.mp4> [service-id]");
            return ExitCode::from(2);
        }
    };

    match run(input, output, service) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dump_session: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(input: &str, output: &str, service: Option<u16>) -> Result<(), Box<dyn std::error::Error>> {
    // The point of a Session is that neither side ever has to be held whole:
    // the input arrives in slices and each fragment is written as it is
    // finished, so a recording of any length costs the same memory.
    let mut source = File::open(input)?;
    let mut sink = BufWriter::new(File::create(output)?);
    let mut session = Session::for_service(Default::default(), None, service);
    let mut totals = Totals::default();

    // A megabyte at a time, matching what the browser player reads per slice.
    let mut slice = vec![0u8; 1 << 20];
    loop {
        let read = source.read(&mut slice)?;
        if read == 0 {
            break;
        }
        for fragment in session.push(&slice[..read])? {
            report(&fragment, &mut sink, &mut totals)?;
        }
    }
    for fragment in session.finish()? {
        report(&fragment, &mut sink, &mut totals)?;
    }
    sink.flush()?;

    println!(
        "{} media fragments, {} video samples, {} audio samples, {} bytes",
        totals.media, totals.video_samples, totals.audio_samples, totals.bytes
    );
    Ok(())
}

fn report(
    fragment: &Fragment,
    out: &mut impl Write,
    totals: &mut Totals,
) -> Result<(), std::io::Error> {
    match fragment {
        Fragment::Init { data, mime_codec } => {
            println!("init: {mime_codec} ({} bytes)", data.len());
            write(out, data, totals)?;
        }
        Fragment::Media {
            data,
            start,
            random_access,
            video_samples,
            audio_samples,
            interlacing,
        } => {
            totals.media += 1;
            totals.video_samples += video_samples;
            totals.audio_samples += audio_samples;
            // Restart points are what a player evicts up to, so call them out.
            if *random_access {
                let scan = match (interlacing.interlaced, interlacing.top_field_first) {
                    (false, _) => "progressive",
                    (true, true) => "interlaced tff",
                    (true, false) => "interlaced bff",
                };
                println!(
                    "fragment {} at {start:.3}s: restart point, {video_samples} video, \
                     {audio_samples} audio, {scan}",
                    totals.media
                );
            }
            write(out, data, totals)?;
        }
    }
    Ok(())
}

fn write(out: &mut impl Write, data: &[u8], totals: &mut Totals) -> Result<(), std::io::Error> {
    out.write_all(data)?;
    totals.bytes += data.len() as u64;
    Ok(())
}
