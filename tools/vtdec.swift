// Decode an MP4 with VideoToolbox and write out what it produced.
//
// Safari decodes through VideoToolbox, and VideoToolbox disagrees with ffmpeg
// about parts of this transcoder's output that no test can see. This harness
// makes that measurable without a browser: it decodes every sample, reports the
// frames VideoToolbox refused, and can write each frame's luma plane as a PGM
// for `vtdiff.py` to compare against ffmpeg's decode of the same file.
//
//   swiftc -O -o /tmp/vtdec tools/vtdec.swift
//   DUMP_DIR=/tmp/vt /tmp/vtdec out.mp4
//   python3 tools/vtdiff.py out.mp4 /tmp/vt
//
// DUMP_FROM and DUMP_TO narrow the dump to a range of seconds. VT_HW asks for a
// hardware decoder, which fails outright on this transcoder's output: the
// hardware H.264 decoder does not take MBAFF, so Safari is on the software one.
//
// Two traps, both of which have cost hours here:
//
//   - The output handler runs in display order, so the timestamp has to come
//     from its own parameter and not from the sample that was submitted.
//   - AVAssetReader rebases the track to zero, which ffmpeg may or may not do.
//     Do not line the two up by arithmetic; `vtdiff.py` does it by content.

import AVFoundation
import CoreMedia
import Darwin
import VideoToolbox

setvbuf(stdout, nil, _IOLBF, 0)

guard CommandLine.arguments.count == 2 else {
    print("usage: vtdec <file.mp4>")
    exit(2)
}
let environment = ProcessInfo.processInfo.environment
let dumpDirectory = environment["DUMP_DIR"]
let dumpFrom = Double(environment["DUMP_FROM"] ?? "") ?? -Double.infinity
let dumpTo = Double(environment["DUMP_TO"] ?? "") ?? Double.infinity

let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
guard let track = asset.tracks(withMediaType: .video).first else {
    print("no video track")
    exit(1)
}
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
reader.add(output)
guard reader.startReading() else {
    print("could not read: \(reader.error.map(String.init(describing:)) ?? "unknown")")
    exit(1)
}

/// One frame's luma plane, as a PGM named after its presentation time.
func writeLuma(_ image: CVPixelBuffer, seconds: Double, directory: String) {
    CVPixelBufferLockBaseAddress(image, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddressOfPlane(image, 0) else { return }
    let width = CVPixelBufferGetWidthOfPlane(image, 0)
    let height = CVPixelBufferGetHeightOfPlane(image, 0)
    let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
    let plane = base.assumingMemoryBound(to: UInt8.self)
    var data = Data("P5\n\(width) \(height)\n255\n".utf8)
    for row in 0..<height {
        data.append(plane + row * rowBytes, count: width)
    }
    let name = String(format: "%@/vt_%012.6f.pgm", directory, seconds)
    try? data.write(to: URL(fileURLWithPath: name))
}

var session: VTDecompressionSession?
var submitted = 0
var images = 0
var failures = 0

while let sample = output.copyNextSampleBuffer() {
    guard let format = CMSampleBufferGetFormatDescription(sample) else { continue }
    if session == nil {
        var created: VTDecompressionSession?
        let specification: [String: Any] = [
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder as String: true
        ]
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: format,
            decoderSpecification: environment["VT_HW"] != nil ? specification as CFDictionary : nil,
            imageBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            ] as CFDictionary,
            outputCallback: nil,
            decompressionSessionOut: &created)
        guard status == noErr, let created else {
            print("VTDecompressionSessionCreate failed with \(status)")
            exit(1)
        }
        session = created
    }
    let status = VTDecompressionSessionDecodeFrame(
        session!, sampleBuffer: sample,
        flags: [._EnableAsynchronousDecompression, ._EnableTemporalProcessing],
        infoFlagsOut: nil,
        outputHandler: { status, _, image, presentationTime, _ in
            let seconds = CMTimeGetSeconds(presentationTime)
            guard status == noErr, let image else {
                failures += 1
                print(String(format: "frame %.4f failed with %d", seconds, Int(status)))
                return
            }
            images += 1
            if let directory = dumpDirectory, seconds >= dumpFrom, seconds <= dumpTo {
                writeLuma(image, seconds: seconds, directory: directory)
            }
        })
    if status != noErr {
        failures += 1
        print("sample \(submitted) was refused with \(status)")
    }
    submitted += 1
}
if let session {
    VTDecompressionSessionWaitForAsynchronousFrames(session)
}
print("\(submitted) samples in, \(images) frames out, \(failures) failures")
exit(failures == 0 ? 0 : 1)
