//! The command line front end, driven as a user would.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[path = "../../mpeg2toh264/tests/support/mod.rs"]
mod support;

use support::{
    adts_stream, mux_transport_stream, wrap_mpeg2_es_in_ts, PesUnit, AUDIO_PID,
    STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO, VIDEO_PID,
};

fn binary() -> PathBuf {
    // The integration test binary sits next to the one cargo just built.
    let mut path = std::env::current_exe().expect("test binary path");
    path.pop();
    if path.ends_with("deps") {
        path.pop();
    }
    path.join("mpeg2toh264")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata")
        .join(name)
}

fn run(args: &[&str]) -> Output {
    Command::new(binary())
        .args(args)
        .output()
        .expect("the CLI runs")
}

/// A directory that cleans itself up, so the tests leave nothing behind.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "mpeg2toh264-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn path(p: &Path) -> &str {
    p.to_str().expect("utf-8 path")
}

#[test]
fn shows_help() {
    let result = run(&["--help"]);
    assert!(result.status.success());
    assert!(String::from_utf8_lossy(&result.stdout).contains("Usage: mpeg2toh264"));
}

#[test]
fn refuses_to_overwrite_its_own_input() {
    let input = fixture("i_only.m2v");
    let result = run(&[path(&input), path(&input)]);
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("must be different"));
}

#[test]
fn rejects_an_unknown_option() {
    let result = run(&["--nonsense", "a", "b"]);
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("unknown option"));
}

#[test]
fn rejects_a_nonsensical_oversample() {
    let result = run(&["--oversample=0", "a", "b"]);
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("oversample"));
}

#[test]
fn rejects_a_nonsensical_recovery_interval() {
    let result = run(&["--recovery-interval=0", "a", "b"]);
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("recovery interval"));
}

#[test]
fn accepts_a_recovery_interval() {
    let temp = TempDir::new("recovery-interval");
    let input = temp.join("input.ts");
    let output = temp.join("output.mp4");
    let video = std::fs::read(fixture("open_gop_leading_bb.m2v")).expect("video fixture");
    std::fs::write(&input, wrap_mpeg2_es_in_ts(&video, Some(900_000)))
        .expect("transport stream fixture");

    let result = run(&["--recovery-interval", "1", path(&input), path(&output)]);
    assert!(result.status.success(), "{:?}", result);
    assert_eq!(
        String::from_utf8_lossy(&result.stdout)
            .matches("restart point")
            .count(),
        4,
        "the opening IDR and all three later GOPs are restart points"
    );
}

#[test]
fn rejects_a_nonsensical_thread_count() {
    let result = run(&["--threads=0", "a", "b"]);
    assert_eq!(result.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&result.stderr).contains("thread count"));
}

#[test]
fn converting_on_several_threads_writes_the_same_file() {
    // The whole point of splitting a unit into pictures is that where they are
    // converted cannot reach the output. One thread and four have to agree
    // byte for byte, or the split has carried something between them.
    let temp = TempDir::new("threads");
    let input = temp.join("input.ts");
    let video = std::fs::read(fixture("open_gop_leading_bb.m2v")).expect("video fixture");
    std::fs::write(&input, wrap_mpeg2_es_in_ts(&video, Some(900_000)))
        .expect("transport stream fixture");

    let mut written = Vec::new();
    for threads in ["1", "4"] {
        let output = temp.join(&format!("output-{threads}.mp4"));
        let result = run(&["--threads", threads, path(&input), path(&output)]);
        assert!(result.status.success(), "{:?}", result);
        written.push(std::fs::read(&output).expect("output"));
    }
    assert!(!written[0].is_empty(), "the conversion wrote nothing");
    assert_eq!(
        written[0], written[1],
        "converting on four threads changed the file"
    );
}

#[test]
fn reports_a_missing_input_without_panicking() {
    let temp = TempDir::new("missing");
    let result = run(&["/nonexistent/input.m2v", path(&temp.join("out.h264"))]);
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stderr).starts_with("mpeg2toh264: "));
}

#[test]
fn writes_a_raw_annex_b_stream_and_a_summary() {
    let temp = TempDir::new("h264");
    let output = temp.join("output.h264");
    let result = run(&[
        "--oversample",
        "2",
        path(&fixture("i_only.m2v")),
        path(&output),
    ]);
    assert!(result.status.success(), "{:?}", result);

    let summary = String::from_utf8_lossy(&result.stdout);
    assert!(summary.contains("MPEG-2 ES"), "{summary}");
    assert!(summary.contains("raw H.264"), "{summary}");
    assert!(summary.contains("pictures converted"), "{summary}");

    let bytes = std::fs::read(&output).expect("output exists");
    assert_eq!(&bytes[..5], &[0, 0, 0, 1, 0x67], "opens with an SPS NAL");
}

