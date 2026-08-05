//! Streaming a transport stream to fragmented MP4, in one object.
//!
//! This is the surface a browser needs: hand it file chunks, take fragments
//! back, append them to a `SourceBuffer`. Everything between -- demuxing, GOP
//! splitting, transcoding, muxing, and putting the two tracks on a common
//! timeline -- happens here rather than in the caller, because the timeline
//! arithmetic is the part most easily got wrong and it belongs next to the code
//! it constrains.

use crate::container::adts::{
    aac_frame_count_through_video_time, AacConfig, AacFrame, AdtsStream, AAC_FRAME_SAMPLES,
};
use crate::container::fmp4::{
    h264_gop_to_fmp4, mpeg2_fragment_duration, mpeg2_video_timeline, Fmp4AudioSamples,
    Mpeg2VideoTimeline,
};
use crate::container::mpegts::{ElementaryKind, ElementaryPacket, MpegTsAvDemuxer};
use crate::error::Result;
use crate::mpeg2::gop_stream::{Mpeg2Gop, Mpeg2GopStream};
use crate::mpeg2::headers::Interlacing;
use crate::round_half_up;
use crate::transcode::{IncrementalTranscoder, TranscodeOptions};

/// How many GOPs apart the restart points are.
///
/// A decoder can begin at any of them, which is what lets a player evict what
/// it has already shown without cutting into what it is about to. They cost an
/// intra-coded picture each, so they are kept far enough apart that the cost is
/// negligible and close enough that eviction has somewhere to stop.
const RANDOM_ACCESS_GOP_INTERVAL: usize = 24;

const TIMESCALE: u64 = 90_000;

/// The PES timestamp field is 33 bits and wraps every 26.5 hours (clause
/// 2.4.3.7), so the distance between two of them is modular.
const PTS_MODULUS: i64 = 1 << 33;

/// Ticks from `origin` to `pts`, across however many wraps lie between them.
fn ticks_since(origin: i64, pts: i64) -> u64 {
    (pts - origin).rem_euclid(PTS_MODULUS) as u64
}

/// One thing to hand to Media Source Extensions.
#[derive(Clone, Debug)]
pub enum Fragment {
    /// The initialization segment, emitted once, before any media.
    Init {
        data: Vec<u8>,
        /// The MIME type to open the `SourceBuffer` with.
        mime_codec: String,
    },
    /// One GOP of media.
    Media {
        data: Vec<u8>,
        /// Where this fragment starts on the presentation timeline, in seconds.
        start: f64,
        /// Whether a decoder can begin here. A player needs this, with `start`,
        /// to evict buffered media without cutting into what is about to play.
        random_access: bool,
        video_samples: usize,
        audio_samples: usize,
        /// What the source pictures of this fragment said about their fields.
        /// A player deinterlacing the picture itself has nowhere else to learn
        /// it: the H.264 this produces is decoded into frames, and by then the
        /// two moments in one are indistinguishable from one.
        interlacing: Interlacing,
    },
}

/// Streaming transcode of one transport stream.
pub struct Session {
    demuxer: MpegTsAvDemuxer,
    gops: Mpeg2GopStream,
    adts: AdtsStream,
    transcoder: IncrementalTranscoder,

    sequence_number: u32,
    /// Where the next fragment starts, in 90 kHz ticks.
    video_presentation_start: u64,
    audio_frames_emitted: u64,
    gops_emitted: usize,
    initialized: bool,

    pending_gops: Vec<Mpeg2Gop>,
    pending_audio: Vec<AacFrame>,
    audio_config: Option<AacConfig>,

    /// PES timestamp of the first audio packet, in 90 kHz units.
    audio_start_pts: Option<u64>,
    /// Where the audio track begins on the shared timeline, once it is fixed.
    audio_origin_ticks: u64,
    /// The PES timestamp presentation time zero stands for. Supplied by a
    /// caller resuming mid-file, and worked out from the stream otherwise.
    timeline_origin: Option<i64>,
    timelines_aligned: bool,
}

