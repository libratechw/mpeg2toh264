//! WebAssembly bindings for the streaming transcoder.
//!
//! This is a translation layer and nothing else: the pipeline, and in
//! particular the timeline arithmetic that decides where each fragment sits,
//! lives in [`mpeg2toh264::Session`] where it can be tested without a browser.
//! What is here turns Rust values into the shapes JavaScript expects.

use js_sys::{Array, Object, Reflect, Uint8Array};
use mpeg2toh264::job::PictureOutput;
use mpeg2toh264::{DualMono, Fragment, Progress, TranscodeOptions, VideoMode};
use wasm_bindgen::prelude::*;

/// The shape of what [`Session::push`] returns, declared so the browser sources
/// get something better than `any[]` to typecheck against.
#[wasm_bindgen(typescript_custom_section)]
const FRAGMENT_TYPESCRIPT: &str = r#"
/** One thing to hand to Media Source Extensions. */
export type Fragment =
  | {
      /**
       * An initialization segment, which comes before the media it describes.
       * Normally the only one; a stream that changes its frame size, its field
       * coding or its aspect ratio sends another, and the `SourceBuffer` takes
       * it in the same order as everything else.
       */
      kind: "init";
      data: Uint8Array;
      /** What to open the SourceBuffer with. */
      mimeCodec: string;
    }
  | {
      kind: "media";
      data: Uint8Array;
      /** Where this fragment starts on the presentation timeline, in seconds. */
      start: number;
      /** Whether a decoder can begin here, which is where eviction may stop. */
      randomAccess: boolean;
      videoSamples: number;
      audioSamples: number;
      /**
       * Whether the source pictures of this fragment hold two moments each.
       * Nothing downstream can work this out: the H.264 is decoded into
       * frames, and a frame of two moments looks like a frame of one.
       */
      interlaced: boolean;
      /** Which of the two came first. Only meaningful with `interlaced`. */
      topFieldFirst: boolean;
    }
  | {
      kind: "private-stream";
      /** PES stream_id: 0xbd (private_stream_1) or 0xbf (private_stream_2). */
      streamId: number;
      pid: number;
      data: Uint8Array;
      /** Absolute 90 kHz timestamp, or null when no media clock is available. */
      pts: number | null;
    };

/**
 * How far a session got, for a caller converting the pictures itself.
 *
 * `jobs` is one opaque buffer per picture. Hand each to `PictureEncoder.encode`
 * -- here, or in as many workers as there are to spare -- and give the results
 * back to `Session.complete` in the same order. Until then the session produces
 * nothing further.
 */
export type Progress = {
  fragments: Fragment[];
  /** Empty when nothing is owed. */
  jobs: Uint8Array[];
};

/**
 * One sound stream a service offers, as its program map describes it.
 *
 * All of it comes from the map, so the choice can be offered before a byte of
 * any of these streams has been read.
 */
export type AudioStream = {
  /** Elementary stream PID, which is what `selectAudio` takes. */
  pid: number;
  /**
   * The ARIB stream identifier's component tag. A broadcast names its main
   * sound 0x10 and the ones beside it 0x11 upwards, which is all that
   * distinguishes them where the languages are the same.
   */
  componentTag: number | null;
  /**
   * Whether the stream's two channels are two separate services rather than a
   * stereo pair. Choosing between those is `selectDualMono`, not this: they
   * are one stream.
   */
  dualMono: boolean;
  /**
   * The languages the descriptors name, in the order they name them, as ISO
   * 639 codes. Dual mono carries the second service's language second.
   */
  languages: string[];
};
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Fragment[]")]
    pub type FragmentArray;
    #[wasm_bindgen(typescript_type = "Progress")]
    pub type ProgressObject;
    #[wasm_bindgen(typescript_type = "AudioStream[]")]
    pub type AudioStreamArray;
}

