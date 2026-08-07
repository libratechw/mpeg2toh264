//! Streaming a transport stream to fragmented MP4, in one object.
//!
//! This is the surface a browser needs: hand it file chunks, take fragments
//! back, append them to a `SourceBuffer`. Everything between -- demuxing, GOP
//! splitting, transcoding, muxing, and putting the two tracks on a common
//! timeline -- happens here rather than in the caller, because the timeline
//! arithmetic is the part most easily got wrong and it belongs next to the code
//! it constrains.

use std::collections::VecDeque;

use crate::container::adts::{
    aac_frame_count_through_video_time, AacConfig, AacFrame, AdtsStream, AAC_FRAME_SAMPLES,
};
use crate::container::fmp4::{
    h264_gop_to_fmp4, mpeg2_fragment_duration, mpeg2_gop_to_fmp4, mpeg2_passthrough_unit,
    mpeg2_video_timeline, Fmp4AudioSamples, Fmp4Fragment, Mpeg2Unit, Mpeg2VideoTimeline,
    UnitLeadIn,
};
use crate::container::mpegts::{ElementaryKind, ElementaryPacket, MpegTsAvDemuxer};
use crate::error::{bail, Result};
use crate::job::PictureOutput;
use crate::mpeg2::gop_stream::{Mpeg2Gop, Mpeg2GopStream};
use crate::mpeg2::headers::Interlacing;
use crate::round_half_up;
use crate::transcode::{IncrementalTranscoder, Step, TranscodeOptions, TranscodeResult, VideoMode};

const TIMESCALE: u64 = 90_000;

/// Short AAC holes are packet loss, not the end of the audio track. Repeating
/// the following access unit keeps MSE's joint audio/video buffered range
/// continuous. Larger jumps are discontinuities and are not concealed here.
const MAX_CONCEALED_AUDIO_FRAMES: u64 = 8;

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
    /// A private PES payload selected from the same service as the media.
    /// It is kept out of fMP4 and exposed to browser consumers as an event.
    PrivateStream {
        stream_id: u8,
        pid: u16,
        data: Vec<u8>,
        /// Absolute 90 kHz timestamp, supplemented from accompanying media for
        /// an untimed character-superimpose PES.
        pts: Option<u64>,
    },
}

/// What the video of one unit turns into, and what the muxer needs to know
/// about it.
///
/// Both paths cut the same source pictures out of a unit -- the passthrough one
/// keeps damaged slices, which are the decoder's business rather than this
/// crate's, and is otherwise the same walk -- so the timeline underneath is the
/// same. They differ in what covers the display slots of an open GOP's leading
/// pictures where a fragment opens the presentation: the transcoder puts an
/// extra copy of its IDR there, and passthrough simply shows its first picture
/// for longer.
enum UnitPlan {
    Transcode(Mpeg2VideoTimeline),
    Passthrough(Mpeg2Unit),
}

impl UnitPlan {
    fn timeline(&self) -> &Mpeg2VideoTimeline {
        match self {
            Self::Transcode(timeline) => timeline,
            Self::Passthrough(unit) => &unit.timeline,
        }
    }

    fn timeline_mut(&mut self) -> &mut Mpeg2VideoTimeline {
        match self {
            Self::Transcode(timeline) => timeline,
            Self::Passthrough(unit) => &mut unit.timeline,
        }
    }

    fn lead_in(&self, starts_at_idr: bool) -> UnitLeadIn {
        match (self, starts_at_idr) {
            (_, false) => UnitLeadIn::None,
            (Self::Transcode(_), true) => UnitLeadIn::IdrClone,
            (Self::Passthrough(_), true) => UnitLeadIn::FirstPicture,
        }
    }
}

/// How far a caller driving the session itself has got through its input.
///
/// The end of the input is three steps rather than one: the demuxer's last
/// packets still go in the ordinary way, then what the group splitter and the
/// ADTS reader are holding goes in, and only then does the final flush run.
/// [`Session::finish`] walks those in a single call; a deferred caller can be
/// suspended in the middle of any of them, so where it is has to be written
/// down.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Ordinary input; more may still arrive.
    Feeding,
    /// The demuxer has been flushed and its last packets are going in.
    Draining,
    /// Everything is in, and what is left is the final flush.
    Finishing,
    Done,
}

