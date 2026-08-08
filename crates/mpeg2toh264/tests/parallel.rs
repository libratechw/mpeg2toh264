//! Converting a unit's pictures apart from the walk that planned them.
//!
//! The point of the split is that a picture carries everything it is coded
//! against, so these check the two things that would make that false: that the
//! order the pictures are converted in does not reach the output, and that a
//! converter which has never seen the stream produces the same bytes as one
//! that walked all of it.

mod support;

use std::sync::mpsc;

use mpeg2toh264::job::PictureOutput;
use mpeg2toh264::mpeg2::headers::parse_elementary_stream;
use mpeg2toh264::{
    plan_unit, transcode, Fragment, PictureEncoder, Progress, Session, TranscodeOptions,
    TranscoderState, UnitRequest,
};
use support::{
    adts_stream, fnv1a, mux_transport_stream, read_fixture, wrap_mpeg2_es_in_ts, PesUnit,
    AUDIO_PID, FIXTURES, STREAM_TYPE_AAC_ADTS, STREAM_TYPE_MPEG2_VIDEO, STREAM_TYPE_PRIVATE_DATA,
    VIDEO_PID,
};

/// The private stream this test carries alongside the two tracks.
const PRIVATE_PID: u16 = 0x110;

/// Plan a whole elementary stream as one unit and convert its jobs with
/// `encode`, which decides where and in what order the work happens.
fn convert(source: &[u8], encode: impl FnOnce(&[Vec<u8>]) -> Vec<PictureOutput>) -> Vec<u8> {
    let plan = plan_unit(
        source,
        &TranscoderState::new(),
        TranscodeOptions::default(),
        UnitRequest::default(),
        &[],
    )
    .expect("plans");
    let jobs: Vec<Vec<u8>> = plan.jobs.iter().map(|job| job.data.clone()).collect();
    let outputs = encode(&jobs);
    assert!(
        outputs.iter().all(|output| output.decoded),
        "every fixture picture decodes"
    );
    plan.assemble(&outputs)
}

#[test]
fn a_plan_converted_picture_by_picture_matches_the_whole_transcode() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let expected = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let actual = convert(&source, |jobs| {
            let mut encoder = PictureEncoder::new();
            jobs.iter()
                .map(|job| encoder.encode(job).expect("encodes"))
                .collect()
        });
        assert_eq!(
            fnv1a(&actual),
            fnv1a(&expected.bitstream),
            "{name}: planning and coding picture by picture changed the bitstream"
        );
    }
}

#[test]
fn the_order_the_pictures_are_coded_in_does_not_reach_the_output() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let expected = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        // Backwards, and each on an encoder of its own, so nothing carried
        // between two pictures could be what makes them come out right.
        let actual = convert(&source, |jobs| {
            let mut outputs: Vec<Option<PictureOutput>> = (0..jobs.len()).map(|_| None).collect();
            for index in (0..jobs.len()).rev() {
                outputs[index] = Some(PictureEncoder::new().encode(&jobs[index]).expect("encodes"));
            }
            outputs.into_iter().map(|output| output.unwrap()).collect()
        });
        assert_eq!(
            fnv1a(&actual),
            fnv1a(&expected.bitstream),
            "{name}: coding the pictures backwards changed the bitstream"
        );
    }
}

#[test]
fn pictures_coded_on_four_threads_assemble_into_the_same_stream() {
    for name in FIXTURES {
        let source = read_fixture(name);
        let expected = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        let actual = convert(&source, |jobs| {
            let (send_work, take_work) = mpsc::channel::<(usize, &Vec<u8>)>();
            let (send_done, take_done) = mpsc::channel::<(usize, PictureOutput)>();
            let take_work = std::sync::Mutex::new(take_work);
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    let take_work = &take_work;
                    let send_done = send_done.clone();
                    scope.spawn(move || {
                        // One encoder per thread, taking whatever is free, which
                        // is how a worker pool will reach them.
                        let mut encoder = PictureEncoder::new();
                        loop {
                            let Ok((index, job)) = take_work.lock().expect("not poisoned").recv()
                            else {
                                return;
                            };
                            let output = encoder.encode(job).expect("encodes");
                            send_done.send((index, output)).expect("collector lives");
                        }
                    });
                }
                for (index, job) in jobs.iter().enumerate() {
                    send_work.send((index, job)).expect("a worker lives");
                }
                drop(send_work);
                drop(send_done);
                let mut outputs: Vec<Option<PictureOutput>> =
                    (0..jobs.len()).map(|_| None).collect();
                for (index, output) in take_done {
                    outputs[index] = Some(output);
                }
                outputs.into_iter().map(|output| output.unwrap()).collect()
            })
        });
        assert_eq!(
            fnv1a(&actual),
            fnv1a(&expected.bitstream),
            "{name}: coding the pictures on four threads changed the bitstream"
        );
    }
}