/// Streaming transcode of one transport stream.
///
/// Feed it the file in slices and append what comes back:
///
/// ```js
/// const session = new Session();
/// for (const fragment of session.push(chunk)) append(fragment);
/// for (const fragment of session.finish()) append(fragment);
/// ```
///
/// A slice that completes no fragment returns an empty array, which is normal.
///
/// Each fragment is a plain object, so there is nothing to free:
///
/// - `kind` -- `"init"` for an initialization segment, which comes before the
///   media it describes, or `"media"` for the media itself. There is normally
///   one init fragment; a stream that changes what its sequence header says
///   sends another, and it is appended in the order it arrives.
/// - `data` -- the bytes to append. Its `ArrayBuffer` is the worker's own, so
///   it can be transferred to the page rather than copied again.
/// - `mimeCodec` -- what to open the `SourceBuffer` with. Init fragments only.
/// - `start` -- where the fragment sits on the presentation timeline, in
///   seconds. Media fragments only.
/// - `randomAccess` -- whether a decoder can begin here. A player needs this,
///   with `start`, to evict buffered media without cutting into what is about
///   to play. Media fragments only.
/// - `videoSamples`, `audioSamples` -- how many of each the fragment carries.
#[wasm_bindgen]
pub struct Session {
    inner: mpeg2toh264::Session,
}

#[wasm_bindgen]
impl Session {
    /// Start a session. `oversample` is the quantiser search factor, and
    /// `undefined` takes the default of 2.
    ///
    /// `originTicks` measures the timeline from a PES timestamp of the
    /// caller's choosing rather than from wherever this input opens, which is
    /// what makes a stream starting mid-file appendable at the time it really
    /// holds. Pass the `originTicks` an earlier session reported.
    ///
    /// `serviceId` takes one named service out of a transport stream that
    /// carries several. `undefined` takes the first that turns up with a
    /// picture in it. See `serviceIds` for what a recording is offering.
    ///
    /// `splitFieldSamples` gives each field of a complementary pair its own MP4
    /// sample, working around decoders that freeze on field pictures.
    /// `undefined` leaves the pair in one sample, which is what more decoders
    /// accept.
    ///
    /// `passthrough` carries the MPEG-2 video into the MP4 as it stands
    /// instead of converting it, for a browser whose decoder takes MPEG-2.
    /// Nothing is requantised, so the picture is the broadcast's own and the
    /// conversion costs almost nothing -- but a browser that does not decode
    /// MPEG-2 plays none of it. Ask `MediaSource.isTypeSupported` with the
    /// `mimeCodec` the init fragment reports before relying on it.
    #[wasm_bindgen(constructor)]
    pub fn new(
        oversample: Option<f64>,
        origin_ticks: Option<f64>,
        service_id: Option<u16>,
        recovery_interval: Option<u32>,
        split_field_samples: Option<bool>,
        passthrough: Option<bool>,
    ) -> Result<Session, JsError> {
        let defaults = TranscodeOptions::default();
        let oversample = oversample.unwrap_or(defaults.oversample);
        if !oversample.is_finite() || oversample <= 0.0 {
            return Err(JsError::new("oversample must be a positive number"));
        }
        let recovery_interval = recovery_interval.unwrap_or(defaults.recovery_interval as u32);
        if recovery_interval == 0 {
            return Err(JsError::new("recoveryInterval must be a positive integer"));
        }
        let origin = match origin_ticks {
            Some(ticks) if !ticks.is_finite() || ticks < 0.0 => {
                return Err(JsError::new("originTicks must be a timestamp"))
            }
            Some(ticks) => Some(ticks as u64),
            None => None,
        };
        Ok(Self {
            inner: mpeg2toh264::Session::for_service(
                TranscodeOptions {
                    oversample,
                    recovery_interval: recovery_interval as usize,
                    split_field_samples: split_field_samples
                        .unwrap_or(defaults.split_field_samples),
                    video: if passthrough.unwrap_or(false) {
                        VideoMode::Passthrough
                    } else {
                        VideoMode::Transcode
                    },
                },
                origin,
                service_id,
            ),
        })
    }

