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

      if (!trimmed || trimmed.startsWith('#') || isAbsoluteUrl(trimmed)) {
        return line;
      }

      return new URL(trimmed, baseUrl).toString();
    })
    .join('\n');
}

function patchMasterManifest({ upstreamText, subtitleLines, publicOriginUrl }) {
  let patched = rewriteManifestUris(upstreamText, publicOriginUrl);

  if (subtitleLines.length > 0) {
    patched = patched
      .replace(/^#EXT-X-STREAM-INF:(.+)$/gm, '#EXT-X-STREAM-INF:$1,SUBTITLES="subs"')
      .replace(/^(#EXTM3U\s*)/, `$1${subtitleLines.join('\n')}\n`);
  }

  return patched;
}

module.exports = {
  patchMasterManifest,
  rewriteManifestUris
};