/// Corrupt the macroblock layer of a fixture's last slice, which is what packet
/// loss leaves behind.
///
/// The bytes are overwritten rather than removed, both so that the start codes
/// after them stay where they were and because a slice that merely stops early
/// is not damaged at all: clause 6.2.4 ends one on twenty-three zero bits, and
/// the next start code supplies them. It takes a symbol that decodes to nothing
/// to make a slice fail, and a run of ones is not a macroblock address.
fn with_a_damaged_slice(source: &[u8]) -> Vec<u8> {
    let pictures = parse_elementary_stream(source).expect("parses");
    let last = pictures
        .iter()
        .rev()
        .find(|picture| !picture.slices.is_empty())
        .expect("a fixture has slices");
    let slice = last.slices.last().expect("the picture has slices");
    let start = slice.data_start_bit.div_ceil(8);
    let end = slice.data_end_bit.expect("the last slice ends") / 8;
    let mut damaged = source.to_vec();
    // From half way in, so the slice decodes for a while before it fails.
    damaged[(start + end) / 2..end].fill(0xff);
    damaged
}

#[test]
fn a_damaged_picture_is_planned_out_and_the_stream_stays_whole() {
    for name in FIXTURES {
        let source = with_a_damaged_slice(&read_fixture(name));
        let result = transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
        assert!(
            result.undecodable.iter().any(|&damaged| damaged),
            "{name}: cutting a slice short should leave a picture undecodable"
        );
        // The plan is drawn again without it, so the pictures that did convert
        // are all still there and nothing is coded against the missing one.
        assert_eq!(
            result.pictures_converted + result.pictures_skipped,
            parse_elementary_stream(&source)
                .expect("parses")
                .iter()
                .filter(|picture| picture.header.picture_coding_type.is_ipb())
                .count(),
            "{name}: every codeable picture is converted or counted as skipped"
        );
        assert_eq!(result.stats.errors, 1, "{name}: one damaged picture");
    }
}

#[test]
fn the_timeline_reserves_a_sample_for_exactly_what_was_coded() {
    // The invariant the two walks exist to keep: the transcoder and the MP4
    // timeline accept and drop the same source pictures. The timeline no longer
    // decodes anything to find that out, so this is what holds them together.
    for name in FIXTURES {
        for source in [
            read_fixture(name),
            with_a_damaged_slice(&read_fixture(name)),
        ] {
            let result =
                transcode(&source, TranscodeOptions::default()).expect("transcode succeeds");
            let timeline = mpeg2toh264::mpeg2_video_timeline(&source, false, &result.undecodable)
                .expect("timeline");
            assert_eq!(
                timeline.presentation_indices.len(),
                result.pictures_converted,
                "{name}: the timeline reserves a sample per converted picture"
            );
        }
    }
}

/// Everything a session handed out, flattened so two runs can be compared.
fn digest(fragments: &[Fragment]) -> Vec<(String, u64, usize, usize)> {
    fragments
        .iter()
        .map(|fragment| match fragment {
            Fragment::Init {
                data, mime_codec, ..
            } => (format!("init {mime_codec}"), fnv1a(data), 0, 0),
            Fragment::Media {
                data,
                start,
                random_access,
                video_samples,
                audio_samples,
                ..
            } => (
                format!("media {start} {random_access}"),
                fnv1a(data),
                *video_samples,
                *audio_samples,
            ),
            Fragment::PrivateStream { pid, data, pts, .. } => {
                (format!("private {pid} {pts:?}"), fnv1a(data), 0, 0)
            }
        })
        .collect()
}

/// A stream with both tracks and a private one, interleaved the way a
/// broadcast sends them.
///
/// Audio is what makes this worth building rather than reusing a video-only
/// fixture: how much of it a fragment carries is worked out from what has
/// arrived by the time its group of pictures goes out, so a driver that takes
/// input in at a different rate packs the fragments differently. Nothing about
/// the video would show that.
fn broadcast_stream(name: &str, audio_frames: usize) -> Vec<u8> {
    let video = read_fixture(name);
    let audio = adts_stream(audio_frames, 3, 2);
    let video_chunks: Vec<&[u8]> = video.chunks(20_000).collect();
    let audio_chunks: Vec<&[u8]> = audio.chunks(400).collect();
    let caption = b"a private payload standing in for a caption";

    let mut units: Vec<PesUnit<'_>> = Vec::new();
    for index in 0..video_chunks.len().max(audio_chunks.len()) {
        if let Some(payload) = video_chunks.get(index) {
            units.push(PesUnit {
                pid: VIDEO_PID,
                stream_id: 0xe0,
                payload,
                pts: Some(900_000 + index as u64 * 3_000),
            });
        }
        if let Some(payload) = audio_chunks.get(index) {
            units.push(PesUnit {
                pid: AUDIO_PID,
                stream_id: 0xc0,
                payload,
                pts: Some(903_600 + index as u64 * 3_000),
            });
        }
        if index % 4 == 0 {
            units.push(PesUnit {
                pid: PRIVATE_PID,
                stream_id: 0xbd,
                payload: caption,
                pts: Some(900_000 + index as u64 * 3_000),
            });
        }
    }
    mux_transport_stream(
        &[
            (VIDEO_PID, STREAM_TYPE_MPEG2_VIDEO),
            (AUDIO_PID, STREAM_TYPE_AAC_ADTS),
            (PRIVATE_PID, STREAM_TYPE_PRIVATE_DATA),
        ],
        &units,
    )
}