    /// The service the fragments are being made from, once a program map has
    /// named it, and `undefined` until then.
    #[wasm_bindgen(getter, js_name = serviceId)]
    pub fn service_id(&self) -> Option<u16> {
        self.inner.service_id()
    }

    /// Every service this transport stream has announced, in the order it
    /// announced them. Empty until the program association table arrives.
    #[wasm_bindgen(getter, js_name = serviceIds)]
    pub fn service_ids(&self) -> Vec<u16> {
        self.inner.service_ids().to_vec()
    }

    /// Every sound stream the chosen service offers, in the order its program
    /// map lists them. Empty until that map arrives.
    #[wasm_bindgen(getter, js_name = audioStreams)]
    pub fn audio_streams(&self) -> Result<AudioStreamArray, JsError> {
        let array = Array::new();
        for stream in self.inner.audio_streams() {
            let object = Object::new();
            set(&object, "pid", &(stream.pid as f64).into())?;
            set(
                &object,
                "componentTag",
                &stream
                    .component_tag
                    .map_or(JsValue::NULL, |tag| (tag as f64).into()),
            )?;
            set(&object, "dualMono", &stream.dual_mono.into())?;
            let languages = Array::new();
            for language in &stream.languages {
                languages.push(&JsValue::from_str(language));
            }
            set(&object, "languages", &languages.into())?;
            array.push(&object);
        }
        Ok(JsValue::from(array).unchecked_into())
    }

    /// Which of them the fragments are being made from, and `undefined` before
    /// the program map has named one.
    #[wasm_bindgen(getter, js_name = audioPid)]
    pub fn audio_pid(&self) -> Option<u16> {
        self.inner.audio_pid()
    }

    /// Take the sound from another of the service's streams from here on.
    ///
    /// Only from here on: the fragments already made carry the sound that was
    /// chosen when they were made and have been appended, so nothing goes back
    /// over them. Where the two streams are described differently -- a
    /// commentary in stereo beside a programme in 5.1 -- the fragment the
    /// change lands in carries an initialization segment of its own, exactly as
    /// a programme boundary that changes the sound does.
    #[wasm_bindgen(js_name = selectAudio)]
    pub fn select_audio(&mut self, pid: u16) {
        self.inner.select_audio(pid);
    }

    /// Whether the sound being read carries two services in one stream rather
    /// than a stereo pair, as the frames read so far had it.
    ///
    /// `audioStreams` says so too, from the program map, and says it before a
    /// frame has arrived. This is the stream itself, which is what a broadcast
    /// that turns dual mono on within a programme leaves the map disagreeing
    /// with.
    #[wasm_bindgen(getter, js_name = audioIsDualMono)]
    pub fn audio_is_dual_mono(&self) -> bool {
        self.inner.audio_is_dual_mono()
    }

    /// Take the sound of a dual-mono stream from the second service rather than
    /// the first, from here on.
    ///
    /// Both are rebuilt into the same two-channel configuration, so nothing is
    /// described anew and the frames on either side of the change play one
    /// after the other. A stream with one service in it is unaffected.
    #[wasm_bindgen(js_name = selectDualMono)]
    pub fn select_dual_mono(&mut self, sub: bool) {
        self.inner
            .select_dual_mono(if sub { DualMono::Sub } else { DualMono::Main });
    }

    /// The PES timestamp presentation time zero stands for, once the first
    /// fragment has fixed it, and `undefined` until then.
    #[wasm_bindgen(getter, js_name = originTicks)]
    pub fn origin_ticks(&self) -> Option<f64> {
        self.inner.origin_ticks().map(|ticks| ticks as f64)
    }

    #[wasm_bindgen(getter)]
    pub fn dropped(&self) -> f64 {
        self.inner.dropped() as f64
    }

    #[wasm_bindgen(getter)]
    pub fn scrambled(&self) -> f64 {
        self.inner.scrambled() as f64
    }

