// Decode an fMP4 the way Safari's MediaSource does, and report what breaks.
//
// tools/vtdec.swift reads a file with AVAssetReader and decodes it. That is not
// the pipeline Safari runs: MediaSource parses appended fragments with
// AVStreamDataParser, submits one sample at a time to a VTDecompressionSession,
// and -- the part that matters -- wraps every decoded image in the format
// description it cached from the *first* one. This harness reproduces all three,
// so a fault that only shows up in the browser can be measured here.
//
//   clang -fobjc-arc -O2 -o /tmp/sdpdec tools/sdpdec.m \
//     -framework Foundation -framework AVFoundation -framework CoreMedia \
//     -framework VideoToolbox -framework CoreVideo
//   /tmp/sdpdec out.mp4
//
// It found this, on 2026-08-07: a complementary field pair sharing one MP4
// sample decodes to an image whose description carries CVFieldCount 2, where a
// frame picture carries 1. WebKit's cached description then fails
// CMSampleBufferCreateReadyWithImageBuffer with -12743
// (kCMSampleBufferError_InvalidMediaFormat), which becomes MEDIA_ERR_DECODE.
//
// The fault is the change, not the pair: WK_CACHE_FIELDS=2 primes the cache
// from a pair instead, and then it is the frame pictures that fail. A stream
// made only of one kind would decode either way. Splitting the pair into two
// samples removes CVFieldCount 2 from the output, so the run comes back clean --
// which is why `split_field_samples` is the default.
//
// A file holding more than one initialization segment is fed the same way a
// SourceBuffer gets one: each `ftyp`+`moov` goes into the parser where it
// stands, and the fragments after it are read against it. The samples that
// follow are then described by something the decompression session cannot
// take, so the session is built again and the cached image description
// dropped -- which is what WebKit does, and what a stream that changes its
// frame size needs. Keeping the first session instead fails every sample after
// the change with -12909 (kVTVideoDecoderBadDataErr), so this is measured
// rather than assumed.
//
// Environment:
//
//   WK_REALTIME=1      add kVTDecodeFrame_1xRealTimePlayback, which WebKit sets
//                      during ordinary 1x playback
//   WK_TIMEOUT=<s>     how long to wait for each sample's callbacks (default 2)
//   WK_CACHE_FIELDS=<n> cache the description of the first image with this
//                      CVFieldCount rather than of the first image at all
//   DUMP_ATTACHMENTS=1 print each sample's attachments, which is what WebKit
//                      reads to decide whether a late sample can be skipped
//
// AVStreamDataParser is SPI, so its interface is declared here rather than
// imported. So is the multi-image-capable decode entry point, which is the one
// WebKit calls; the ordinary VTDecompressionSessionDecodeFrameWithOutputHandler
// behaves differently enough to be worth not substituting.

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <VideoToolbox/VideoToolbox.h>
#import <dlfcn.h>

@interface AVStreamDataParser : NSObject
- (void)setDelegate:(id)delegate;
- (void)appendStreamData:(NSData *)data;
@end

typedef void (^VTMultiImageHandler)(OSStatus status, VTDecodeInfoFlags infoFlags,
                                    CVImageBufferRef imageBuffer,
                                    CMTaggedBufferGroupRef taggedBufferGroup,
                                    CMTime presentationTimeStamp,
                                    CMTime presentationDuration);
typedef OSStatus (*VTDecodeMultiImageFn)(VTDecompressionSessionRef,
                                         CMSampleBufferRef, VTDecodeFrameFlags,
                                         VTDecodeInfoFlags *,
                                         VTMultiImageHandler);

static VTDecodeMultiImageFn decodeMultiImage(void) {
  static VTDecodeMultiImageFn fn;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    fn = (VTDecodeMultiImageFn)dlsym(
        RTLD_DEFAULT,
        "VTDecompressionSessionDecodeFrameWithMultiImageCapableOutputHandler");
  });
  return fn;
}

/// The description of the first decoded image, kept and reused exactly as
/// WebCoreDecompressionSession keeps m_currentImageDescription.
static CMVideoFormatDescriptionRef gCachedDescription;

@interface Collector : NSObject
@property(nonatomic) NSMutableArray *samples;
@end

@implementation Collector

- (instancetype)init {
  self = [super init];
  _samples = [NSMutableArray array];
  return self;
}

