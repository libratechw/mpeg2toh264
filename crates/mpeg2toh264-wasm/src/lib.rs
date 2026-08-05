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
    #[wasm_bindgen(constructor)]
    pub fn new(oversample: Option<f64>, origin_ticks: Option<f64>) -> Result<Session, JsError> {
        let defaults = TranscodeOptions::default();
        let oversample = oversample.unwrap_or(defaults.oversample);
        if !oversample.is_finite() || oversample <= 0.0 {
            return Err(JsError::new("oversample must be a positive number"));
        }
        let origin = match origin_ticks {
            Some(ticks) if !ticks.is_finite() || ticks < 0.0 => {
                return Err(JsError::new("originTicks must be a timestamp"))
            }
            Some(ticks) => Some(ticks as u64),
            None => None,
        };
        Ok(Self {
            inner: mpeg2toh264::Session::anchored(
                TranscodeOptions {
                    oversample,
                    ..defaults
                },
                origin,
            ),
        })
    }

    /// The PES timestamp presentation time zero stands for, once the first
    /// fragment has fixed it, and `undefined` until then.
    #[wasm_bindgen(getter, js_name = originTicks)]
    pub fn origin_ticks(&self) -> Option<f64> {
        self.inner.origin_ticks().map(|ticks| ticks as f64)
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
        } => {
            set(&object, "kind", &"media".into())?;
            set(&object, "data", &copy_out(&data))?;
            set(&object, "start", &start.into())?;
            set(&object, "randomAccess", &random_access.into())?;
            set(&object, "videoSamples", &(video_samples as f64).into())?;
            set(&object, "audioSamples", &(audio_samples as f64).into())?;
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
