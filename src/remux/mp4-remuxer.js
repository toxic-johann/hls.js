/**
 * fMP4 remuxer
*/

import AAC from './aac-helper';
import MP4 from './mp4-generator';

import Event from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';

import { toMsFromMpegTsClock, toMpegTsClockFromTimescale } from '../utils/timescale-conversion';

import { logger } from '../utils/logger';

const MAX_SILENT_FRAME_DURATION_90KHZ = toMpegTsClockFromTimescale(10);
const PTS_DTS_SHIFT_TOLERANCE_90KHZ = toMpegTsClockFromTimescale(0.2);

class MP4Remuxer {
  constructor (observer, config, typeSupported, vendor) {
    this.observer = observer;
    this.config = config;
    this.typeSupported = typeSupported;
    const userAgent = navigator.userAgent;
    this.isSafari = vendor && vendor.indexOf('Apple') > -1 && userAgent && !userAgent.match('CriOS');
    this.ISGenerated = false;
  }

  destroy () {
  }

  resetTimeStamp (defaultTimeStamp) {
    this._initPTS = this._initDTS = defaultTimeStamp;
  }

  resetInitSegment () {
    this.ISGenerated = false;
  }

  remux (audioTrack, videoTrack, id3Track, textTrack, timeOffset, contiguous, accurateTimeOffset) {
    // generate Init Segment if needed
    if (!this.ISGenerated) {
      this.generateIS(audioTrack, videoTrack, timeOffset);
    }

    if (this.ISGenerated) {
      const nbAudioSamples = audioTrack.samples.length;
      const nbVideoSamples = videoTrack.samples.length;
      let audioTimeOffset = timeOffset;
      let videoTimeOffset = timeOffset;
      if (nbAudioSamples && nbVideoSamples) {
        // timeOffset is expected to be the offset of the first timestamp of this fragment (first DTS)
        // if first audio DTS is not aligned with first video DTS then we need to take that into account
        // when providing timeOffset to remuxAudio / remuxVideo. if we don't do that, there might be a permanent / small
        // drift between audio and video streams
        // Use pts at timeOffset 0 so that VOD streams begin at 0
        const tsDelta = timeOffset > 0 ? audioTrack.samples[0].dts - videoTrack.samples[0].dts
          : audioTrack.samples[0].pts - videoTrack.samples[0].pts;
        const audiovideoTimestampDelta = tsDelta / videoTrack.inputTimeScale;
        audioTimeOffset += Math.max(0, audiovideoTimestampDelta);
        videoTimeOffset += Math.max(0, -audiovideoTimestampDelta);
      }
      // Purposefully remuxing audio before video, so that remuxVideo can use nextAudioPts, which is
      // calculated in remuxAudio.
      // logger.log('nb AAC samples:' + audioTrack.samples.length);
      if (nbAudioSamples) {
        // if initSegment was generated without video samples, regenerate it again
        if (!audioTrack.timescale) {
          logger.warn('regenerate InitSegment as audio detected');
          this.generateIS(audioTrack, videoTrack, timeOffset);
        }
        let audioData = this.remuxAudio(audioTrack, audioTimeOffset, contiguous, accurateTimeOffset);
        // logger.log('nb AVC samples:' + videoTrack.samples.length);
        if (nbVideoSamples) {
          let audioTrackLength;
          if (audioData) {
            audioTrackLength = audioData.endPTS - audioData.startPTS;
          }

          // if initSegment was generated without video samples, regenerate it again
          if (!videoTrack.timescale) {
            logger.warn('regenerate InitSegment as video detected');
            this.generateIS(audioTrack, videoTrack, timeOffset);
          }
          this.remuxVideo(videoTrack, videoTimeOffset, contiguous, audioTrackLength, accurateTimeOffset);
        }
      } else {
        // logger.log('nb AVC samples:' + videoTrack.samples.length);
        if (nbVideoSamples) {
          let videoData = this.remuxVideo(videoTrack, videoTimeOffset, contiguous, 0, accurateTimeOffset);
          if (videoData && audioTrack.codec) {
            this.remuxEmptyAudio(audioTrack, audioTimeOffset, contiguous, videoData);
          }
        }
      }
    }
    // logger.log('nb ID3 samples:' + audioTrack.samples.length);
    if (id3Track.samples.length) {
      this.remuxID3(id3Track, timeOffset);
    }

    // logger.log('nb ID3 samples:' + audioTrack.samples.length);
    if (textTrack.samples.length) {
      this.remuxText(textTrack, timeOffset);
    }

    // notify end of parsing
    this.observer.trigger(Event.FRAG_PARSED);
  }

