'use strict';

function isAbsoluteUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function rewriteManifestUris(manifestText, publicOriginUrl) {
  if (!publicOriginUrl) {
    return manifestText;
  }

  const baseUrl = publicOriginUrl.endsWith('/') ? publicOriginUrl : `${publicOriginUrl}/`;

  return manifestText
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return line;
      }

      // Rewrite tag attribute URIs, e.g. #EXT-X-MEDIA:...URI="index_2.m3u8".
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uriValue) => {
          if (isAbsoluteUrl(uriValue)) {
            return `URI="${uriValue}"`;
          }
          return `URI="${new URL(uriValue, baseUrl).toString()}"`;
        });
      }

      if (isAbsoluteUrl(trimmed)) {
        return line;
      }

      return new URL(trimmed, baseUrl).toString();
    })
    .join('\n');
}

function detectUpstreamAudioGroupId(manifestText) {
  const match = manifestText.match(/^#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*GROUP-ID="([^"]+)"/m)
    || manifestText.match(/^#EXT-X-STREAM-INF:[^\n]*AUDIO="([^"]+)"/m);
  return match ? match[1] : null;
}

function patchMasterManifest({ upstreamText, subtitleLines, audioLines = [], publicOriginUrl }) {
  let patched = rewriteManifestUris(upstreamText, publicOriginUrl);

  // If upstream already exposes an audio group, reuse its GROUP-ID so injected
  // dub renditions become alternates of the original audio rather than
  // hijacking or orphaning the audio mapping. Players (THEOplayer, Safari,
  // Shaka) require every STREAM-INF AUDIO= to resolve to a declared group.
  const upstreamAudioGroupId = detectUpstreamAudioGroupId(upstreamText);
  let injectedAudioLines = audioLines;

  if (audioLines.length > 0 && upstreamAudioGroupId) {
    injectedAudioLines = audioLines.map((line) =>
      line.replace(/GROUP-ID="[^"]+"/, `GROUP-ID="${upstreamAudioGroupId}"`)
    );
  } else if (audioLines.length > 0 && !upstreamAudioGroupId) {
    // Only add AUDIO= to STREAM-INF lines that don't already declare one.
    patched = patched.replace(/^#EXT-X-STREAM-INF:(.+)$/gm, (_line, attrs) => {
      if (/\bAUDIO=/.test(attrs)) return `#EXT-X-STREAM-INF:${attrs}`;
      return `#EXT-X-STREAM-INF:${attrs},AUDIO="dub-audio"`;
    });
  }

  if (subtitleLines.length > 0) {
    patched = patched
      .replace(/^#EXT-X-STREAM-INF:(.+)$/gm, '#EXT-X-STREAM-INF:$1,SUBTITLES="subs"')
      .replace(/^(#EXTM3U\s*)/, `$1${subtitleLines.join('\n')}\n`);
  }

  if (injectedAudioLines.length > 0) {
    patched = patched.replace(/^(#EXTM3U\s*)/, `$1${injectedAudioLines.join('\n')}\n`);
  }

  return patched;
}

module.exports = {
  patchMasterManifest,
  rewriteManifestUris
};