/**
 * MPEG-2 (H.262) header layer parsing: everything above the macroblock.
 *
 * The output of this pass is what the H.264 side needs to build its SPS/PPS and
 * slice headers, plus the byte ranges of the slices whose macroblock layer will
 * be re-entropy-coded.
 */
import { BitReader, findStartCodes } from "../bitreader.ts";
import {
  ALTERNATE_SCAN,
  ChromaFormat,
  DEFAULT_INTRA_QUANT,
  DEFAULT_NON_INTRA_QUANT,
  EXT,
  PictureStructure,
  PictureType,
  SC,
  ZIGZAG_SCAN,
  type PictureTypeValue,
} from "./constants.ts";

export interface SequenceHeader {
  horizontalSize: number;
  verticalSize: number;
  aspectRatioInformation: number;
  frameRateCode: number;
  bitRateValue: number;
  vbvBufferSizeValue: number;
  constrainedParametersFlag: boolean;
}

export interface SequenceExtension {
  profileAndLevel: number;
  progressiveSequence: boolean;
  chromaFormat: number;
  bitRateExtension: number;
  vbvBufferSizeExtension: number;
  lowDelay: boolean;
  frameRateExtensionN: number;
  frameRateExtensionD: number;
}

/** All four quantiser matrices, held in raster order. */
export interface QuantMatrices {
  intra: number[];
  nonIntra: number[];
  chromaIntra: number[];
  chromaNonIntra: number[];
}

export interface PictureHeader {
  temporalReference: number;
  pictureCodingType: PictureTypeValue;
  vbvDelay: number;
  /** Present for P and B pictures; MPEG-1 style whole-pel MV flag. */
  fullPelForwardVector: boolean;
  forwardFCode: number;
  fullPelBackwardVector: boolean;
  backwardFCode: number;
}

export interface PictureCodingExtension {
  /** f_code[r][s]: r = 0 forward / 1 backward, s = 0 horizontal / 1 vertical. */
  fCode: [[number, number], [number, number]];
  intraDcPrecision: number;
  pictureStructure: number;
  topFieldFirst: boolean;
  framePredFrameDct: boolean;
  concealmentMotionVectors: boolean;
  qScaleType: number;
  intraVlcFormat: number;
  alternateScan: boolean;
  repeatFirstField: boolean;
  chroma420Type: boolean;
  progressiveFrame: boolean;
}

export interface Slice {
  /** slice_vertical_position, i.e. the macroblock row this slice starts in (1-based). */
  verticalPosition: number;
  quantiserScaleCode: number;
  /** Bit offset of the first macroblock() in the stream buffer. */
  dataStartBit: number;
  /** Bit offset one past the last macroblock (start of the next start code). */
  dataEndBit: number;
}

export interface Picture {
  header: PictureHeader;
  coding: PictureCodingExtension;
  /** Sequence state in effect for this picture. */
  sequence: SequenceHeader;
  sequenceExt: SequenceExtension;
  quant: QuantMatrices;
  slices: Slice[];
}

/** Derived, ready-to-use view of the picture geometry. */
export function pictureGeometry(pic: Picture) {
  const width = pic.sequence.horizontalSize;
  const height = pic.sequence.verticalSize;
  const mbWidth = (width + 15) >> 4;
  // Field pictures code half the macroblock rows.
  const frameMbHeight = (height + 15) >> 4;
  const isFieldPicture = pic.coding.pictureStructure !== PictureStructure.FRAME;
  const mbHeight = isFieldPicture ? (height + 31) >> 5 : frameMbHeight;
  return { width, height, mbWidth, mbHeight, frameMbHeight, isFieldPicture };
}

export function scanTable(pic: Picture): readonly number[] {
  return pic.coding.alternateScan ? ALTERNATE_SCAN : ZIGZAG_SCAN;
}

function defaultQuantMatrices(): QuantMatrices {
  return {
    intra: [...DEFAULT_INTRA_QUANT],
    nonIntra: [...DEFAULT_NON_INTRA_QUANT],
    chromaIntra: [...DEFAULT_INTRA_QUANT],
    chromaNonIntra: [...DEFAULT_NON_INTRA_QUANT],
  };
}

/** Quantiser matrices are transmitted in scan order; store them in raster order. */
function readQuantMatrix(r: BitReader): number[] {
  const m = new Array<number>(64).fill(0);
  for (let i = 0; i < 64; i++) {
    m[ZIGZAG_SCAN[i]!] = r.u(8);
  }
  return m;
}