impl Session {
    pub fn new(options: TranscodeOptions) -> Self {
        Self::anchored(options, None)
    }

    /// Take one named service out of a transport stream that carries several.
    ///
    /// A recording of a broadcast is not always of one programme: a
    /// broadcaster's sub-channel rides in the same transport stream with its
    /// own video and its own audio. Without being told which to take, the
    /// session takes whichever program map turns up first, which is stable for
    /// a given recording but is not a choice anyone made.
    pub fn for_service(
        options: TranscodeOptions,
        origin_ticks: Option<u64>,
        service_id: Option<u16>,
    ) -> Self {
        Self {
            demuxer: MpegTsAvDemuxer::for_service(service_id),
            ..Self::anchored(options, origin_ticks)
        }
    }

    /// The service the fragments are being made from, once a program map has
    /// named it, and every service the stream has announced.
    pub fn service_id(&self) -> Option<u16> {
        self.demuxer.service_id()
    }

    pub fn service_ids(&self) -> &[u16] {
        self.demuxer.service_ids()
    }

    /// Start a session whose timeline is measured from a PES timestamp of the
    /// caller's choosing, rather than from wherever this input happens to open.
    ///
    /// This is what makes a stream that begins mid-file playable: fed the
    /// origin an earlier session reported, the fragments it produces carry the
    /// presentation times they hold in the whole file, and a player can append
    /// them where the viewer asked to be.
    pub fn anchored(options: TranscodeOptions, origin_ticks: Option<u64>) -> Self {
        Self {
            demuxer: MpegTsAvDemuxer::new(),
            gops: Mpeg2GopStream::new(),
            adts: AdtsStream::new(),
            transcoder: IncrementalTranscoder::new(options),
            sequence_number: 1,
            video_presentation_start: 0,
            audio_frames_emitted: 0,
            gops_emitted: 0,
            initialized: false,
            pending_gops: Vec::new(),
            pending_audio: Vec::new(),
            audio_config: None,
            audio_start_pts: None,
            audio_origin_ticks: 0,
            timeline_origin: origin_ticks.map(|ticks| ticks as i64),
            timelines_aligned: false,
        }
    }

    /// The PES timestamp presentation time zero stands for, once the opening
    /// fragment has fixed it. Hand it to [`Session::anchored`] to continue this
    /// timeline from somewhere else in the same file.
    pub fn origin_ticks(&self) -> Option<u64> {
        self.timeline_origin
            .map(|origin| origin.rem_euclid(PTS_MODULUS) as u64)
    }