- (void)streamDataParser:(AVStreamDataParser *)parser
    didParseStreamDataAsAsset:(AVAsset *)asset {
  for (AVAssetTrack *track in asset.tracks)
    printf("track %d type %s\n", track.trackID, track.mediaType.UTF8String);
}

- (void)streamDataParser:(AVStreamDataParser *)parser
    didParseStreamDataAsAsset:(AVAsset *)asset
            withDiscontinuity:(BOOL)discontinuity {
  [self streamDataParser:parser didParseStreamDataAsAsset:asset];
}

- (void)streamDataParser:(AVStreamDataParser *)parser
    didFailToParseStreamDataWithError:(NSError *)error {
  printf("PARSE FAILED: %s\n", error.description.UTF8String);
}

- (void)streamDataParser:(AVStreamDataParser *)parser
     didProvideMediaData:(CMSampleBufferRef)sample
              forTrackID:(CMPersistentTrackID)trackID
               mediaType:(NSString *)mediaType
                   flags:(NSUInteger)flags {
  if ([mediaType isEqualToString:AVMediaTypeVideo])
    [_samples addObject:(__bridge id)sample];
}

- (void)streamDataParser:(AVStreamDataParser *)parser
    didReachEndOfTrackWithTrackID:(CMPersistentTrackID)trackID
                        mediaType:(NSString *)mediaType {
}

@end

/// Walk the top level boxes, so the file can be fed the way a SourceBuffer is:
/// the initialization segment first, then one moof+mdat at a time.
static void eachBox(NSData *data, void (^block)(NSString *type, NSUInteger start,
                                                NSUInteger end)) {
  const uint8_t *bytes = data.bytes;
  NSUInteger at = 0, length = data.length;
  while (at + 8 <= length) {
    uint64_t size = ((uint64_t)bytes[at] << 24) | (bytes[at + 1] << 16) |
                    (bytes[at + 2] << 8) | bytes[at + 3];
    NSString *type = [[NSString alloc] initWithBytes:bytes + at + 4
                                              length:4
                                            encoding:NSASCIIStringEncoding];
    if (size == 1) {
      size = 0;
      for (int i = 0; i < 8; i++)
        size = (size << 8) | bytes[at + 8 + i];
    } else if (size == 0) {
      size = length - at;
    }
    block(type, at, at + size);
    at += size;
  }
}