function readSequenceHeader(r: BitReader): {
  seq: SequenceHeader;
  quant: QuantMatrices;
} {
  const seq: SequenceHeader = {
    horizontalSize: r.u(12),
    verticalSize: r.u(12),
    aspectRatioInformation: r.u(4),
    frameRateCode: r.u(4),
    bitRateValue: r.u(18),
    vbvBufferSizeValue: (r.marker(), r.u(10)),
    constrainedParametersFlag: r.flag(),
  };
  // A sequence header always resets the matrices: any not loaded here revert to
  // the defaults (clause 6.3.11).
  const quant = defaultQuantMatrices();
  if (r.flag()) {
    quant.intra = readQuantMatrix(r);
    quant.chromaIntra = [...quant.intra];
  }
  if (r.flag()) {
    quant.nonIntra = readQuantMatrix(r);
    quant.chromaNonIntra = [...quant.nonIntra];
  }
  return { seq, quant };
}

function readSequenceExtension(
  r: BitReader,
  seq: SequenceHeader,
): SequenceExtension {
  const profileAndLevel = r.u(8);
  const progressiveSequence = r.flag();
  const chromaFormat = r.u(2);
  const horizontalSizeExtension = r.u(2);
  const verticalSizeExtension = r.u(2);
  const bitRateExtension = r.u(12);
  r.marker();
  const vbvBufferSizeExtension = r.u(8);
  const lowDelay = r.flag();
  const frameRateExtensionN = r.u(2);
  const frameRateExtensionD = r.u(5);

  // The extension carries the top 2 bits of each dimension.
  seq.horizontalSize |= horizontalSizeExtension << 12;
  seq.verticalSize |= verticalSizeExtension << 12;

  return {
    profileAndLevel,
    progressiveSequence,
    chromaFormat,
    bitRateExtension,
    vbvBufferSizeExtension,
    lowDelay,
    frameRateExtensionN,
    frameRateExtensionD,
  };
}

function readQuantMatrixExtension(r: BitReader, quant: QuantMatrices): void {
  if (r.flag()) {
    quant.intra = readQuantMatrix(r);
    quant.chromaIntra = [...quant.intra];
  }
  if (r.flag()) {
    quant.nonIntra = readQuantMatrix(r);
    quant.chromaNonIntra = [...quant.nonIntra];
  }
  if (r.flag()) quant.chromaIntra = readQuantMatrix(r);
  if (r.flag()) quant.chromaNonIntra = readQuantMatrix(r);
}

function readPictureHeader(r: BitReader): PictureHeader {
  const temporalReference = r.u(10);
  const pictureCodingType = r.u(3) as PictureTypeValue;
  const vbvDelay = r.u(16);
  let fullPelForwardVector = false;
  let forwardFCode = 0;
  let fullPelBackwardVector = false;
  let backwardFCode = 0;
  if (
    pictureCodingType === PictureType.P ||
    pictureCodingType === PictureType.B
  ) {
    fullPelForwardVector = r.flag();
    forwardFCode = r.u(3);
  }
  if (pictureCodingType === PictureType.B) {
    fullPelBackwardVector = r.flag();
    backwardFCode = r.u(3);
  }
  while (r.peek(1) === 1) {
    r.skip(1); // extra_bit_picture
    r.skip(8); // extra_information_picture
  }
  r.skip(1); // extra_bit_picture == 0
  return {
    temporalReference,
    pictureCodingType,
    vbvDelay,
    fullPelForwardVector,
    forwardFCode,
    fullPelBackwardVector,
    backwardFCode,
  };
}

function readPictureCodingExtension(r: BitReader): PictureCodingExtension {
  const fCode: [[number, number], [number, number]] = [
    [r.u(4), r.u(4)],
    [r.u(4), r.u(4)],
  ];
  const ext: PictureCodingExtension = {
    fCode,
    intraDcPrecision: r.u(2),
    pictureStructure: r.u(2),
    topFieldFirst: r.flag(),
    framePredFrameDct: r.flag(),
    concealmentMotionVectors: r.flag(),
    qScaleType: r.u(1),
    intraVlcFormat: r.u(1),
    alternateScan: r.flag(),
    repeatFirstField: r.flag(),
    chroma420Type: r.flag(),
    progressiveFrame: r.flag(),
  };
  if (r.flag()) {
    // composite_display_flag
    r.skip(1 + 3 + 1 + 7 + 8);
  }
  return ext;
}