  generateIS (audioTrack, videoTrack, timeOffset) {
    let observer = this.observer,
      audioSamples = audioTrack.samples,
      videoSamples = videoTrack.samples,
      typeSupported = this.typeSupported,
      container = 'audio/mp4',
      tracks = {},
      data = { tracks },
      computePTSDTS = (this._initPTS === undefined),
      initPTS, initDTS;

    if (computePTSDTS) {
      initPTS = initDTS = Infinity;
    }

    if (audioTrack.config && audioSamples.length) {
      // let's use audio sampling rate as MP4 time scale.
      // rationale is that there is a integer nb of audio frames per audio sample (1024 for AAC)
      // using audio sampling rate here helps having an integer MP4 frame duration
      // this avoids potential rounding issue and AV sync issue
      audioTrack.timescale = audioTrack.samplerate;
      logger.log(`audio sampling rate : ${audioTrack.samplerate}`);
      if (!audioTrack.isAAC) {
        if (typeSupported.mpeg) { // Chrome and Safari
          container = 'audio/mpeg';
          audioTrack.codec = '';
        } else if (typeSupported.mp3) { // Firefox
          audioTrack.codec = 'mp3';
        }
      }
      tracks.audio = {
        container: container,
        codec: audioTrack.codec,
        initSegment: !audioTrack.isAAC && typeSupported.mpeg ? new Uint8Array() : MP4.initSegment([audioTrack]),
        metadata: {
          channelCount: audioTrack.channelCount
        }
      };
      if (computePTSDTS) {
        // remember first PTS of this demuxing context. for audio, PTS = DTS
        initPTS = initDTS = audioSamples[0].pts - Math.round(audioTrack.inputTimeScale * timeOffset);
      }
    }

    if (videoTrack.sps && videoTrack.pps && videoSamples.length) {
      // let's use input time scale as MP4 video timescale
      // we use input time scale straight away to avoid rounding issues on frame duration / cts computation
      const inputTimeScale = videoTrack.inputTimeScale;
      videoTrack.timescale = inputTimeScale;
      tracks.video = {
        container: 'video/mp4',
        codec: videoTrack.codec,
        initSegment: MP4.initSegment([videoTrack]),
        metadata: {
          width: videoTrack.width,
          height: videoTrack.height
        }
      };
      if (computePTSDTS) {
        const startPTS = Math.round(inputTimeScale * timeOffset);
        initPTS = Math.min(initPTS, videoSamples[0].pts - startPTS);
        initDTS = Math.min(initDTS, videoSamples[0].dts - startPTS);
        this.observer.trigger(Event.INIT_PTS_FOUND, { initPTS });
      }
    } else if (computePTSDTS && tracks.audio) {
      // initPTS found for audio-only stream with main and alt audio
      this.observer.trigger(Event.INIT_PTS_FOUND, { initPTS });
    }

    if (Object.keys(tracks).length) {
      observer.trigger(Event.FRAG_PARSING_INIT_SEGMENT, data);
      this.ISGenerated = true;
      if (computePTSDTS) {
        this._initPTS = initPTS;
        this._initDTS = initDTS;
      }
    } else {
      observer.trigger(Event.ERROR, { type: ErrorTypes.MEDIA_ERROR, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: false, reason: 'no audio/video samples found' });
    }
  }