    #[wasm_bindgen(getter)]
    pub fn errors(&self) -> f64 {
        self.inner.errors() as f64
    }

    /// Feed the next slice of the transport stream.
    pub fn push(&mut self, chunk: &[u8]) -> Result<FragmentArray, JsError> {
        to_js_array(self.inner.push(chunk).map_err(to_js_error)?)
    }

    /// Flush everything held back, at end of input.
    pub fn finish(&mut self) -> Result<FragmentArray, JsError> {
        to_js_array(self.inner.finish().map_err(to_js_error)?)
    }

    /// [`Session::push`], for a caller that converts the pictures itself.
    ///
    /// Stops at the first unit whose video has to be coded and hands its
    /// pictures back as `jobs`. Nothing more comes out of the session until
    /// those are returned to `complete`.
    #[wasm_bindgen(js_name = pushDeferred)]
    pub fn push_deferred(&mut self, chunk: &[u8]) -> Result<ProgressObject, JsError> {
        to_js_progress(self.inner.push_deferred(chunk).map_err(to_js_error)?)
    }

    /// [`Session::finish`], for the same caller. Call it until `jobs` is empty.
    #[wasm_bindgen(js_name = finishDeferred)]
    pub fn finish_deferred(&mut self) -> Result<ProgressObject, JsError> {
        to_js_progress(self.inner.finish_deferred().map_err(to_js_error)?)
    }

    /// Hand back one converted picture per job, in the order they were given
    /// out, and carry on.
    pub fn complete(&mut self, outputs: Vec<Uint8Array>) -> Result<ProgressObject, JsError> {
        let outputs: Result<Vec<PictureOutput>, JsError> = outputs
            .iter()
            .map(|output| PictureOutput::decode(&output.to_vec()).map_err(to_js_error))
            .collect();
        to_js_progress(self.inner.complete(&outputs?).map_err(to_js_error)?)
    }
}

/// Converts one picture at a time, and nothing else.
///
/// This is what a picture worker holds. It knows nothing of the stream around
/// it -- everything a picture is coded against arrives with it -- so a pool of
/// these, each in its own worker and so its own WebAssembly instance, converts
/// a unit's pictures at the same time without sharing any memory.
///
/// ```js
/// const encoder = new PictureEncoder();
/// self.onmessage = ({ data: job }) => {
///   const output = encoder.encode(job);
///   self.postMessage(output, [output.buffer]);
/// };
/// ```
///
/// Keep one for as long as the worker lives: what it holds between pictures is
/// several megabytes of scratch at an HD macroblock count, and asking the
/// allocator for that per picture costs more than the coding does.
#[wasm_bindgen]
pub struct PictureEncoder {
    inner: mpeg2toh264::PictureEncoder,
}

#[wasm_bindgen]
impl PictureEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: mpeg2toh264::PictureEncoder::new(),
        }
    }

    /// Convert one of the jobs a `Progress` handed out. The result is opaque
    /// and goes straight back to `Session.complete`; a picture whose slices
    /// will not decode comes back as a result saying so rather than as an
    /// error, because that is a fact about the source and not a failure here.
    pub fn encode(&mut self, job: &[u8]) -> Result<Uint8Array, JsError> {
        let output = self.inner.encode(job).map_err(to_js_error)?;
        Ok(Uint8Array::from(output.encode().as_slice()))
    }
}

impl Default for PictureEncoder {
    fn default() -> Self {
        Self::new()
    }
}

/// The last presentation timestamp in a slice of transport stream, in 90 kHz
/// units, or `undefined` when it carries none.
///
/// Handed the tail of a file, this is how long the file is: the distance from
/// the `originTicks` a [`Session`] reported to what comes back here is the
/// duration a player can put on its timeline.
#[wasm_bindgen(js_name = lastTimestamp)]
pub fn last_timestamp(data: &[u8]) -> Option<f64> {
    mpeg2toh264::last_pts(data).map(|ticks| ticks as f64)
}