    /// Feed the next slice of the transport stream, taking back whatever
    /// fragments it completed. A chunk that completes nothing returns nothing;
    /// that is normal and not an error.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Fragment>> {
        let packets = self.demuxer.push(chunk)?;
        let mut out = Vec::new();
        self.consume_elementary(packets, &mut out)?;
        Ok(out)
    }

    /// Flush everything held back, at end of input.
    pub fn finish(&mut self) -> Result<Vec<Fragment>> {
        let packets = self.demuxer.finish()?;
        let mut out = Vec::new();
        self.consume_elementary(packets, &mut out)?;

        self.pending_gops.extend(self.gops.finish());
        let final_audio = self.adts.finish()?;
        if self.audio_config.is_none() {
            self.audio_config = final_audio.first().map(|frame| frame.config.clone());
        }
        self.pending_audio.extend(final_audio);
        self.flush_pending(true, &mut out)?;
        Ok(out)
    }

    fn consume_elementary(
        &mut self,
        packets: Vec<ElementaryPacket>,
        out: &mut Vec<Fragment>,
    ) -> Result<()> {
        for packet in packets {
            match packet.kind {
                ElementaryKind::Video => {
                    let units = self.gops.push(&packet.data, packet.pts);
                    self.pending_gops.extend(units);
                }
                ElementaryKind::Audio => {
                    if self.audio_start_pts.is_none() {
                        self.audio_start_pts = packet.pts;
                    }
                    let frames = self.adts.push(&packet.data)?;
                    if self.audio_config.is_none() {
                        self.audio_config = frames.first().map(|frame| frame.config.clone());
                    }
                    self.pending_audio.extend(frames);
                }
            }
            self.flush_pending(false, out)?;
        }
        Ok(())
    }

    /// Whether the fragment about to be emitted opens at an IDR, which is both
    /// the first one and every restart point after it.
    fn starts_at_idr(&self) -> bool {
        !self.initialized || self.is_random_access_point()
    }

    fn is_random_access_point(&self) -> bool {
        self.gops_emitted > 0 && self.gops_emitted % RANDOM_ACCESS_GOP_INTERVAL == 0
    }

    fn flush_pending(&mut self, final_flush: bool, out: &mut Vec<Fragment>) -> Result<()> {
        if !self.demuxer.has_aac_audio() {
            for gop in std::mem::take(&mut self.pending_gops) {
                self.emit_gop(&gop, Vec::new(), None, out)?;
            }
            return Ok(());
        }
        // Keep one GOP pending so all AAC packets up to the next GOP boundary
        // can share the same moof. MSE implementations then see both trafs per
        // fragment.
        let keep = usize::from(!final_flush);
        while self.pending_gops.len() > keep {
            let Some(config) = self.audio_config.clone() else {
                break;
            };
            if !final_flush && self.pending_audio.is_empty() {
                break;
            }
            let gop = self.pending_gops[0].clone();
            let starts_at_idr = self.starts_at_idr();
            let timeline = mpeg2_video_timeline(&gop.data, !starts_at_idr)?;
            self.align_timelines(&gop, &timeline);
            let video_duration = mpeg2_fragment_duration(&timeline, starts_at_idr);
            // Audio is measured from where the audio track itself starts, not
            // from where the video does.
            let through = (self.video_presentation_start + video_duration) as i64
                - self.audio_origin_ticks as i64;
            let desired = aac_frame_count_through_video_time(through, config.sample_rate);
            let wanted = (desired - self.audio_frames_emitted as i64).max(0) as usize;
            if !final_flush && self.pending_audio.len() < wanted {
                break;
            }
            self.pending_gops.remove(0);
            // The last fragment takes whatever audio is left, since nothing
            // follows it to carry the remainder.
            let take = if final_flush && self.pending_gops.is_empty() {
                self.pending_audio.len()
            } else {
                wanted.min(self.pending_audio.len())
            };
            let frames: Vec<AacFrame> = self.pending_audio.drain(..take).collect();
            self.emit_gop(&gop, frames, Some(timeline), out)?;
        }
        Ok(())
    }

    /// Put the two tracks on one timeline, using the timestamps the transport
    /// stream gives them.
    ///
    /// Video and audio in a broadcast stream do not start at the same PTS -- a
    /// few hundred milliseconds apart is normal -- so starting both tracks at
    /// zero shifts the audio by exactly that difference. Both are instead
    /// placed at their real distance from the origin, which for a session that
    /// picks its own is whichever track starts first, and for an anchored one
    /// is the timestamp the caller named.
    fn align_timelines(&mut self, gop: &Mpeg2Gop, timeline: &Mpeg2VideoTimeline) {
        if self.timelines_aligned {
            return;
        }
        // Once a fragment has gone out the origin is fixed, whether or not the
        // timestamps to choose it ever arrived; moving it later would tear the
        // timeline in two.
        if self.initialized {
            self.timelines_aligned = true;
            return;
        }
        let Some(video_pts) = gop.pts else {
            return;
        };
        // A GOP's timestamp belongs to its I picture, which is coded first but
        // displayed after the B pictures that lead the group. This only ever
        // runs on the opening fragment, where those pictures are missing and
        // the IDR covers their display slots, so the presentation still starts
        // where they would.
        let leading_slots = timeline.presentation_indices.first().copied().unwrap_or(1) - 1;
        let video_start =
            video_pts as i64 - (leading_slots as i64 * timeline.sample_duration as i64);
        let origin = match self.timeline_origin {
            Some(origin) => origin,
            None => {
                let chosen = match self.audio_start_pts {
                    // Decoding leads display by up to one frame, and the muxer
                    // needs somewhere to put that, so the timeline starts a
                    // frame before the earlier track.
                    Some(audio_pts) => {
                        (video_start - timeline.sample_duration as i64).min(audio_pts as i64)
                    }
                    // A stream with no audio track to wait for begins where its
                    // video does; one that has yet to name its audio waits,
                    // because the origin cannot be moved afterwards.
                    None if self.demuxer.has_aac_audio() => return,
                    None => video_start,
                };
                self.timeline_origin = Some(chosen);
                chosen
            }
        };
        self.timelines_aligned = true;
        self.video_presentation_start = ticks_since(origin, video_start);
        if let Some(audio_pts) = self.audio_start_pts {
            self.audio_origin_ticks = ticks_since(origin, audio_pts as i64);
        }
    }

    /// Decode time of the next audio sample, in the audio track's own timescale.
    fn audio_base_decode_time(&self, rate: u32) -> u64 {
        let origin =
            round_half_up((self.audio_origin_ticks * rate as u64) as f64 / TIMESCALE as f64);
        origin as u64 + self.audio_frames_emitted * AAC_FRAME_SAMPLES
    }

    fn emit_gop(
        &mut self,
        gop: &Mpeg2Gop,
        audio_frames: Vec<AacFrame>,
        timeline: Option<Mpeg2VideoTimeline>,
        out: &mut Vec<Fragment>,
    ) -> Result<()> {
        let random_access = self.is_random_access_point();
        if random_access {
            self.transcoder.request_random_access_point();
        }
        let starts_at_idr = !self.initialized || random_access;
        let timeline = match timeline {
            Some(timeline) => timeline,
            None => mpeg2_video_timeline(&gop.data, !starts_at_idr)?,
        };
        // Aligning can still move the origin, so read the start after it.
        self.align_timelines(gop, &timeline);
        let start = self.video_presentation_start as f64 / TIMESCALE as f64;

        let h264 = self.transcoder.push(&gop.data)?;
        let config = audio_frames
            .first()
            .map(|frame| frame.config.clone())
            .or_else(|| self.audio_config.clone());
        let audio_track = config.as_ref().map(|config| Fmp4AudioSamples {
            config: config.clone(),
            samples: audio_frames
                .iter()
                .map(|frame| frame.data.clone())
                .collect(),
            base_decode_time: self.audio_base_decode_time(config.sample_rate),
        });
        let fragment = h264_gop_to_fmp4(
            &h264.bitstream,
            &timeline,
            self.sequence_number,
            self.video_presentation_start,
            config.as_ref(),
            audio_track.as_ref(),
        )?;
        // A unit that yielded no picture, with no audio to carry alongside it,
        // makes a moof describing no samples of anything. A recording cut mid
        // group ends with one, and there is nothing in it for a SourceBuffer to
        // play. The transcoder has already seen it, which is what the unit was
        // worth.
        if fragment.sample_count == 0 && audio_frames.is_empty() {
            return Ok(());
        }
        self.sequence_number += 1;
        self.video_presentation_start += fragment.duration;
        self.audio_frames_emitted += audio_frames.len() as u64;
        self.gops_emitted += 1;

        if !self.initialized {
            self.initialized = true;
            out.push(Fragment::Init {
                data: fragment.init_segment,
                mime_codec: fragment.mime_codec,
            });
        }
        out.push(Fragment::Media {
            data: fragment.media_segment,
            start,
            random_access: starts_at_idr,
            video_samples: fragment.sample_count,
            audio_samples: audio_frames.len(),
            interlacing: timeline.interlacing,
        });
        Ok(())
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new(TranscodeOptions::default())
    }
}