  remuxVideo (track, timeOffset, contiguous, audioTrackLength, accurateTimeOffset) {
    let offset = 8;
    let mp4SampleDuration;
    let mdat;
    let moof;
    let firstDTS;
    let lastDTS;
    let minPTS = Number.POSITIVE_INFINITY;
    let maxPTS = Number.NEGATIVE_INFINITY;
    const timeScale = track.timescale;
    const inputSamples = track.samples;
    const outputSamples = [];
    const nbSamples = inputSamples.length;
    const ptsNormalize = this._PTSNormalize;
    const initPTS = this._initPTS;

    // if parsed fragment is contiguous with last one, let's use last DTS value as reference
    let nextAvcDts = this.nextAvcDts;

    const isSafari = this.isSafari;

    if (nbSamples === 0) {
      return;
    }

    // Safari does not like overlapping DTS on consecutive fragments. let's use nextAvcDts to overcome this if fragments are consecutive
    if (isSafari) {
      // also consider consecutive fragments as being contiguous (even if a level switch occurs),
      // for sake of clarity:
      // consecutive fragments are frags with
      //  - less than 100ms gaps between new time offset (if accurate) and next expected PTS OR
      //  - less than 200 ms PTS gaps (timeScale/5)
      contiguous |= (nbSamples && nextAvcDts &&
                     ((accurateTimeOffset && Math.abs(timeOffset - nextAvcDts / timeScale) < 0.1) ||
                      Math.abs((inputSamples[0].pts - nextAvcDts - initPTS)) < timeScale / 5)
      );
    }

    if (!contiguous) {
      // if not contiguous, let's use target timeOffset
      nextAvcDts = timeOffset * timeScale;
    }

    // PTS is coded on 33bits, and can loop from -2^32 to 2^32
    // ptsNormalize will make PTS/DTS value monotonic, we use last known DTS value as reference value
    inputSamples.forEach(function (sample) {
      sample.pts = ptsNormalize(sample.pts - initPTS, nextAvcDts);
      sample.dts = ptsNormalize(sample.dts - initPTS, nextAvcDts);

      minPTS = Math.min(sample.pts, minPTS);
      maxPTS = Math.max(sample.pts, maxPTS);
    });

    // sort video samples by DTS then PTS then demux id order
    inputSamples.sort(function (a, b) {
      const deltadts = a.dts - b.dts;
      const deltapts = a.pts - b.pts;
      return deltadts || (deltapts || (a.id - b.id));
    });

    // handle broken streams with PTS < DTS, tolerance up 0.2 seconds
    let PTSDTSshift = inputSamples.reduce((prev, curr) => Math.max(Math.min(prev, curr.pts - curr.dts), -1 * PTS_DTS_SHIFT_TOLERANCE_90KHZ), 0);
    if (PTSDTSshift < 0) {
      logger.warn(`PTS < DTS detected in video samples, shifting DTS by ${toMsFromMpegTsClock(PTSDTSshift, true)} ms to overcome this issue`);
      for (let i = 0; i < nbSamples; i++) {
        inputSamples[i].dts = Math.max(0, inputSamples[i].dts + PTSDTSshift);
      }
    }

    // Get first/last DTS
    firstDTS = inputSamples[0].dts;
    lastDTS = inputSamples[nbSamples - 1].dts;

    // on Safari let's signal the same sample duration for all samples
    // sample duration (as expected by trun MP4 boxes), should be the delta between sample DTS
    // set this constant duration as being the avg delta between consecutive DTS.
    const averageSampleDuration = Math.round((lastDTS - firstDTS) / (nbSamples - 1));

    // check timestamp continuity across consecutive fragments (this is to remove inter-fragment gap/hole)
    const delta = firstDTS - nextAvcDts;
    // if fragment are contiguous, detect hole/overlapping between fragments
    if (contiguous) {
      const foundHole = delta > averageSampleDuration;
      const foundOverlap = delta < -1;
      if (foundHole || foundOverlap) {
        if (foundHole) {
          logger.warn(`AVC: ${toMsFromMpegTsClock(delta, true)}ms (${delta}dts) hole between fragments detected, filling it`);
        } else {
          logger.warn(`AVC: ${toMsFromMpegTsClock(-delta, true)}ms (${delta}dts) overlapping between fragments detected`);
        }
        firstDTS = nextAvcDts;
        minPTS -= delta;
        inputSamples[0].dts = firstDTS;
        inputSamples[0].pts = minPTS;
        logger.log(`Video: First PTS/DTS adjusted: ${toMsFromMpegTsClock(minPTS, true)}/${toMsFromMpegTsClock(firstDTS, true)}, delta: ${toMsFromMpegTsClock(delta, true)} ms`);
      }
    }

    // Clamp first DTS to 0 so that we're still aligning on initPTS,
    // and not passing negative values to MP4.traf. This will change initial frame compositionTimeOffset!
    firstDTS = Math.max(firstDTS, 0);

    let nbNalu = 0, naluLen = 0;
    for (let i = 0; i < nbSamples; i++) {
      // compute total/avc sample length and nb of NAL units
      let sample = inputSamples[i], units = sample.units, nbUnits = units.length, sampleLen = 0;
      for (let j = 0; j < nbUnits; j++) {
        sampleLen += units[j].data.length;
      }

      naluLen += sampleLen;
      nbNalu += nbUnits;
      sample.length = sampleLen;

      // normalize PTS/DTS
      if (isSafari) {
        // sample DTS is computed using a constant decoding offset (mp4SampleDuration) between samples
        sample.dts = firstDTS + i * averageSampleDuration;
      } else {
        // ensure sample monotonic DTS
        sample.dts = Math.max(sample.dts, firstDTS);
      }
      // ensure that computed value is greater or equal than sample DTS
      sample.pts = Math.max(sample.pts, sample.dts);
    }

    /* concatenate the video data and construct the mdat in place
      (need 8 more bytes to fill length and mpdat type) */
    let mdatSize = naluLen + (4 * nbNalu) + 8;
    try {
      mdat = new Uint8Array(mdatSize);
    } catch (err) {
      this.observer.trigger(Event.ERROR, { type: ErrorTypes.MUX_ERROR, details: ErrorDetails.REMUX_ALLOC_ERROR, fatal: false, bytes: mdatSize, reason: `fail allocating video mdat ${mdatSize}` });
      return;
    }
    let view = new DataView(mdat.buffer);
    view.setUint32(0, mdatSize);
    mdat.set(MP4.types.mdat, 4);

    for (let i = 0; i < nbSamples; i++) {
      let avcSample = inputSamples[i],
        avcSampleUnits = avcSample.units,
        mp4SampleLength = 0,
        compositionTimeOffset;
      // convert NALU bitstream to MP4 format (prepend NALU with size field)
      for (let j = 0, nbUnits = avcSampleUnits.length; j < nbUnits; j++) {
        let unit = avcSampleUnits[j],
          unitData = unit.data,
          unitDataLen = unit.data.byteLength;
        view.setUint32(offset, unitDataLen);
        offset += 4;
        mdat.set(unitData, offset);
        offset += unitDataLen;
        mp4SampleLength += 4 + unitDataLen;
      }

      if (!isSafari) {
        // expected sample duration is the Decoding Timestamp diff of consecutive samples
        if (i < nbSamples - 1) {
          mp4SampleDuration = inputSamples[i + 1].dts - avcSample.dts;
        } else {
          let config = this.config,
            lastFrameDuration = avcSample.dts - inputSamples[i > 0 ? i - 1 : i].dts;
          if (config.stretchShortVideoTrack) {
            // In some cases, a segment's audio track duration may exceed the video track duration.
            // Since we've already remuxed audio, and we know how long the audio track is, we look to
            // see if the delta to the next segment is longer than maxBufferHole.
            // If so, playback would potentially get stuck, so we artificially inflate
            // the duration of the last frame to minimize any potential gap between segments.
            let maxBufferHole = config.maxBufferHole,
              gapTolerance = Math.floor(maxBufferHole * timeScale),
              deltaToFrameEnd = (audioTrackLength ? minPTS + audioTrackLength * timeScale : this.nextAudioPts) - avcSample.pts;
            if (deltaToFrameEnd > gapTolerance) {
              // We subtract lastFrameDuration from deltaToFrameEnd to try to prevent any video
              // frame overlap. maxBufferHole should be >> lastFrameDuration anyway.
              mp4SampleDuration = deltaToFrameEnd - lastFrameDuration;
              if (mp4SampleDuration < 0) {
                mp4SampleDuration = lastFrameDuration;
              }

              logger.log(`It is approximately ${toMsFromMpegTsClock(deltaToFrameEnd, false)} ms to the next segment; using duration ${toMsFromMpegTsClock(mp4SampleDuration, false)} ms for the last video frame.`);
            } else {
              mp4SampleDuration = lastFrameDuration;
            }
          } else {
            mp4SampleDuration = lastFrameDuration;
          }
        }
        compositionTimeOffset = Math.round(avcSample.pts - avcSample.dts);
      } else {
        compositionTimeOffset = Math.max(0, mp4SampleDuration * Math.round((avcSample.pts - avcSample.dts) / mp4SampleDuration));
      }

      // console.log('PTS/DTS/initDTS/normPTS/normDTS/relative PTS : ${avcSample.pts}/${avcSample.dts}/${initDTS}/${ptsnorm}/${dtsnorm}/${(avcSample.pts/4294967296).toFixed(3)}');
      outputSamples.push({
        size: mp4SampleLength,
        // constant duration
        duration: mp4SampleDuration,
        cts: compositionTimeOffset,
        flags: {
          isLeading: 0,
          isDependedOn: 0,
          hasRedundancy: 0,
          degradPrio: 0,
          dependsOn: avcSample.key ? 2 : 1,
          isNonSync: avcSample.key ? 0 : 1
        }
      });
    }
    // next AVC sample DTS should be equal to last sample DTS + last sample duration (in PES timescale)
    this.nextAvcDts = lastDTS + mp4SampleDuration;
    let dropped = track.dropped;
    track.nbNalu = 0;
    track.dropped = 0;
    if (outputSamples.length && navigator.userAgent.toLowerCase().indexOf('chrome') > -1) {
      let flags = outputSamples[0].flags;
      // chrome workaround, mark first sample as being a Random Access Point to avoid sourcebuffer append issue
      // https://code.google.com/p/chromium/issues/detail?id=229412
      flags.dependsOn = 2;
      flags.isNonSync = 0;
    }
    track.samples = outputSamples;
    moof = MP4.moof(track.sequenceNumber++, firstDTS, track);
    track.samples = [];

    let data = {
      data1: moof,
      data2: mdat,
      startPTS: minPTS / timeScale,
      endPTS: (maxPTS + mp4SampleDuration) / timeScale,
      startDTS: firstDTS / timeScale,
      endDTS: this.nextAvcDts / timeScale,
      type: 'video',
      hasAudio: false,
      hasVideo: true,
      nb: outputSamples.length,
      dropped: dropped
    };
    this.observer.trigger(Event.FRAG_PARSING_DATA, data);
    return data;
  }