/// A unit that is going out, waiting only for its video to be converted.
struct Ready {
    gop: Mpeg2Gop,
    audio: Vec<AacFrame>,
    plan: UnitPlan,
    starts_at_idr: bool,
}

/// How far a session got, for a caller converting the pictures itself.
///
/// The conversion of a unit is the one part of this that need not happen here,
/// and in a browser it is the part worth not happening here: it is most of the
/// work, and it divides into pictures that have nothing to say to each other.
/// So a session driven this way stops when it reaches one, hands out the
/// pictures, and waits to be given them back.
pub enum Progress {
    /// Nothing is owed. Feed more input.
    Idle(Vec<Fragment>),
    /// Convert these and call [`Session::complete`] with one output per job,
    /// in the same order.
    Pending {
        fragments: Vec<Fragment>,
        jobs: Vec<Vec<u8>>,
    },
}

impl Progress {
    /// The fragments either way, for a caller that hands them on before
    /// looking at what is still owed.
    pub fn fragments(&mut self) -> Vec<Fragment> {
        match self {
            Self::Idle(fragments) => std::mem::take(fragments),
            Self::Pending { fragments, .. } => std::mem::take(fragments),
        }
    }
}

/// How the video reaches the MP4.
enum VideoPipeline {
    Transcode(IncrementalTranscoder),
    /// Carried through as MPEG-2, where an intra picture is already everything
    /// a recovery point has to be: nothing is flushed, nothing is coded, and
    /// the pictures around it are the source's own.
    Passthrough {
        /// The transcoder's `awaiting_idr` under another name: no picture can
        /// be carried until one arrives that a decoder can start on.
        awaiting_intra: bool,
        /// A periodic restart point is due, and goes to the next unit that
        /// opens with an intra picture.
        recovery_pending: bool,
        split_field_samples: bool,
    },
}

impl VideoPipeline {
    /// Whether the next unit has to be one a decoder can begin at. The MP4
    /// timeline has to reach the same verdict on the same pictures, so it asks.
    fn awaiting_random_access(&self) -> bool {
        match self {
            Self::Transcode(transcoder) => transcoder.awaiting_random_access(),
            Self::Passthrough { awaiting_intra, .. } => *awaiting_intra,
        }
    }

    fn request_recovery_point(&mut self) {
        match self {
            Self::Transcode(transcoder) => transcoder.request_recovery_point(),
            Self::Passthrough {
                recovery_pending, ..
            } => *recovery_pending = true,
        }
    }

    fn split_field_samples(&self) -> bool {
        match self {
            Self::Transcode(transcoder) => transcoder.split_field_samples(),
            Self::Passthrough {
                split_field_samples,
                ..
            } => *split_field_samples,
        }
    }

    fn errors(&self) -> u64 {
        match self {
            Self::Transcode(transcoder) => transcoder.errors(),
            // Nothing is decoded here, so nothing malformed is found.
            Self::Passthrough { .. } => 0,
        }
    }
}

/// Streaming transcode of one transport stream.
pub struct Session {
    demuxer: MpegTsAvDemuxer,
    gops: Mpeg2GopStream,
    adts: AdtsStream,
    video: VideoPipeline,
    recovery_point_gop_interval: usize,

    sequence_number: u32,
    /// Where the next fragment starts, in 90 kHz ticks.
    video_presentation_start: u64,
    audio_frames_emitted: u64,
    gops_emitted: usize,
    initialized: bool,

    pending_gops: Vec<Mpeg2Gop>,
    pending_audio: Vec<AacFrame>,
    audio_config: Option<AacConfig>,

    /// The unit whose pictures a deferred caller is converting. Nothing else
    /// can go out until they come back, because everything after this unit is
    /// measured from where it ends.
    converting: Option<Ready>,
    /// Packets a deferred caller's input has produced but that have not been
    /// packaged yet. They go in one at a time; see [`Session::pump`].
    pending_packets: VecDeque<ElementaryPacket>,
    /// How far a deferred caller has got through its input.
    phase: Phase,

    /// PES timestamp of the first audio packet, in 90 kHz units.
    audio_start_pts: Option<u64>,
    /// PTS and frame count used to notice missing AAC access units.
    audio_clock_start_pts: Option<u64>,
    audio_clock_frames: u64,
    audio_clock_sample_rate: Option<u32>,
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

