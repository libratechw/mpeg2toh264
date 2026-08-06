//! WebAssembly bindings for the streaming transcoder.
//!
//! This is a translation layer and nothing else: the pipeline, and in
//! particular the timeline arithmetic that decides where each fragment sits,
//! lives in [`mpeg2toh264::Session`] where it can be tested without a browser.
//! What is here turns Rust values into the shapes JavaScript expects.

use js_sys::{Array, Object, Reflect, Uint8Array};
use mpeg2toh264::{Fragment, TranscodeOptions};
use wasm_bindgen::prelude::*;

/// The shape of what [`Session::push`] returns, declared so the browser sources
/// get something better than `any[]` to typecheck against.
#[wasm_bindgen(typescript_custom_section)]
const FRAGMENT_TYPESCRIPT: &str = r#"
/** One thing to hand to Media Source Extensions. */
export type Fragment =
  | {
      /** The initialization segment, which arrives once and before any media. */
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
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Fragment[]")]
    pub type FragmentArray;
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
/// - `kind` -- `"init"` for the initialization segment, which arrives once and
///   before any media, or `"media"` for everything after.
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
    #[wasm_bindgen(constructor)]
    pub fn new(
        oversample: Option<f64>,
        origin_ticks: Option<f64>,
        service_id: Option<u16>,
        recovery_interval: Option<u32>,
        split_field_samples: Option<bool>,
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
