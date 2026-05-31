const MediaPackageIngestPusher = require('./src/dubbing/mediapackage-ingest-pusher.js');
const pusher = new MediaPackageIngestPusher({
  ingestBaseUrl: 'https://w60mav-1.ingest.wc47m1.mediapackagev2.eu-central-1.amazonaws.com/in/v1/live-caption-output/1/main/index',
  logger: require('pino')()
});
pusher.put('', '', '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=4000\nindex_1.m3u8', 'application/vnd.apple.mpegurl')
  .then(() => console.log('OK'))
  .catch(err => console.error('ERROR:', err.message));