  remuxAudio (track, timeOffset, contiguous, accurateTimeOffset) {
    const inputTimeScale = track.inputTimeScale;
    const mp4timeScale = track.timescale;
    const scaleFactor = inputTimeScale / mp4timeScale;
    const mp4SampleDuration = track.isAAC ? 1024 : 1152;
    const inputSampleDuration = mp4SampleDuration * scaleFactor;
    const ptsNormalize = this._PTSNormalize;
    const initPTS = this._initPTS;
    const rawMPEG = !track.isAAC && this.typeSupported.mpeg;

    let mp4Sample;
    let fillFrame;
    let mdat;
    let moof;
    let firstPTS;
    let lastPTS;
    let offset = (rawMPEG ? 0 : 8);
    let inputSamples = track.samples;
    let outputSamples = [];
    let nextAudioPts = this.nextAudioPts;

    // for audio samples, also consider consecutive fragments as being contiguous (even if a level switch occurs),
    // for sake of clarity:
    // consecutive fragments are frags with
    //  - less than 100ms gaps between new time offset (if accurate) and next expected PTS OR
    //  - less than 20 audio frames distance
    // contiguous fragments are consecutive fragments from same quality level (same level, new SN = old SN + 1)
    // this helps ensuring audio continuity
    // and this also avoids audio glitches/cut when switching quality, or reporting wrong duration on first audio frame
    contiguous |= (inputSamples.length && nextAudioPts &&
                   ((accurateTimeOffset && Math.abs(timeOffset - nextAudioPts / inputTimeScale) < 0.1) ||
                    Math.abs((inputSamples[0].pts - nextAudioPts - initPTS)) < 20 * inputSampleDuration)
    );

    // compute normalized PTS
    inputSamples.forEach(function (sample) {
      sample.pts = sample.dts = ptsNormalize(sample.pts - initPTS, timeOffset * inputTimeScale);
    });

    // filter out sample with negative PTS that are not playable anyway
    // if we don't remove these negative samples, they will shift all audio samples forward.
    // leading to audio overlap between current / next fragment
    inputSamples = inputSamples.filter(function (sample) {
      return sample.pts >= 0;
    });

    // in case all samples have negative PTS, and have been filtered out, return now
    if (inputSamples.length === 0) {
      return;
    }

    if (!contiguous) {
      if (!accurateTimeOffset) {
        // if frag are mot contiguous and if we cant trust time offset, let's use first sample PTS as next audio PTS
        nextAudioPts = inputSamples[0].pts;
      } else {
        // if timeOffset is accurate, let's use it as predicted next audio PTS
        nextAudioPts = timeOffset * inputTimeScale;
      }
    }

    // If the audio track is missing samples, the frames seem to get "left-shifted" within the
    // resulting mp4 segment, causing sync issues and leaving gaps at the end of the audio segment.
    // In an effort to prevent this from happening, we inject frames here where there are gaps.
    // When possible, we inject a silent frame; when that's not possible, we duplicate the last
    // frame.

    if (track.isAAC) {
      const maxAudioFramesDrift = this.config.maxAudioFramesDrift;
      for (let i = 0, nextPts = nextAudioPts; i < inputSamples.length;) {
        // First, let's see how far off this frame is from where we expect it to be
        var sample = inputSamples[i], delta;
        let pts = sample.pts;
        delta = pts - nextPts;

        // If we're overlapping by more than a duration, drop this sample
        if (delta <= -maxAudioFramesDrift * inputSampleDuration) {
          if (contiguous) {
            logger.warn(`Dropping 1 audio frame @ ${toMsFromMpegTsClock(nextPts, true) / 1000}s due to ${toMsFromMpegTsClock(delta, true)} ms overlap.`);
            inputSamples.splice(i, 1);
            // Don't touch nextPtsNorm or i
          } else {
            // When changing qualities we can't trust that audio has been appended up to nextAudioPts
            // Warn about the overlap but do not drop samples as that can introduce buffer gaps
            logger.warn(`Audio frame @ ${toMsFromMpegTsClock(pts, true) / 1000}s overlaps nextAudioPts by ${toMsFromMpegTsClock(delta, true)} ms.`);
            nextPts = pts + inputSampleDuration;
            i++;
          }
        } // eslint-disable-line brace-style

        // Insert missing frames if:
        // 1: We're more than maxAudioFramesDrift frame away
        // 2: Not more than MAX_SILENT_FRAME_DURATION away
        // 3: currentTime (aka nextPtsNorm) is not 0
        else if (delta >= maxAudioFramesDrift * inputSampleDuration && delta < MAX_SILENT_FRAME_DURATION_90KHZ && nextPts) {
          let missing = Math.round(delta / inputSampleDuration);
          logger.warn(`Injecting ${missing} audio frames @ ${toMsFromMpegTsClock(nextPts, true) / 1000}s due to ${toMsFromMpegTsClock(delta, true)} ms gap.`);
          for (let j = 0; j < missing; j++) {
            let newStamp = Math.max(nextPts, 0);
            fillFrame = AAC.getSilentFrame(track.manifestCodec || track.codec, track.channelCount);
            if (!fillFrame) {
              logger.log('Unable to get silent frame for given audio codec; duplicating last frame instead.');
              fillFrame = sample.unit.subarray();
            }
            inputSamples.splice(i, 0, { unit: fillFrame, pts: newStamp, dts: newStamp });
            nextPts += inputSampleDuration;
            i++;
          }

          // Adjust sample to next expected pts
          sample.pts = sample.dts = nextPts;
          nextPts += inputSampleDuration;
          i++;
        } else {
          // Otherwise, just adjust pts
          if (Math.abs(delta) > (0.1 * inputSampleDuration)) {
            // logger.log(`Invalid frame delta ${Math.round(delta + inputSampleDuration)} at PTS ${Math.round(pts / 90)} (should be ${Math.round(inputSampleDuration)}).`);
          }
          sample.pts = sample.dts = nextPts;
          nextPts += inputSampleDuration;
          i++;
        }
      }
    }

    // compute mdat size, as we eventually filtered/added some samples
    let nbSamples = inputSamples.length;
    let mdatSize = 0;
    while (nbSamples--) {
      mdatSize += inputSamples[nbSamples].unit.byteLength;
    }

    for (let j = 0, nbSamples = inputSamples.length; j < nbSamples; j++) {
      let audioSample = inputSamples[j];
      let unit = audioSample.unit;
      let pts = audioSample.pts;

      // logger.log(`Audio/PTS:${toMsFromMpegTsClock(pts, true)}`);
      // if not first sample

      if (lastPTS !== undefined && mp4Sample) {
        mp4Sample.duration = Math.round((pts - lastPTS) / scaleFactor);
      } else {
        let delta = pts - nextAudioPts;
        let numMissingFrames = 0;

        // if fragment are contiguous, detect hole/overlapping between fragments
        // contiguous fragments are consecutive fragments from same quality level (same level, new SN = old SN + 1)
        if (contiguous && track.isAAC) {
          // log delta
          if (delta) {
            if (delta > 0 && delta < MAX_SILENT_FRAME_DURATION_90KHZ) {
              // Q: why do we have to round here, shouldn't this always result in an integer if timestamps are correct,
              // and if not, shouldn't we actually Math.ceil() instead?
              numMissingFrames = Math.round((pts - nextAudioPts) / inputSampleDuration);

              logger.log(`${toMsFromMpegTsClock(delta, true)} ms hole between AAC samples detected,filling it`);
              if (numMissingFrames > 0) {
                fillFrame = AAC.getSilentFrame(track.manifestCodec || track.codec, track.channelCount);
                if (!fillFrame) {
                  fillFrame = unit.subarray();
                }

                mdatSize += numMissingFrames * fillFrame.length;
              }
              // if we have frame overlap, overlapping for more than half a frame duraion
            } else if (delta < -12) {
              // drop overlapping audio frames... browser will deal with it
              logger.log(`drop overlapping AAC sample, expected/parsed/delta: ${toMsFromMpegTsClock(nextAudioPts, true)} ms / ${toMsFromMpegTsClock(pts, true)} ms / ${toMsFromMpegTsClock(-delta, true)} ms`);
              mdatSize -= unit.byteLength;
              continue;
            }
            // set PTS/DTS to expected PTS/DTS
            pts = nextAudioPts;
          }
        }
        // remember first PTS of our audioSamples
        firstPTS = pts;
        if (mdatSize > 0) {
          mdatSize += offset;
          try {
            mdat = new Uint8Array(mdatSize);
          } catch (err) {
            this.observer.trigger(Event.ERROR, { type: ErrorTypes.MUX_ERROR, details: ErrorDetails.REMUX_ALLOC_ERROR, fatal: false, bytes: mdatSize, reason: `fail allocating audio mdat ${mdatSize}` });
            return;
          }
          if (!rawMPEG) {
            const view = new DataView(mdat.buffer);
            view.setUint32(0, mdatSize);
            mdat.set(MP4.types.mdat, 4);
          }
        } else {
          // no audio samples
          return;
        }
        for (let i = 0; i < numMissingFrames; i++) {
          fillFrame = AAC.getSilentFrame(track.manifestCodec || track.codec, track.channelCount);
          if (!fillFrame) {
            logger.log('Unable to get silent frame for given audio codec; duplicating this frame instead.');
            fillFrame = unit.subarray();
          }
          mdat.set(fillFrame, offset);
          offset += fillFrame.byteLength;
          mp4Sample = {
            size: fillFrame.byteLength,
            cts: 0,
            duration: 1024,
            flags: {
              isLeading: 0,
              isDependedOn: 0,
              hasRedundancy: 0,
              degradPrio: 0,
              dependsOn: 1
            }
          };
          outputSamples.push(mp4Sample);
        }
      }
      mdat.set(unit, offset);
      let unitLen = unit.byteLength;
      offset += unitLen;
      // console.log('PTS/DTS/initDTS/normPTS/normDTS/relative PTS : ${audioSample.pts}/${audioSample.dts}/${initDTS}/${ptsnorm}/${dtsnorm}/${(audioSample.pts/4294967296).toFixed(3)}');
      mp4Sample = {
        size: unitLen,
        cts: 0,
        duration: 0,
        flags: {
          isLeading: 0,
          isDependedOn: 0,
          hasRedundancy: 0,
          degradPrio: 0,
          dependsOn: 1
        }
      };
      outputSamples.push(mp4Sample);
      lastPTS = pts;
    }
    let lastSampleDuration = 0;
    nbSamples = outputSamples.length;
    // set last sample duration as being identical to previous sample
    if (nbSamples >= 2) {
      lastSampleDuration = outputSamples[nbSamples - 2].duration;
      mp4Sample.duration = lastSampleDuration;
    }
    if (nbSamples) {
      // next audio sample PTS should be equal to last sample PTS + duration
      this.nextAudioPts = nextAudioPts = lastPTS + scaleFactor * lastSampleDuration;
      // logger.log('Audio/PTS/PTSend:' + audioSample.pts.toFixed(0) + '/' + this.nextAacDts.toFixed(0));
      track.samples = outputSamples;
      if (rawMPEG) {
        moof = new Uint8Array();
      } else {
        moof = MP4.moof(track.sequenceNumber++, firstPTS / scaleFactor, track);
      }

      track.samples = [];
      const start = firstPTS / inputTimeScale;
      const end = nextAudioPts / inputTimeScale;
      const audioData = {
        data1: moof,
        data2: mdat,
        startPTS: start,
        endPTS: end,
        startDTS: start,
        endDTS: end,
        type: 'audio',
        hasAudio: true,
        hasVideo: false,
        nb: nbSamples
      };
      this.observer.trigger(Event.FRAG_PARSING_DATA, audioData);
      return audioData;
    }
    return null;
  }