    pub fn dropped(&self) -> u64 {
        self.demuxer.dropped()
    }
    pub fn scrambled(&self) -> u64 {
        self.demuxer.scrambled()
    }
    pub fn errors(&self) -> u64 {
        self.demuxer.errors() + self.video.errors()
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
            video: match options.video {
                VideoMode::Transcode => {
                    VideoPipeline::Transcode(IncrementalTranscoder::new(options))
                }
                VideoMode::Passthrough => VideoPipeline::Passthrough {
                    awaiting_intra: true,
                    recovery_pending: false,
                    split_field_samples: options.split_field_samples,
                },
            },
            recovery_point_gop_interval: options.recovery_interval,
            sequence_number: 1,
            video_presentation_start: 0,
            audio_frames_emitted: 0,
            gops_emitted: 0,
            initialized: false,
            pending_gops: Vec::new(),
            pending_audio: Vec::new(),
            audio_config: None,
            converting: None,
            pending_packets: VecDeque::new(),
            phase: Phase::Feeding,
            audio_start_pts: None,
            audio_clock_start_pts: None,
            audio_clock_frames: 0,
            audio_clock_sample_rate: None,
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

    /// [`Self::push`], for a caller that will convert the pictures itself.
    ///
    /// Returns [`Progress::Pending`] as soon as a unit needs its video coded,
    /// and nothing more comes out of the session until those pictures are
    /// handed back to [`Self::complete`].
    pub fn push_deferred(&mut self, chunk: &[u8]) -> Result<Progress> {
        self.expect_nothing_in_flight()?;
        if self.phase != Phase::Feeding {
            bail!("the session has already been told the input has ended");
        }
        let packets = self.demuxer.push(chunk)?;
        self.pending_packets.extend(packets);
        self.pump(Vec::new())
    }

    /// [`Self::finish`], for the same caller. Call it until it returns
    /// [`Progress::Idle`].
    pub fn finish_deferred(&mut self) -> Result<Progress> {
        self.expect_nothing_in_flight()?;
        if self.phase == Phase::Feeding {
            self.pending_packets.extend(self.demuxer.finish()?);
            self.phase = Phase::Draining;
        }
        self.pump(Vec::new())
    }

    /// Hand back one converted picture per job, in the order they were given
    /// out, and carry on.
    pub fn complete(&mut self, outputs: &[PictureOutput]) -> Result<Progress> {
        let Some(converting) = self.converting.take() else {
            bail!("no pictures were asked for");
        };
        let VideoPipeline::Transcode(transcoder) = &mut self.video else {
            bail!("the passthrough pipeline converts no pictures");
        };
        match transcoder.complete(&converting.gop.data, outputs)? {
            Step::Again(jobs) => {
                self.converting = Some(converting);
                Ok(Progress::Pending {
                    fragments: Vec::new(),
                    jobs,
                })
            }
            Step::Done(h264) => {
                let mut out = Vec::new();
                self.finish_gop(converting, Some(*h264), &mut out)?;
                self.pump(out)
            }
        }
    }

    /// Take the demuxed packets in one at a time, packaging whatever each of
    /// them completes, and stop at the first unit whose pictures have to be
    /// converted.
    ///
    /// One packet at a time because that is what [`Self::push`] does, and the
    /// two have to reach the same fragments: how much audio a fragment carries
    /// is worked out from what has arrived when its group of pictures goes out,
    /// so taking a whole chunk in before packaging any of it would put audio in
    /// a fragment that ran ahead of it.
    fn pump(&mut self, mut out: Vec<Fragment>) -> Result<Progress> {
        loop {
            match self.advance(self.phase == Phase::Finishing, out)? {
                pending @ Progress::Pending { .. } => return Ok(pending),
                Progress::Idle(fragments) => out = fragments,
            }
            if let Some(packet) = self.pending_packets.pop_front() {
                self.ingest_packet(packet, &mut out)?;
                continue;
            }
            match self.phase {
                // More input may still arrive, so what is held back stays back.
                Phase::Feeding => return Ok(Progress::Idle(out)),
                Phase::Draining => {
                    // Everything the demuxer had is in. What the group splitter
                    // and the ADTS reader are still holding goes in now, and
                    // the last fragments take whatever is left over.
                    self.pending_gops.extend(self.gops.finish());
                    let final_audio = self.adts.finish()?;
                    if self.audio_config.is_none() {
                        self.audio_config = final_audio.first().map(|frame| frame.config.clone());
                    }
                    self.pending_audio.extend(final_audio);
                    self.phase = Phase::Finishing;
                }
                Phase::Finishing | Phase::Done => {
                    self.phase = Phase::Done;
                    return Ok(Progress::Idle(out));
                }
            }
        }
    }

    /// Package whatever is ready, stopping at the first unit whose pictures
    /// have to be converted.
    fn advance(&mut self, final_flush: bool, mut out: Vec<Fragment>) -> Result<Progress> {
        while let Some(ready) = self.take_ready(final_flush)? {
            let VideoPipeline::Transcode(transcoder) = &mut self.video else {
                // Passthrough codes nothing, so there is never anything to wait
                // for and the unit goes out as it stands.
                self.finish_gop(ready, None, &mut out)?;
                continue;
            };
            let jobs = transcoder.begin(&ready.gop.data)?;
            self.converting = Some(ready);
            return Ok(Progress::Pending {
                fragments: out,
                jobs,
            });
        }
        Ok(Progress::Idle(out))
    }

    fn expect_nothing_in_flight(&self) -> Result<()> {
        if self.converting.is_some() {
            bail!("pictures from the previous unit have not been handed back");
        }
        Ok(())
    }

    fn consume_elementary(
        &mut self,
        packets: Vec<ElementaryPacket>,
        out: &mut Vec<Fragment>,
    ) -> Result<()> {
        for packet in packets {
            self.ingest_packet(packet, out)?;
            self.flush_pending(false, out)?;
        }
        Ok(())
    }

    fn ingest_packet(&mut self, packet: ElementaryPacket, out: &mut Vec<Fragment>) -> Result<()> {
        {
            match packet.kind {
                ElementaryKind::Video => {
                    let units = self.gops.push(&packet.data, packet.pts);
                    self.pending_gops.extend(units);
                }
                ElementaryKind::Audio => {
                    if self.audio_start_pts.is_none() {
                        self.audio_start_pts = packet.pts;
                    }
                    let mut frames = self.adts.push(&packet.data)?;
                    if self.audio_config.is_none() {
                        self.audio_config = frames.first().map(|frame| frame.config.clone());
                    }
                    self.conceal_audio_gap(packet.pts, &mut frames);
                    self.pending_audio.extend(frames);
                }
                ElementaryKind::PrivateStream1 | ElementaryKind::PrivateStream2 => {
                    out.push(Fragment::PrivateStream {
                        stream_id: if packet.kind == ElementaryKind::PrivateStream1 {
                            0xbd
                        } else {
                            0xbf
                        },
                        pid: packet.pid,
                        data: packet.data,
                        pts: packet.pts,
                    });
                }
            }
        }
        Ok(())
    }

    /// Fill a small PTS hole with copies of the next decodable access unit.
    /// Without this, one lost AAC frame leaves every later GOP one frame short
    /// of `wanted`, so conversion waits forever even though audio resumed.
    fn conceal_audio_gap(&mut self, pts: Option<u64>, frames: &mut Vec<AacFrame>) {
        let Some(first) = frames.first().cloned() else {
            return;
        };
        let rate = first.config.sample_rate;
        let Some(pts) = pts else {
            self.audio_clock_frames += frames.len() as u64;
            return;
        };
        if self.audio_clock_sample_rate != Some(rate) || self.audio_clock_start_pts.is_none() {
            self.audio_clock_start_pts = Some(pts);
            self.audio_clock_frames = 0;
            self.audio_clock_sample_rate = Some(rate);
        }
        let elapsed = ticks_since(self.audio_clock_start_pts.unwrap() as i64, pts as i64) as i64;
        let expected = aac_frame_count_through_video_time(elapsed, rate).max(0) as u64;
        let missing = expected.saturating_sub(self.audio_clock_frames);
        if missing <= MAX_CONCEALED_AUDIO_FRAMES {
            frames.splice(0..0, std::iter::repeat(first).take(missing as usize));
        }
        self.audio_clock_frames += frames.len() as u64;
    }

    /// Whether the fragment about to be emitted opens at an IDR. Periodic
    /// recovery points deliberately do not count: they retain the prior DPB so
    /// an open GOP's leading B pictures remain codeable.
    fn starts_at_idr(&self) -> bool {
        self.video.awaiting_random_access()
    }

    /// Work out what one unit turns into, on whichever path this session is on.
    ///
    /// Nothing is decoded to get here, so this assumes every picture with a
    /// slice in it will convert. That is what the audio pairing below is
    /// measured against; a unit that turns out to hold a damaged picture is
    /// drawn again by [`Self::package`] once the transcoder has said so.
    fn plan_unit(&self, data: &[u8], starts_at_idr: bool) -> Result<UnitPlan> {
        self.plan_unit_without(data, starts_at_idr, &[])
    }

    /// The same, told which source pictures would not decode.
    fn plan_unit_without(
        &self,
        data: &[u8],
        starts_at_idr: bool,
        undecodable: &[bool],
    ) -> Result<UnitPlan> {
        let mut plan = match self.video {
            VideoPipeline::Transcode(_) => {
                UnitPlan::Transcode(mpeg2_video_timeline(data, !starts_at_idr, undecodable)?)
            }
            VideoPipeline::Passthrough { .. } => {
                UnitPlan::Passthrough(mpeg2_passthrough_unit(data, !starts_at_idr)?)
            }
        };
        // Only the pipeline knows how many samples a field pair became, and the
        // timeline has to reserve one for each.
        plan.timeline_mut().split_field_samples = self.video.split_field_samples();
        Ok(plan)
    }

    fn is_random_access_point(&self) -> bool {
        self.recovery_point_gop_interval != 0
            && self.gops_emitted > 0
            && self.gops_emitted % self.recovery_point_gop_interval == 0
    }

    fn flush_pending(&mut self, final_flush: bool, out: &mut Vec<Fragment>) -> Result<()> {
        while let Some(ready) = self.take_ready(final_flush)? {
            self.finish_gop(ready, None, out)?;
        }
        Ok(())
    }

    /// Take the next unit that can go out, with the audio that belongs beside
    /// it, or nothing when it is still waiting on either.
    ///
    /// Everything that decides whether a unit goes happens here, and nothing
    /// that decides it happens after: what comes back is committed to, and the
    /// only thing left is to convert its video and package it.
    fn take_ready(&mut self, final_flush: bool) -> Result<Option<Ready>> {
        if !self.demuxer.has_aac_audio() {
            if self.pending_gops.is_empty() {
                return Ok(None);
            }
            let gop = self.pending_gops.remove(0);
            return Ok(Some(self.commit(gop, Vec::new(), None)?));
        }
        // Keep one GOP pending so all AAC packets up to the next GOP boundary
        // can share the same moof. MSE implementations then see both trafs per
        // fragment.
        let keep = usize::from(!final_flush);
        if self.pending_gops.len() <= keep {
            return Ok(None);
        }
        let Some(config) = self.audio_config.clone() else {
            return Ok(None);
        };
        if !final_flush && self.pending_audio.is_empty() {
            return Ok(None);
        }
        let gop = self.pending_gops[0].clone();
        let starts_at_idr = self.starts_at_idr();
        let plan = self.plan_unit(&gop.data, starts_at_idr)?;
        self.align_timelines(&gop, plan.timeline());
        let video_duration = mpeg2_fragment_duration(plan.timeline(), plan.lead_in(starts_at_idr));
        // Audio is measured from where the audio track itself starts, not
        // from where the video does.
        let through = (self.video_presentation_start + video_duration) as i64
            - self.audio_origin_ticks as i64;
        let desired = aac_frame_count_through_video_time(through, config.sample_rate);
        let wanted = (desired - self.audio_frames_emitted as i64).max(0) as usize;
        if !final_flush && self.pending_audio.len() < wanted {
            return Ok(None);
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
        Ok(Some(self.commit(gop, frames, Some(plan))?))
    }

    /// Settle what a unit that is going out will be: whether it carries a
    /// restart point, and so what its plan is.
    fn commit(
        &mut self,
        gop: Mpeg2Gop,
        audio: Vec<AacFrame>,
        plan: Option<UnitPlan>,
    ) -> Result<Ready> {
        if self.is_random_access_point() {
            self.video.request_recovery_point();
        }
        let starts_at_idr = self.video.awaiting_random_access();
        let plan = match plan {
            Some(plan) => plan,
            None => self.plan_unit(&gop.data, starts_at_idr)?,
        };
        Ok(Ready {
            gop,
            audio,
            plan,
            starts_at_idr,
        })
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

    /// Package a committed unit and hand its fragment out.
    ///
    /// `h264` is the video already converted, for a caller that converted it
    /// somewhere else; `None` converts it here.
    fn finish_gop(
        &mut self,
        ready: Ready,
        h264: Option<TranscodeResult>,
        out: &mut Vec<Fragment>,
    ) -> Result<()> {
        let Ready {
            gop,
            audio: audio_frames,
            plan,
            starts_at_idr,
        } = ready;
        let gop = &gop;
        // Aligning can still move the origin, so read the start after it.
        self.align_timelines(gop, plan.timeline());
        let start = self.video_presentation_start as f64 / TIMESCALE as f64;
        let interlacing = plan.timeline().interlacing;

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
        let (fragment, recovery_point) = self.package(
            gop,
            &plan,
            starts_at_idr,
            config.as_ref(),
            audio_track.as_ref(),
            h264,
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
            random_access: starts_at_idr || recovery_point,
            video_samples: fragment.sample_count,
            audio_samples: audio_frames.len(),
            interlacing,
        });
        Ok(())
    }

    /// Turn one unit into a fragment, by whichever path this session is on,
    /// and say whether a decoder can be started on it.
    fn package(
        &mut self,
        gop: &Mpeg2Gop,
        plan: &UnitPlan,
        starts_at_idr: bool,
        audio: Option<&AacConfig>,
        audio_track: Option<&Fmp4AudioSamples>,
        converted: Option<TranscodeResult>,
    ) -> Result<(Fmp4Fragment, bool)> {
        match (&mut self.video, plan) {
            (VideoPipeline::Transcode(transcoder), UnitPlan::Transcode(timeline)) => {
                let h264 = match converted {
                    Some(h264) => h264,
                    None => transcoder.push(&gop.data)?,
                };
                // The plan reached this unit without decoding a slice, so it
                // reserved a sample for every picture that had one. A picture
                // that then would not decode leaves a sample with no access
                // unit behind it, and only the transcoder can say which. Draw
                // the unit again knowing that, which is the one case where the
                // timeline is worth walking twice.
                let redrawn = if h264.undecodable.iter().any(|&damaged| damaged) {
                    Some(self.plan_unit_without(&gop.data, starts_at_idr, &h264.undecodable)?)
                } else {
                    None
                };
                let timeline = match &redrawn {
                    Some(redrawn) => redrawn.timeline(),
                    None => timeline,
                };
                let fragment = h264_gop_to_fmp4(
                    &h264.bitstream,
                    timeline,
                    self.sequence_number,
                    self.video_presentation_start,
                    audio,
                    audio_track,
                )?;
                Ok((fragment, h264.recovery_point))
            }
            (
                VideoPipeline::Passthrough {
                    awaiting_intra,
                    recovery_pending,
                    ..
                },
                UnitPlan::Passthrough(unit),
            ) => {
                // A unit yields samples only once a picture a decoder can
                // begin at has arrived, which is what this was waiting for.
                *awaiting_intra &= unit.samples.is_empty();
                // An MPEG-2 intra picture needs nothing coded around it to be
                // a recovery point, so a restart is due exactly when one was
                // asked for and the unit opens with one.
                let opens_at_intra = unit.samples.first().is_some_and(|sample| sample.sync);
                let recovery_point = *recovery_pending && opens_at_intra;
                *recovery_pending &= !recovery_point;
                let fragment = mpeg2_gop_to_fmp4(
                    &gop.data,
                    unit,
                    self.sequence_number,
                    self.video_presentation_start,
                    plan.lead_in(starts_at_idr),
                    starts_at_idr || recovery_point,
                    // Every unit opens with a sequence header, so unlike the
                    // transcoded path nothing in the unit itself says which one
                    // the initialization segment should be built from.
                    !self.initialized,
                    audio,
                    audio_track,
                )?;
                Ok((fragment, recovery_point))
            }
            // The pipeline is chosen once, at construction, and the plan is
            // made by it.
            _ => unreachable!("the unit plan matches the pipeline that made it"),
        }
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new(TranscodeOptions::default())
    }
}