#[test]
fn a_session_driven_picture_by_picture_produces_the_same_fragments() {
    let streams = FIXTURES
        .iter()
        .map(|name| {
            (
                *name,
                wrap_mpeg2_es_in_ts(&read_fixture(name), Some(900_000)),
            )
        })
        .chain(
            // With audio and captions alongside, and in more than one chunk
            // size, because the packing depends on when each packet lands.
            ["ibbp.m2v", "open_gop_leading_bb.m2v"]
                .into_iter()
                .map(|name| (name, broadcast_stream(name, 400))),
        );
    for (name, stream) in streams {
        for chunk_size in [4096, 65536] {
            let mut sequential = Session::new(TranscodeOptions::default());
            let mut expected = Vec::new();
            for chunk in stream.chunks(chunk_size) {
                expected.extend(sequential.push(chunk).expect("push"));
            }
            expected.extend(sequential.finish().expect("finish"));

            // The same session, with the pictures converted outside it. This
            // is the shape a worker pool drives: push, convert what comes
            // back, hand it over, and keep going until nothing more is asked.
            let mut deferred = Session::new(TranscodeOptions::default());
            let mut encoder = PictureEncoder::new();
            let mut actual = Vec::new();
            let mut drive =
                |progress: Progress, session: &mut Session, actual: &mut Vec<Fragment>| {
                    let mut progress = progress;
                    loop {
                        let jobs = match progress {
                            Progress::Idle(fragments) => {
                                actual.extend(fragments);
                                return;
                            }
                            Progress::Pending { fragments, jobs } => {
                                actual.extend(fragments);
                                jobs
                            }
                        };
                        let outputs: Vec<PictureOutput> = jobs
                            .iter()
                            .map(|job| encoder.encode(job).expect("encodes"))
                            .collect();
                        progress = session.complete(&outputs).expect("complete");
                    }
                };
            for chunk in stream.chunks(chunk_size) {
                let progress = deferred.push_deferred(chunk).expect("push");
                drive(progress, &mut deferred, &mut actual);
            }
            let progress = deferred.finish_deferred().expect("finish");
            drive(progress, &mut deferred, &mut actual);

            assert!(!expected.is_empty(), "{name}: the session produced nothing");
            assert_eq!(
                digest(&actual),
                digest(&expected),
                "{name} in {chunk_size} byte chunks: driving the session \
                 picture by picture changed its fragments"
            );
        }
    }
}

#[test]
fn a_jobs_bytes_do_not_grow_with_how_far_into_the_stream_its_picture_is() {
    // The headers in front of a picture are the block its own sequence opens
    // with, not everything from the start of the unit. Taken from the start,
    // a unit holding many groups of pictures would cost the square of its
    // length to plan, which is what a whole recording handed to `transcode`
    // is. Ten copies of a fixture is enough for that to be unmistakable.
    let mut source = Vec::new();
    for _ in 0..10 {
        source.extend_from_slice(&read_fixture("ibbp.m2v"));
    }
    let plan = plan_unit(
        &source,
        &TranscoderState::new(),
        TranscodeOptions::default(),
        UnitRequest::default(),
        &[],
    )
    .expect("plans");
    let planned: usize = plan.jobs.iter().map(|job| job.data.len()).sum();
    assert!(
        planned < source.len() * 2,
        "the plan copied {planned} bytes out of a {} byte unit; a job is carrying \
         the stream in front of its picture rather than its own headers",
        source.len()
    );
}

#[test]
fn a_job_carries_the_headers_its_picture_is_described_by() {
    // The prefix in front of a picture's own bytes is what a fresh parse needs
    // to describe it. Every job must therefore parse into at least the pictures
    // it claims, with the dimensions the unit was planned at.
    for name in FIXTURES {
        let source = read_fixture(name);
        let plan = plan_unit(
            &source,
            &TranscoderState::new(),
            TranscodeOptions::default(),
            UnitRequest::default(),
            &[],
        )
        .expect("plans");
        let whole = parse_elementary_stream(&source).expect("parses");
        for job in &plan.jobs {
            // Past the context header, a job is an elementary stream of its own.
            let pictures =
                parse_elementary_stream(job.elementary_stream()).expect("a job parses on its own");
            let last = pictures.last().expect("a job carries its picture");
            let expected = &whole[job.mate.unwrap_or(job.source)];
            assert_eq!(
                (
                    last.sequence.horizontal_size,
                    last.sequence.vertical_size,
                    last.header.picture_coding_type,
                    last.slices.len()
                ),
                (
                    expected.sequence.horizontal_size,
                    expected.sequence.vertical_size,
                    expected.header.picture_coding_type,
                    expected.slices.len()
                ),
                "{name}: job {} does not parse back to its source picture",
                job.index
            );
        }
    }
}