  remuxEmptyAudio (track, timeOffset, contiguous, videoData) {
    let inputTimeScale = track.inputTimeScale;
    let mp4timeScale = track.samplerate ? track.samplerate : inputTimeScale;
    let scaleFactor = inputTimeScale / mp4timeScale;
    let nextAudioPts = this.nextAudioPts;

    // sync with video's timestamp
    let startDTS = (nextAudioPts !== undefined ? nextAudioPts : videoData.startDTS * inputTimeScale) + this._initDTS;
    let endDTS = videoData.endDTS * inputTimeScale + this._initDTS;
    // one sample's duration value
    let sampleDuration = 1024;
    let frameDuration = scaleFactor * sampleDuration;

    // samples count of this segment's duration
    let nbSamples = Math.ceil((endDTS - startDTS) / frameDuration);

    // silent frame
    let silentFrame = AAC.getSilentFrame(track.manifestCodec || track.codec, track.channelCount);

    logger.warn('remux empty Audio');
    // Can't remux if we can't generate a silent frame...
    if (!silentFrame) {
      logger.trace('Unable to remuxEmptyAudio since we were unable to get a silent frame for given audio codec!');
      return;
    }

    let samples = [];
    for (let i = 0; i < nbSamples; i++) {
      let stamp = startDTS + i * frameDuration;
      samples.push({ unit: silentFrame, pts: stamp, dts: stamp });
    }
    track.samples = samples;

    this.remuxAudio(track, timeOffset, contiguous);
  }