/// The first presentation timestamp in a slice of transport stream, in 90 kHz
/// units, or `undefined` when it carries none.
///
/// This is what time it is at the byte the slice was read from. A player
/// seeking in a file with no index asks this of a slice at the byte its
/// estimate points to, and asks again nearer the mark, which costs a hundred
/// kilobytes where transcoding to find out costs seconds of video.
#[wasm_bindgen(js_name = firstTimestamp)]
pub fn first_timestamp(data: &[u8]) -> Option<f64> {
    mpeg2toh264::first_pts(data).map(|ticks| ticks as f64)
}

fn to_js_progress(progress: Progress) -> Result<ProgressObject, JsError> {
    let (fragments, jobs) = match progress {
        Progress::Idle(fragments) => (fragments, Vec::new()),
        Progress::Pending { fragments, jobs } => (fragments, jobs),
    };
    let object = Object::new();
    set(&object, "fragments", &to_js_array(fragments)?.into())?;
    let array = Array::new_with_length(jobs.len() as u32);
    for (index, job) in jobs.iter().enumerate() {
        array.set(index as u32, copy_out(job));
    }
    set(&object, "jobs", &array.into())?;
    Ok(JsValue::from(object).unchecked_into())
}

fn to_js_array(fragments: Vec<Fragment>) -> Result<FragmentArray, JsError> {
    let array = Array::new_with_length(fragments.len() as u32);
    for (index, fragment) in fragments.into_iter().enumerate() {
        array.set(index as u32, to_js_fragment(fragment)?);
    }
    Ok(JsValue::from(array).unchecked_into())
}

fn to_js_fragment(fragment: Fragment) -> Result<JsValue, JsError> {
    let object = Object::new();
    match fragment {
        Fragment::Init { data, mime_codec } => {
            set(&object, "kind", &"init".into())?;
            set(&object, "data", &copy_out(&data))?;
            set(&object, "mimeCodec", &mime_codec.into())?;
        }
        Fragment::Media {
            data,
            start,
            random_access,
            video_samples,
            audio_samples,
            interlacing,
        } => {
            set(&object, "kind", &"media".into())?;
            set(&object, "data", &copy_out(&data))?;
            set(&object, "start", &start.into())?;
            set(&object, "randomAccess", &random_access.into())?;
            set(&object, "videoSamples", &(video_samples as f64).into())?;
            set(&object, "audioSamples", &(audio_samples as f64).into())?;
            set(&object, "interlaced", &interlacing.interlaced.into())?;
            set(
                &object,
                "topFieldFirst",
                &interlacing.top_field_first.into(),
            )?;
        }
        Fragment::PrivateStream {
            stream_id,
            pid,
            data,
            pts,
        } => {
            set(&object, "kind", &"private-stream".into())?;
            set(&object, "streamId", &(stream_id as f64).into())?;
            set(&object, "pid", &(pid as f64).into())?;
            set(&object, "data", &copy_out(&data))?;
            set(
                &object,
                "pts",
                &pts.map_or(JsValue::NULL, |ticks| (ticks as f64).into()),
            )?;
        }
    }
    Ok(object.into())
}

/// Copy the bytes into a JavaScript-owned buffer.
///
/// A view into the WebAssembly heap would be cheaper, but it would also be
/// invalidated by the next allocation and could not be transferred to the page.
/// The copy is what makes the result an ordinary `Uint8Array`.
fn copy_out(data: &[u8]) -> JsValue {
    Uint8Array::from(data).into()
}

fn set(object: &Object, key: &str, value: &JsValue) -> Result<(), JsError> {
    Reflect::set(object, &key.into(), value)
        .map(|_| ())
        .map_err(|_| JsError::new("could not build the fragment object"))
}

/// Every failure here is "this stream is not something we can handle", so the
/// message is the whole of what a caller can act on.
fn to_js_error(error: mpeg2toh264::Error) -> JsError {
    JsError::new(&error.to_string())
}