/**
 * Default picture coding extension, for the MPEG-1 style case where a picture
 * carries no extension at all. MPEG-2 streams always have one, but defaulting
 * keeps the picture record total.
 */
function defaultPictureCoding(hdr: PictureHeader): PictureCodingExtension {
  const f = Math.max(1, hdr.forwardFCode);
  const b = Math.max(1, hdr.backwardFCode);
  return {
    fCode: [
      [f, f],
      [b, b],
    ],
    intraDcPrecision: 0,
    pictureStructure: PictureStructure.FRAME,
    topFieldFirst: false,
    framePredFrameDct: true,
    concealmentMotionVectors: false,
    qScaleType: 0,
    intraVlcFormat: 0,
    alternateScan: false,
    repeatFirstField: false,
    chroma420Type: true,
    progressiveFrame: true,
  };
}

/**
 * Parse a full MPEG-2 elementary stream into pictures.
 *
 * Slices are recorded as bit ranges rather than being decoded here: the
 * macroblock layer is re-coded rather than reconstructed, so it is handled by a
 * separate pass that can run per-slice.
 */
export function parseElementaryStream(data: Uint8Array): Picture[] {
  const codes = findStartCodes(data);
  const pictures: Picture[] = [];

  let seq: SequenceHeader | null = null;
  let seqExt: SequenceExtension | null = null;
  let quant = defaultQuantMatrices();
  let current: Picture | null = null;
  let pendingHeader: PictureHeader | null = null;

  const finishSlice = (endBit: number) => {
    const slices = current?.slices;
    const last = slices?.[slices.length - 1];
    if (last && last.dataEndBit === -1) last.dataEndBit = endBit;
  };

  for (let i = 0; i < codes.length; i++) {
    const sc = codes[i]!;
    // A start code terminates whatever slice was in progress.
    finishSlice(sc.offset * 8);

    const r = new BitReader(data, sc.payloadOffset * 8);

    if (sc.code === SC.SEQUENCE_HEADER) {
      const res = readSequenceHeader(r);
      seq = res.seq;
      quant = res.quant;
      seqExt = null;
    } else if (sc.code === SC.EXTENSION) {
      const id = r.u(4);
      if (id === EXT.SEQUENCE && seq) {
        seqExt = readSequenceExtension(r, seq);
      } else if (id === EXT.QUANT_MATRIX) {
        // Applies from the next picture onwards; clone so already-emitted
        // pictures keep the matrices they were coded with.
        quant = {
          intra: [...quant.intra],
          nonIntra: [...quant.nonIntra],
          chromaIntra: [...quant.chromaIntra],
          chromaNonIntra: [...quant.chromaNonIntra],
        };
        readQuantMatrixExtension(r, quant);
        if (current) current.quant = quant;
      } else if (id === EXT.PICTURE_CODING && current) {
        current.coding = readPictureCodingExtension(r);
      }
    } else if (sc.code === SC.PICTURE) {
      if (!seq)
        throw new Error("picture_start_code before any sequence_header");
      pendingHeader = readPictureHeader(r);
      current = {
        header: pendingHeader,
        coding: defaultPictureCoding(pendingHeader),
        sequence: seq,
        sequenceExt: seqExt ?? {
          profileAndLevel: 0,
          progressiveSequence: true,
          chromaFormat: ChromaFormat.C420,
          bitRateExtension: 0,
          vbvBufferSizeExtension: 0,
          lowDelay: false,
          frameRateExtensionN: 0,
          frameRateExtensionD: 0,
        },
        quant,
        slices: [],
      };
      pictures.push(current);
    } else if (sc.code >= SC.SLICE_MIN && sc.code <= SC.SLICE_MAX && current) {
      let verticalPosition = sc.code;
      if (current.sequence.verticalSize > 2800) {
        verticalPosition += r.u(3) << 7; // slice_vertical_position_extension
      }
      const quantiserScaleCode = r.u(5);
      if (r.peek(1) === 1) {
        r.skip(1); // intra_slice_flag
        r.skip(1); // intra_slice
        r.skip(7); // reserved_bits
        while (r.peek(1) === 1) {
          r.skip(1); // extra_bit_slice
          r.skip(8); // extra_information_slice
        }
      }
      r.skip(1); // extra_bit_slice == 0
      current.slices.push({
        verticalPosition,
        quantiserScaleCode,
        dataStartBit: r.bitPos,
        dataEndBit: -1,
      });
    }
  }

  finishSlice(data.length * 8);
  return pictures;
}