  remuxID3 (track) {
    const length = track.samples.length;
    if (!length) {
      return;
    }
    const inputTimeScale = track.inputTimeScale;
    const initPTS = this._initPTS;
    const initDTS = this._initDTS;
    // consume samples
    for (let index = 0; index < length; index++) {
      const sample = track.samples[index];
      // setting id3 pts, dts to relative time
      // using this._initPTS and this._initDTS to calculate relative time
      sample.pts = ((sample.pts - initPTS) / inputTimeScale);
      sample.dts = ((sample.dts - initDTS) / inputTimeScale);
    }
    this.observer.trigger(Event.FRAG_PARSING_METADATA, {
      samples: track.samples
    });

    track.samples = [];
  }

  remuxText (track) {
    track.samples.sort(function (a, b) {
      return (a.pts - b.pts);
    });

    let length = track.samples.length, sample;
    const inputTimeScale = track.inputTimeScale;
    const initPTS = this._initPTS;
    // consume samples
    if (length) {
      for (let index = 0; index < length; index++) {
        sample = track.samples[index];
        // setting text pts, dts to relative time
        // using this._initPTS and this._initDTS to calculate relative time
        sample.pts = ((sample.pts - initPTS) / inputTimeScale);
      }
      this.observer.trigger(Event.FRAG_PARSING_USERDATA, {
        samples: track.samples
      });
    }

    track.samples = [];
  }

  _PTSNormalize (value, reference) {
    let offset;
    if (reference === undefined) {
      return value;
    }

    if (reference < value) {
      // - 2^33
      offset = -8589934592;
    } else {
      // + 2^33
      offset = 8589934592;
    }
    /* PTS is 33bit (from 0 to 2^33 -1)
      if diff between value and reference is bigger than half of the amplitude (2^32) then it means that
      PTS looping occured. fill the gap */
    while (Math.abs(value - reference) > 4294967296) {
      value += offset;
    }

    return value;
  }
}

export default MP4Remuxer;