#[test]
fn writes_a_fragmented_mp4_when_the_output_says_so() {
    let temp = TempDir::new("mp4");
    let output = temp.join("output.mp4");
    let result = run(&["-q", path(&fixture("ibbp.m2v")), path(&output)]);
    assert!(result.status.success(), "{:?}", result);
    assert!(
        result.stdout.is_empty(),
        "--quiet suppresses the summary entirely"
    );

    let bytes = std::fs::read(&output).expect("output exists");
    assert_eq!(&bytes[4..8], b"ftyp");
    assert!(
        bytes.windows(4).any(|w| w == b"moof"),
        "the media segment follows the init segment"
    );
}

#[test]
fn mp4_is_the_default_for_other_output_extensions() {
    let temp = TempDir::new("default-mp4");
    let output = temp.join("output.bin");
    let result = run(&[path(&fixture("ibbp.m2v")), path(&output)]);
    assert!(result.status.success(), "{:?}", result);

    let bytes = std::fs::read(output).expect("output exists");
    assert_eq!(&bytes[4..8], b"ftyp");
}

#[test]
fn ts_mp4_carries_its_aac_audio_track() {
    let temp = TempDir::new("av-mp4");
    let input = temp.join("input.ts");
    let output = temp.join("output.mp4");
    let video = std::fs::read(fixture("ibbp.m2v")).expect("video fixture");
    let audio = adts_stream(16, 3, 2);
    let units = [
        PesUnit {
            pid: VIDEO_PID,
            stream_id: 0xe0,
            payload: &video,
            pts: Some(900_000),
        },
        PesUnit {
            pid: AUDIO_PID,
            stream_id: 0xc0,
            payload: &audio,
            pts: Some(900_000),
        },
    ];
    let ts = mux_transport_stream(
        &[
            (VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO),
            (AUDIO_PID, STREAM_TYPE_AAC_ADTS),
        ],
        &units,
    );
    std::fs::write(&input, ts).expect("transport stream fixture");

    let result = run(&[path(&input), path(&output)]);
    assert!(result.status.success(), "{:?}", result);
    assert!(
        String::from_utf8_lossy(&result.stdout).contains("16 audio samples"),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    let progress = String::from_utf8_lossy(&result.stdout);
    assert!(progress.contains("init: video/mp4"), "{progress}");
    assert!(progress.contains("fragment 1 at"), "{progress}");
    assert!(progress.contains("restart point"), "{progress}");
    assert!(progress.contains(" fps"), "{progress}");

    let bytes = std::fs::read(output).expect("output exists");
    assert_eq!(&bytes[4..8], b"ftyp");
    assert!(bytes.windows(4).any(|window| window == b"mp4a"));
    assert!(bytes.windows(4).any(|window| window == b"moof"));
}

#[test]
fn passthrough_writes_an_mpeg_2_track_instead_of_converting() {
    let temp = TempDir::new("passthrough");
    let output = temp.join("output.mp4");
    let result = run(&["--passthrough", path(&fixture("ibbp.m2v")), path(&output)]);
    assert!(result.status.success(), "{:?}", result);

    let summary = String::from_utf8_lossy(&result.stdout);
    assert!(summary.contains("pictures carried"), "{summary}");

    let bytes = std::fs::read(&output).expect("output exists");
    assert_eq!(&bytes[4..8], b"ftyp");
    assert!(
        bytes.windows(4).any(|window| window == b"mp4v"),
        "the sample entry is an MPEG-4 visual one"
    );
    assert!(
        !bytes.windows(4).any(|window| window == b"avcC"),
        "nothing was converted, so nothing describes H.264"
    );
    // The MPEG-2 start codes are the samples themselves, not something the
    // conversion path would ever put in an mdat.
    assert!(
        bytes.windows(4).any(|window| window == [0, 0, 1, 0xb3]),
        "the sequence header reached the file"
    );
}

#[test]
fn refuses_to_pass_mpeg_2_through_to_a_raw_h264_file() {
    let temp = TempDir::new("passthrough-h264");
    let result = run(&[
        "-p",
        path(&fixture("ibbp.m2v")),
        path(&temp.join("output.h264")),
    ]);
    assert_eq!(result.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&result.stderr).contains("passthrough"),
        "{:?}",
        String::from_utf8_lossy(&result.stderr)
    );
}