/// Everything WebKit does with a decoded image, so its failures happen here too.
static OSStatus wrapLikeWebKit(CVImageBufferRef image, CMTime pts,
                               CMTime duration) {
  CMVideoFormatDescriptionRef own = NULL;
  if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, image,
                                                   &own) != noErr)
    return noErr;

  // WK_CACHE_FIELDS answers which direction of the change is the fault. WebKit
  // caches the first decoded image, and an ordinary stream starts on frame
  // pictures, so the cache holds CVFieldCount 1 and the field pairs are what
  // mismatch. Priming it from an image of the other field count instead shows
  // what a stream that began on a field pair would do. Waiting for a
  // presentation time does not work: decode order runs ahead of display, so an
  // ordinary frame picture reaches the handler first either way.
  static long cacheFields;
  static dispatch_once_t onceCacheFields;
  dispatch_once(&onceCacheFields, ^{
    cacheFields = getenv("WK_CACHE_FIELDS") ? atol(getenv("WK_CACHE_FIELDS")) : 0;
  });
  if (!gCachedDescription && cacheFields) {
    CFNumberRef fieldCount = CMFormatDescriptionGetExtension(
        own, kCMFormatDescriptionExtension_FieldCount);
    long fields = 0;
    if (fieldCount)
      CFNumberGetValue(fieldCount, kCFNumberLongType, &fields);
    if (fields != cacheFields) {
      CFRelease(own);
      return noErr;
    }
  }

  if (!gCachedDescription) {
    gCachedDescription = (CMVideoFormatDescriptionRef)CFRetain(own);
    printf("cached image description: %s\n",
           [(__bridge NSDictionary *)CMFormatDescriptionGetExtensions(own)
               description]
               .UTF8String);
  } else if (!CMFormatDescriptionEqual(own, gCachedDescription)) {
    printf("pts %.4f decoded to a different description: %s\n",
           CMTimeGetSeconds(pts),
           [(__bridge NSDictionary *)CMFormatDescriptionGetExtensions(own)
               description]
               .UTF8String);
  }

  CMSampleBufferRef wrapped = NULL;
  CMSampleTimingInfo timing = {duration, pts, pts};
  OSStatus status = CMSampleBufferCreateReadyWithImageBuffer(
      kCFAllocatorDefault, image, gCachedDescription, &timing, &wrapped);
  if (status != noErr) {
    // The predicate the WebKit fix would use, and the recovery it would make.
    Boolean matches =
        CMVideoFormatDescriptionMatchesImageBuffer(gCachedDescription, image);
    CMSampleBufferRef retry = NULL;
    OSStatus retryStatus = CMSampleBufferCreateReadyWithImageBuffer(
        kCFAllocatorDefault, image, own, &timing, &retry);
    printf("pts %.4f wrapping with the cached description FAILED with %d "
           "(MatchesImageBuffer: %s; with a fresh description: %d)\n",
           CMTimeGetSeconds(pts), (int)status, matches ? "match" : "MISMATCH",
           (int)retryStatus);
    if (retry)
      CFRelease(retry);
  }
  if (wrapped)
    CFRelease(wrapped);
  CFRelease(own);
  return status;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 2) {
      printf("usage: sdpdec <file.mp4>\n");
      return 2;
    }
    NSData *data = [NSData dataWithContentsOfFile:@(argv[1])];
    if (!data) {
      printf("could not read %s\n", argv[1]);
      return 1;
    }
    double timeout = getenv("WK_TIMEOUT") ? atof(getenv("WK_TIMEOUT")) : 2.0;
    BOOL realTime = getenv("WK_REALTIME") != NULL;
    BOOL dumpAttachments = getenv("DUMP_ATTACHMENTS") != NULL;

    // Every segment the file holds, in order and each tagged with whether it
    // is an initialization segment: a stream that changes its frame size
    // carries more than one, and a SourceBuffer is given each where it stands.
    NSMutableArray<NSValue *> *segments = [NSMutableArray array];
    NSMutableArray<NSNumber *> *isInit = [NSMutableArray array];
    __block NSUInteger initStart = NSNotFound;
    __block NSUInteger fragmentCount = 0;
    eachBox(data, ^(NSString *type, NSUInteger start, NSUInteger end) {
      if ([type isEqualToString:@"ftyp"]) {
        initStart = start;
      } else if ([type isEqualToString:@"moov"]) {
        NSUInteger from = initStart == NSNotFound ? start : initStart;
        [segments addObject:[NSValue valueWithRange:NSMakeRange(from, end - from)]];
        [isInit addObject:@YES];
        initStart = NSNotFound;
      } else if ([type isEqualToString:@"moof"]) {
        [segments
            addObject:[NSValue valueWithRange:NSMakeRange(start, end - start)]];
        [isInit addObject:@NO];
        fragmentCount++;
      } else if ([type isEqualToString:@"mdat"] && segments.count &&
                 !isInit.lastObject.boolValue) {
        // An mdat belongs to the moof in front of it, and a SourceBuffer is
        // given the two together.
        NSRange last = segments.lastObject.rangeValue;
        last.length = end - last.location;
        segments[segments.count - 1] = [NSValue valueWithRange:last];
      }
    });
    if (fragmentCount == 0) {
      printf("%s has no fragments\n", argv[1]);
      return 1;
    }
    NSUInteger initCount = segments.count - fragmentCount;
    printf("%lu init segments, %lu fragments\n", (unsigned long)initCount,
           (unsigned long)fragmentCount);

    Class parserClass = NSClassFromString(@"AVStreamDataParser");
    if (!parserClass) {
      printf("AVStreamDataParser is not available\n");
      return 1;
    }
    AVStreamDataParser *parser = [[parserClass alloc] init];
    Collector *collector = [[Collector alloc] init];
    [parser setDelegate:collector];

    VTDecompressionSessionRef session = NULL;
    int submitted = 0, images = 0, failures = 0;
    __block int callbacks = 0, callbackImages = 0;
    __block OSStatus lastStatus = noErr;
    NSCondition *lock = [[NSCondition alloc] init];

    for (NSUInteger index = 0; index < segments.count; index++) {
      [collector.samples removeAllObjects];
      [parser appendStreamData:[data
                                   subdataWithRange:segments[index].rangeValue]];
      if (isInit[index].boolValue)
        continue;

      for (id object in collector.samples) {
        CMSampleBufferRef sample = (__bridge CMSampleBufferRef)object;
        CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
        if (!format)
          continue;
        // A session decodes one description. A stream that changes its frame
        // size hands the parser another initialization segment and the samples
        // after it arrive described by that, which is where WebKit builds a
        // decoder again -- and drops the image description it had cached, since
        // an image of the new size cannot be wrapped in the old one.
        if (session &&
            !VTDecompressionSessionCanAcceptFormatDescription(session, format)) {
          printf("format description changed at sample %d; rebuilding the "
                 "decoder\n",
                 submitted);
          VTDecompressionSessionWaitForAsynchronousFrames(session);
          VTDecompressionSessionInvalidate(session);
          CFRelease(session);
          session = NULL;
          if (gCachedDescription) {
            CFRelease(gCachedDescription);
            gCachedDescription = NULL;
          }
        }
        if (!session) {
          // What WebCoreDecompressionSession asks for: hardware if it can be
          // had, IOSurface-backed, and no pixel format of its own.
          NSDictionary *specification = @{
            (__bridge NSString *)
            kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder : @YES
          };
          NSDictionary *attributes = @{
            (__bridge NSString *)
            kCVPixelBufferIOSurfaceCoreAnimationCompatibilityKey : @YES,
            (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey : @{}
          };
          OSStatus status = VTDecompressionSessionCreate(
              kCFAllocatorDefault, format, (__bridge CFDictionaryRef)specification,
              (__bridge CFDictionaryRef)attributes, NULL, &session);
          if (status != noErr) {
            printf("VTDecompressionSessionCreate failed with %d\n", (int)status);
            return 1;
          }
        }

        CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
        CMItemCount numSamples = CMSampleBufferGetNumSamples(sample);

        if (dumpAttachments) {
          CFArrayRef attachments =
              CMSampleBufferGetSampleAttachmentsArray(sample, false);
          printf("pts %.4f numSamples %ld attachments %s\n",
                 CMTimeGetSeconds(pts), (long)numSamples,
                 attachments
                     ? [(__bridge NSArray *)attachments description].UTF8String
                     : "(none)");
        }

        [lock lock];
        callbacks = 0;
        callbackImages = 0;
        lastStatus = noErr;
        [lock unlock];

        VTDecodeFrameFlags decodeFlags =
            kVTDecodeFrame_EnableAsynchronousDecompression |
            kVTDecodeFrame_EnableTemporalProcessing;
        if (realTime)
          decodeFlags |= kVTDecodeFrame_1xRealTimePlayback;

        OSStatus status = decodeMultiImage()(
            session, sample, decodeFlags, NULL,
            ^(OSStatus status, VTDecodeInfoFlags flags, CVImageBufferRef image,
              CMTaggedBufferGroupRef group, CMTime pts, CMTime duration) {
              [lock lock];
              callbacks++;
              if (image || group)
                callbackImages++;
              if (status != noErr)
                lastStatus = status;
              if (image) {
                OSStatus wrapStatus = wrapLikeWebKit(image, pts, duration);
                if (wrapStatus != noErr)
                  lastStatus = wrapStatus;
              }
              [lock signal];
              [lock unlock];
            });
        if (status != noErr) {
          printf("sample %d pts %.4f refused with %d\n", submitted,
                 CMTimeGetSeconds(pts), (int)status);
          failures++;
          submitted++;
          continue;
        }

        // WebKit holds the next sample back until this one has called back once
        // for every sample the buffer says it holds.
        [lock lock];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
        while (callbacks < numSamples && deadline.timeIntervalSinceNow > 0)
          [lock waitUntilDate:deadline];
        int got = callbacks, gotImages = callbackImages;
        OSStatus gotStatus = lastStatus;
        [lock unlock];

        images += gotImages;
        if (got != numSamples || gotStatus != noErr) {
          failures++;
          if (failures < 25)
            printf("sample %d pts %.4f numSamples %ld -> callbacks %d images %d "
                   "status %d\n",
                   submitted, CMTimeGetSeconds(pts), (long)numSamples, got,
                   gotImages, (int)gotStatus);
        }
        submitted++;
      }
    }
    if (session) {
      VTDecompressionSessionWaitForAsynchronousFrames(session);
      VTDecompressionSessionInvalidate(session);
      CFRelease(session);
    }
    printf("%d samples in, %d images out, %d failures\n", submitted, images,
           failures);
    return failures ? 1 : 0;
  }
}
