'use strict';

const { patchMasterManifest } = require('../src/manifest-proxy');

describe('patchMasterManifest', () => {
  test('rewrites relative playlist URIs to public origin URL and injects subtitles', () => {
    const upstreamText = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=6938624,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
      'vs0/stream.m3u8'
    ].join('\n');

    const patched = patchMasterManifest({
      upstreamText,
      subtitleLines: [
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="src",NAME="Source",DEFAULT=YES,AUTOSELECT=YES,URI="http://localhost:8080/sessions/test/captions/index.m3u8"'
      ],
      publicOriginUrl: 'http://localhost:9090'
    });

    expect(patched).toContain('http://localhost:9090/vs0/stream.m3u8');
    expect(patched).toContain('SUBTITLES="subs"');
    expect(patched).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES');
  });

  test('injects dubbed audio renditions and AUDIO stream mapping', () => {
    const upstreamText = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=6938624,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
      'vs0/stream.m3u8'
    ].join('\n');

    const patched = patchMasterManifest({
      upstreamText,
      subtitleLines: [],
      audioLines: [
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="dub-audio",LANGUAGE="en",NAME="Dub en",DEFAULT=NO,AUTOSELECT=YES,URI="http://localhost:8080/sessions/live-primary/dub/en/audio.m3u8"'
      ],
      publicOriginUrl: 'http://localhost:9090'
    });

    expect(patched).toContain('#EXT-X-MEDIA:TYPE=AUDIO');
    expect(patched).toContain('AUDIO="dub-audio"');
    expect(patched).toContain('http://localhost:9090/vs0/stream.m3u8');
  });
});