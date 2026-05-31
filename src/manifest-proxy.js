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

function patchMasterManifest({ upstreamText, subtitleLines, audioLines = [], publicOriginUrl }) {
  let patched = rewriteManifestUris(upstreamText, publicOriginUrl);
  const hasAudioGroup = audioLines.length > 0;

  if (hasAudioGroup) {
    patched = patched.replace(/^#EXT-X-STREAM-INF:(.+)$/gm, (_line, attrs) => {
      if (/\bAUDIO=/.test(attrs)) {
        return `#EXT-X-STREAM-INF:${attrs.replace(/\bAUDIO="[^"]*"/, 'AUDIO="dub-audio"')}`;
      }

      return `#EXT-X-STREAM-INF:${attrs},AUDIO="dub-audio"`;
    });
  }

  if (subtitleLines.length > 0) {
    patched = patched
      .replace(/^#EXT-X-STREAM-INF:(.+)$/gm, '#EXT-X-STREAM-INF:$1,SUBTITLES="subs"')
      .replace(/^(#EXTM3U\s*)/, `$1${subtitleLines.join('\n')}\n`);
  }

  if (hasAudioGroup) {
    patched = patched.replace(/^(#EXTM3U\s*)/, `$1${audioLines.join('\n')}\n`);
  }

  return patched;
}

module.exports = {
  patchMasterManifest,
  rewriteManifestUris
};